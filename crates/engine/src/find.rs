//! Find in book. The text is folded once per book (case, diacritics, quote and dash
//! forms, ligatures, soft hyphens, runs of space), keeping a map back to the original
//! UTF-16 offsets the reader uses. A query is folded the same way, so "naive" finds
//! "naïve", "dont" does not find "don't" but "don't" finds "don’t", and so on.

use unicode_normalization::char::decompose_compatible;
use vol_model::Book;

struct FoldedBlock {
    sec: u32,
    block: u32,
    text: String,
    /// For each byte of `text`, the UTF-16 offset in the block of the character it came
    /// from; one more entry for the end.
    map: Vec<u32>,
}

pub struct Index {
    blocks: Vec<FoldedBlock>,
}

/// One match: a UTF-16 range in a block.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Hit {
    pub sec: u32,
    pub block: u32,
    pub s: u32,
    pub e: u32,
    /// Not the phrase: one of the query's words, in a paragraph that has them all.
    pub near: bool,
}

pub struct Found {
    pub hits: Vec<Hit>,
    /// Matches in the whole book (hits may be cut at the limit).
    pub total: u32,
    /// The query's phrase was found (else the hits are paragraphs with all its words).
    pub phrase: bool,
}

/// Folds one character into `out`, calling `mark` once per byte written.
fn fold(c: char, out: &mut String) {
    match c {
        '\u{ad}' | '\u{200b}' | '\u{200c}' | '\u{200d}' | '\u{2060}' | '\u{feff}' => {}
        '‘' | '’' | '‚' | '‛' | '′' | 'ʼ' => out.push('\''),
        '“' | '”' | '„' | '‟' | '″' | '«' | '»' => out.push('"'),
        '‐' | '‑' | '‒' | '–' | '—' | '―' | '−' => out.push('-'),
        'ſ' => out.push('s'),
        'æ' | 'Æ' => out.push_str("ae"),
        'œ' | 'Œ' => out.push_str("oe"),
        'ß' => out.push_str("ss"),
        'ø' | 'Ø' => out.push('o'),
        'đ' | 'Đ' => out.push('d'),
        'ł' | 'Ł' => out.push('l'),
        c if c.is_whitespace() => {
            if !out.ends_with(' ') && !out.is_empty() {
                out.push(' ')
            }
        }
        c => decompose_compatible(c, |d| {
            // drop the marks a decomposition leaves (accents, cedillas, …)
            if !matches!(d, '\u{300}'..='\u{36f}' | '\u{1ab0}'..='\u{1aff}' | '\u{1dc0}'..='\u{1dff}' | '\u{20d0}'..='\u{20ff}' | '\u{fe20}'..='\u{fe2f}') {
                for l in d.to_lowercase() {
                    out.push(l);
                }
            }
        }),
    }
}

pub fn fold_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        fold(c, &mut out);
    }
    out.trim_end().to_string()
}

/// A block's text folded, with the map from each folded byte back to UTF-16 offsets.
pub(crate) fn fold_block(text: &str) -> (String, Vec<u32>) {
    let mut out = String::with_capacity(text.len());
    let mut map = Vec::with_capacity(text.len() + 1);
    let mut u = 0u32;
    for c in text.chars() {
        let before = out.len();
        fold(c, &mut out);
        map.resize(map.len() + (out.len() - before), u);
        u += c.len_utf16() as u32;
    }
    map.push(u);
    (out, map)
}

/// The phrase's matches in one folded block, as UTF-16 ranges.
pub(crate) fn phrase_in<'a>(text: &'a str, map: &'a [u32], q: &'a str) -> impl Iterator<Item = (u32, u32)> + 'a {
    word_starts(text, q).map(move |(i, _)| (map[i], map[i + q.len()]))
}

