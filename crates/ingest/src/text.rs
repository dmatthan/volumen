//! Plain text: paragraphs are separated by blank lines; chapter headings are short
//! lines like "CHAPTER IV" or all-capital titles. Gutenberg's licence is cut off.

use crate::heads;
use crate::{Error, finish_book};
use vol_model::{Block, Kind, Meta, Section, SectionKind, TextBuilder, fnv64, style};

/// A text file's characters: UTF-8 (with or without its mark), UTF-16 with its mark, or
/// else Windows-1252 (old text files, Latin-1 among them). Nothing if it is not text: NUL
/// bytes, or more than one character in a hundred a control character.
pub(crate) fn decode(bytes: &[u8]) -> Option<String> {
    let s = if let Some(b) = bytes.strip_prefix(b"\xff\xfe").or_else(|| bytes.strip_prefix(b"\xfe\xff")) {
        let le = bytes[0] == 0xff;
        let u: Vec<u16> = b.as_chunks::<2>().0.iter().map(|c| if le { u16::from_le_bytes([c[0], c[1]]) } else { u16::from_be_bytes([c[0], c[1]]) }).collect();
        String::from_utf16_lossy(&u)
    } else {
        let b = bytes.strip_prefix(b"\xef\xbb\xbf").unwrap_or(bytes);
        match std::str::from_utf8(b) {
            Ok(s) => s.to_string(),
            Err(_) if b.contains(&0) => return None,
            Err(_) => b.iter().map(|&c| cp1252(c)).collect(),
        }
    };
    let control = s.chars().filter(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t' | '\x0c')).count();
    (control * 100 <= s.chars().count()).then_some(s)
}

fn cp1252(c: u8) -> char {
    const HIGH: [char; 32] = [
        '€', '\u{81}', '‚', 'ƒ', '„', '…', '†', '‡', 'ˆ', '‰', 'Š', '‹', 'Œ', '\u{8d}', 'Ž', '\u{8f}', '\u{90}', '‘', '’', '“', '”', '•', '–', '—', '˜', '™', 'š', '›', 'œ', '\u{9d}', 'ž', 'Ÿ',
    ];
    if (0x80..0xa0).contains(&c) { HIGH[c as usize - 0x80] } else { c as char }
}

pub fn parse(bytes: &[u8], name: &str) -> Result<crate::Book, Error> {
    let raw = decode(bytes).ok_or(Error::Unreadable("it is not a book or a text Volumen can read (EPUB, Word, Markdown or plain text)"))?;
    let raw = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut meta = Meta { lang: "en".into(), ..Meta::default() };
    for l in raw.lines().take(80) {
        if let Some(t) = l.strip_prefix("Title:") {
            meta.title = t.trim().to_string();
        } else if let Some(a) = l.strip_prefix("Author:") {
            meta.author = a.trim().to_string();
        }
    }
    let mut text: &str = &raw;
    if let Some(s) = find_marker(text, "*** START OF") {
        text = &text[s..];
        text = text.split_once('\n').map(|x| x.1).unwrap_or("");
    }
    if let Some(e) = find_marker(text, "*** END OF") {
        text = &text[..e];
    }
    if meta.title.is_empty() {
        let stem = name.rsplit('/').next().unwrap_or(name);
        let stem = stem.trim_end_matches(".txt").trim_end_matches(".text");
        meta.title = stem.replace(['_', '-'], " ");
    }

    let lines: Vec<&str> = text.lines().collect();
    let blank = lines.iter().filter(|l| l.trim().is_empty()).count() as f32 / lines.len().max(1) as f32;
    let mut paras: Vec<String> = Vec::new();
    if blank < 0.04 {
        paras = lines.iter().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    } else {
        let mut cur: Vec<&str> = Vec::new();
        for l in lines.iter().chain(std::iter::once(&"")) {
            if l.trim().is_empty() {
                if !cur.is_empty() {
                    paras.push(cur.iter().map(|x| x.trim()).collect::<Vec<_>>().join(" "));
                    cur.clear();
                }
            } else {
                cur.push(l);
            }
        }
    }

    // a bare "Title: … Author: …" header is metadata, not text
    paras.retain(|p| !(p.starts_with("Title:") || p.starts_with("Author:")));
    let is_head = |p: &str| {
        p.len() < 70 && {
            let h = heads::parse(p);
            !h.label.is_empty()
                || (!h.num.is_empty() && h.title.is_empty())
                || (p.chars().any(|c| c.is_uppercase()) && !p.chars().any(|c| c.is_lowercase()) && p.chars().filter(|c| c.is_uppercase()).count() >= 3)
        }
    };
    let file = fnv64(name.as_bytes());
    let mut ord = 0u64;
    let mut block = |kind: Kind, s: &str| {
        ord += 1;
        let mut b = TextBuilder::new();
        push_marked(&mut b, &smart_quotes(s));
        let (t, r) = b.finish();
        Block::new(file ^ ord.wrapping_mul(0x9e3779b97f4a7c15), kind, t, r)
    };
    let mut sections: Vec<Section> = Vec::new();
    let mut i = 0;
    while i < paras.len() {
        let p = &paras[i];
        if is_head(p) {
            let mut h = heads::parse(p);
            if h.title.is_empty()
                && let Some(nx) = paras.get(i + 1)
                    && nx.len() < 80 && !nx.ends_with(['.', '!', '?', '”', '"']) && !is_head(nx) {
                        h.title = heads::tidy(&smart_quotes(nx));
                        i += 1;
                    }
            let n = sections.len() + 1;
            sections.push(Section {
                kind: SectionKind::Chapter,
                part: String::new(),
                label: h.label,
                num: if h.num.is_empty() { n.to_string() } else { h.num },
                title: h.title,
                blocks: Vec::new(),
            });
            i += 1;
            continue;
        }
        if sections.is_empty() {
            sections.push(Section { kind: SectionKind::Chapter, part: String::new(), label: String::new(), num: "1".into(), title: "Opening".into(), blocks: Vec::new() });
        }
        let kind = if p.trim().chars().all(|c| c == '*' || c.is_whitespace()) { Kind::Break } else { Kind::P };
        let b = if kind == Kind::Break { Block::new(0, Kind::Break, String::new(), vec![]) } else { block(Kind::P, p) };
        sections.last_mut().unwrap().blocks.push(b);
        i += 1;
    }
    sections.retain(|s| !s.blocks.is_empty());
    // one long unbroken text: cut it into parts of about 2,600 words
    if sections.len() < 2 && paras.len() > 60 {
        let all: Vec<Block> = sections.drain(..).flat_map(|s| s.blocks).collect();
        sections = crate::parts(all, true);
    }
    if sections.is_empty() {
        return Err(Error::Empty);
    }
    for s in &mut sections {
        if let Some(b) = s.blocks.iter_mut().find(|b| b.kind == Kind::P) {
            vol_model::apply_lead_in(b);
        }
    }
    Ok(finish_book(bytes, meta, sections))
}

fn find_marker(t: &str, m: &str) -> Option<usize> {
    let alt = m.replace("*** ", "***");
    t.find(m).or_else(|| t.find(&alt)).filter(|&i| t[i..].lines().next().is_some_and(|l| l.contains("PROJECT GUTENBERG")))
}

/// _underscored_ text is italic.
fn push_marked(b: &mut TextBuilder, s: &str) {
    let mut italic = false;
    for (i, part) in s.split('_').enumerate() {
        if i > 0 {
            italic = !italic;
        }
        b.push(part, if italic { style::ITALIC } else { 0 });
    }
}

pub fn smart_quotes(s: &str) -> String {
    let s = s.replace("--", "—");
    let cs: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len() + 8);
    for (i, &c) in cs.iter().enumerate() {
        let prev = if i > 0 { cs[i - 1] } else { ' ' };
        let open = prev.is_whitespace() || matches!(prev, '(' | '[' | '{' | '—' | '“' | '‘');
        match c {
            '"' => out.push(if open { '“' } else { '”' }),
            '\'' => out.push(if open && !prev.is_alphanumeric() && prev != '“' || prev == '“' { '‘' } else { '’' }),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes() {
        assert_eq!(smart_quotes(r#"He said "it's 'fine' -- really""#), "He said “it’s ‘fine’ — really”");
    }

    #[test]
    fn chapters_from_text() {
        let t = "Title: A Small Test\nAuthor: Nobody\n\nCHAPTER I\n\nThe First\n\nIt was a _quiet_ day.\n\nAnother.\n\nCHAPTER II\n\nThe Second\n\nMore words here.";
        let b = parse(t.as_bytes(), "x.txt").unwrap();
        assert_eq!(b.meta.title, "A Small Test");
        assert_eq!(b.sections.len(), 2);
        assert_eq!(b.sections[0].title, "The First");
        assert_eq!(b.sections[0].label, "Chapter I");
        assert_eq!(b.sections[0].blocks[0].runs.iter().map(|r| r.style).collect::<Vec<_>>(), vec![style::SMALLCAPS, style::ITALIC]);
    }
}
