//! Search across the library. Matching is find's (`find.rs`): folded text, a phrase at word
//! starts, else paragraphs with every word. The desktop narrows the paragraphs to look in
//! with SQLite FTS5 over the same folded text (`fts_rows`, `fts_queries`); the web build
//! looks in every paragraph of every book. Both end here, so they find the same things.

use crate::find::{fold_block, fold_str, phrase_in, words_in};
use serde::Serialize;
use vol_model::Book;

/// One match, with the words around it.
#[derive(Serialize, Clone, Debug)]
pub struct LibHit {
    pub sec: u32,
    pub block: u32,
    /// The block's stable key, as the reader's anchors name it (hex).
    pub key: String,
    /// UTF-16 range in the block, as the reader's anchors count.
    pub s: u32,
    pub e: u32,
    /// The chapter it is in.
    pub chapter: String,
    pub before: String,
    pub matched: String,
    pub after: String,
}

/// A book's matches: how many in all, and the first few.
#[derive(Serialize, Clone, Debug)]
pub struct BookHits {
    pub id: String,
    pub total: u32,
    /// The phrase was found (else these are paragraphs with every word).
    pub phrase: bool,
    pub hits: Vec<LibHit>,
}

/// Each paragraph's folded text, for the full-text index: (section, block, text).
pub fn fts_rows(book: &Book) -> impl Iterator<Item = (u32, u32, String)> + '_ {
    book.sections.iter().enumerate().flat_map(|(si, sec)| {
        sec.blocks.iter().enumerate().filter(|(_, b)| !b.text.is_empty()).map(move |(bi, b)| (si as u32, bi as u32, fold_str(&b.text)))
    })
}

/// FTS5 expressions over folded text for a query: the phrase (its last word may be the
/// start of a longer one, as find allows), and every word anywhere in a paragraph. None
/// for a query with no words (punctuation alone): such a query finds nothing here.
pub fn fts_queries(query: &str) -> Option<(String, String)> {
    let q = fold_str(query.trim());
    // FTS5's tokenizer splits at anything not a letter or digit; the exact pass afterwards
    // restores what the split loses ("don't" is "don" "t" here)
    let tokens: Vec<&str> = q.split(|c: char| !c.is_alphanumeric()).filter(|t| !t.is_empty()).collect();
    if tokens.is_empty() {
        return None;
    }
    let phrase = format!("\"{}\" *", tokens.join(" "));
    let words = tokens.iter().map(|t| format!("\"{t}\" *")).collect::<Vec<_>>().join(" AND ");
    Some((phrase, words))
}

/// The chapter as the reader names it (render.ts `chapTitle`).
fn chapter(book: &Book, sec: usize) -> String {
    let s = &book.sections[sec];
    if !s.label.is_empty() && !s.title.is_empty() {
        format!("{} · {}", s.label, s.title)
    } else if !s.label.is_empty() {
        s.label.clone()
    } else if !s.title.is_empty() {
        s.title.clone()
    } else {
        format!("Chapter {}", s.num)
    }
}

/// UTF-16 offset to a byte offset in `t`.
fn byte_at(t: &str, u: u32) -> usize {
    let mut n = 0u32;
    for (i, c) in t.char_indices() {
        if n >= u {
            return i;
        }
        n += c.len_utf16() as u32;
    }
    t.len()
}

fn snippet(book: &Book, sec: u32, block: u32, s: u32, e: u32) -> LibHit {
    let t = &book.sections[sec as usize].blocks[block as usize].text;
    let (bs, be) = (byte_at(t, s), byte_at(t, e));
    // some words either side: back to a word's start, on to a word's end
    let mut a = bs;
    for (n, (i, _)) in t[..bs].char_indices().rev().enumerate() {
        a = i;
        if n >= 48 {
            break;
        }
    }
    if a > 0 {
        a = t[a..bs].find(' ').map(|i| a + i + 1).unwrap_or(a);
    }
    let mut z = be;
    for (n, (i, c)) in t[be..].char_indices().enumerate() {
        z = be + i + c.len_utf8();
        if n >= 90 {
            break;
        }
    }
    if z < t.len() {
        z = t[be..z].rfind(' ').map(|i| be + i).unwrap_or(z);
    }
    let flat = |x: &str| x.replace('\n', " / ");
    LibHit {
        sec,
        block,
        key: format!("{:016x}", book.sections[sec as usize].blocks[block as usize].key),
        s,
        e,
        chapter: chapter(book, sec as usize),
        before: format!("{}{}", if a > 0 { "…" } else { "" }, flat(&t[a..bs])),
        matched: flat(&t[bs..be]),
        after: format!("{}{}", flat(&t[be..z]), if z < t.len() { "…" } else { "" }),
    }
}