/// Every word's matches in one folded block, if it has them all (else none).
pub(crate) fn words_in(text: &str, map: &[u32], words: &[&str]) -> Vec<(u32, u32)> {
    let found: Vec<Vec<usize>> = words.iter().map(|w| word_starts(text, w).map(|(i, _)| i).collect()).collect();
    if found.iter().any(|f| f.is_empty()) {
        return Vec::new();
    }
    words.iter().zip(&found).flat_map(|(w, starts)| starts.iter().map(move |&i| (map[i], map[i + w.len()]))).collect()
}

impl Index {
    pub fn build(book: &Book) -> Index {
        let mut blocks = Vec::new();
        for (si, sec) in book.sections.iter().enumerate() {
            for (bi, b) in sec.blocks.iter().enumerate() {
                if b.text.is_empty() {
                    continue;
                }
                let (text, map) = fold_block(&b.text);
                blocks.push(FoldedBlock { sec: si as u32, block: bi as u32, text, map });
            }
        }
        Index { blocks }
    }

    pub fn find(&self, query: &str, limit: usize) -> Found {
        let q = fold_str(query.trim());
        let mut out = Found { hits: Vec::new(), total: 0, phrase: true };
        if q.is_empty() {
            return out;
        }
        for fb in &self.blocks {
            for (s, e) in phrase_in(&fb.text, &fb.map, &q) {
                out.total += 1;
                if out.hits.len() < limit {
                    out.hits.push(Hit { sec: fb.sec, block: fb.block, s, e, near: false });
                }
            }
        }
        let words: Vec<&str> = q.split(' ').filter(|w| !w.is_empty()).collect();
        if out.total > 0 || words.len() < 2 {
            return out;
        }
        // no phrase: the paragraphs that have every word
        out.phrase = false;
        for fb in &self.blocks {
            let found = words_in(&fb.text, &fb.map, &words);
            if found.is_empty() {
                continue;
            }
            out.total += 1;
            for (s, e) in found {
                if out.hits.len() < limit {
                    out.hits.push(Hit { sec: fb.sec, block: fb.block, s, e, near: true });
                }
            }
        }
        out
    }
}

/// Occurrences of `q` in `t` that begin a word (they may end inside one: "pain" finds
/// "painful", not "Spain").
fn word_starts<'a>(t: &'a str, q: &'a str) -> impl Iterator<Item = (usize, &'a str)> + 'a {
    let first_alnum = q.chars().next().is_some_and(|c| c.is_alphanumeric());
    t.match_indices(q).filter(move |&(i, _)| !first_alnum || !t[..i].chars().next_back().is_some_and(|c| c.is_alphanumeric()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folding() {
        assert_eq!(fold_str("Naïve CAFÉ — “don’t” ﬁne Straße ſo"), "naive cafe - \"don't\" fine strasse so");
    }

    #[test]
    fn finds_at_word_starts_and_maps_back() {
        let text = "In Spain the pain was naïve; “Pain,” he said.".to_string();
        let block = vol_model::Block::new(1, vol_model::Kind::P, text, vec![]);
        let sec = vol_model::Section { kind: vol_model::SectionKind::Chapter, part: String::new(), label: String::new(), num: "1".into(), title: String::new(), blocks: vec![block] };
        let book = Book { id: "t".into(), meta: Default::default(), sections: vec![sec], notes: vec![], images: vec![], cover: None };
        let ix = Index::build(&book);
        let f = ix.find("pain", 10);
        assert_eq!(f.total, 2);
        let t: Vec<u16> = book.sections[0].blocks[0].text.encode_utf16().collect();
        let s = |h: &Hit| String::from_utf16(&t[h.s as usize..h.e as usize]).unwrap();
        assert_eq!(s(&f.hits[0]), "pain");
        assert_eq!(s(&f.hits[1]), "Pain");
        assert_eq!(s(&ix.find("naive", 10).hits[0]), "naïve");
        assert_eq!(s(&ix.find("\"pain,\" he", 10).hits[0]), "“Pain,” he");
        // no phrase: paragraphs with every word
        let near = ix.find("said spain", 10);
        assert!(!near.phrase && near.total == 1 && near.hits.len() == 2);
    }
}