/// A book's matches in the given paragraphs (all of them when `blocks` is None), keeping
/// the first `keep` with their context. Phrase first; if the phrase is nowhere, the
/// paragraphs with every word.
pub fn in_book(book: &Book, blocks: Option<&[(u32, u32)]>, query: &str, keep: usize) -> Option<BookHits> {
    let q = fold_str(query.trim());
    if q.is_empty() {
        return None;
    }
    let all: Vec<(u32, u32)>;
    let list = match blocks {
        Some(b) => b,
        None => {
            all = book.sections.iter().enumerate().flat_map(|(si, s)| (0..s.blocks.len()).map(move |bi| (si as u32, bi as u32))).collect();
            &all
        }
    };
    let folded: Vec<(u32, u32, String, Vec<u32>)> = list
        .iter()
        .filter_map(|&(sec, blk)| {
            let b = book.sections.get(sec as usize)?.blocks.get(blk as usize)?;
            if b.text.is_empty() {
                return None;
            }
            let (t, m) = fold_block(&b.text);
            Some((sec, blk, t, m))
        })
        .collect();
    let mut out = BookHits { id: book.id.clone(), total: 0, phrase: true, hits: Vec::new() };
    for (sec, blk, t, m) in &folded {
        for (s, e) in phrase_in(t, m, &q) {
            out.total += 1;
            if out.hits.len() < keep {
                out.hits.push(snippet(book, *sec, *blk, s, e));
            }
        }
    }
    let words: Vec<&str> = q.split(' ').filter(|w| !w.is_empty()).collect();
    if out.total == 0 && words.len() > 1 {
        out.phrase = false;
        for (sec, blk, t, m) in &folded {
            let found = words_in(t, m, &words);
            if found.is_empty() {
                continue;
            }
            out.total += 1;
            if out.hits.len() < keep {
                // the paragraph, shown at its first word found
                let (s, e) = found.iter().copied().min().unwrap();
                out.hits.push(snippet(book, *sec, *blk, s, e));
            }
        }
    }
    (out.total > 0).then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book() -> Book {
        let mk = |k: u64, t: &str| vol_model::Block::new(k, vol_model::Kind::P, t.to_string(), vec![]);
        let sec = |label: &str, blocks| vol_model::Section { kind: vol_model::SectionKind::Chapter, part: String::new(), label: label.into(), num: "1".into(), title: String::new(), blocks };
        Book {
            id: "b".into(),
            meta: Default::default(),
            sections: vec![
                sec("Chapter I", vec![mk(1, "The anarchist poet said nothing at all, and the night went on without him."), mk(2, "A naïve poet; “Don’t,” said he.")]),
                sec("Chapter II", vec![mk(3, "Poets and anarchists, he said, are one.")]),
            ],
            notes: vec![],
            images: vec![],
            cover: None,
        }
    }

    #[test]
    fn phrase_then_every_word_with_context() {
        let b = book();
        let h = in_book(&b, None, "anarchist poet", 5).unwrap();
        assert!(h.phrase && h.total == 1);
        assert_eq!(h.hits[0].matched, "anarchist poet");
        assert_eq!(h.hits[0].chapter, "Chapter I");
        assert!(h.hits[0].before.ends_with("The ") && h.hits[0].after.starts_with(" said"));
        // no phrase: the paragraphs with both words, prefix as find allows
        let h = in_book(&b, None, "poet anarch", 5).unwrap();
        assert!(!h.phrase && h.total == 2);
        // folding: "naive", and "don't" finds "Don’t"
        assert_eq!(in_book(&b, None, "naive", 5).unwrap().hits[0].matched, "naïve");
        assert_eq!(in_book(&b, None, "don't", 5).unwrap().hits[0].matched, "Don’t");
        // only the paragraphs asked about
        assert!(in_book(&b, Some(&[(0, 1)]), "anarchist poet", 5).is_none());
        assert_eq!(in_book(&b, Some(&[(1, 0)]), "anarchist poet", 5).unwrap().total, 1);
    }

    #[test]
    fn fts_expressions() {
        assert_eq!(fts_queries("Anarchist  po").unwrap(), ("\"anarchist po\" *".to_string(), "\"anarchist\" * AND \"po\" *".to_string()));
        assert_eq!(fts_queries("Don’t").unwrap().0, "\"don t\" *");
        assert!(fts_queries("— …").is_none());
    }
}
