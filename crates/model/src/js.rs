//! The shape the frontend receives: compact JSON with UTF-16 offsets.

use crate::{Book, SectionKind};
use serde::Serialize;

#[derive(Serialize)]
pub struct JsBook<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub subtitle: &'a str,
    pub author: &'a str,
    pub year: &'a str,
    pub lang: &'a str,
    pub words: usize,
    pub sections: Vec<JsSection<'a>>,
    pub notes: Vec<JsNote<'a>>,
    /// Width, height (CSS px) and description of each image.
    /// Width, height (0 for a rich block not yet measured), description, type.
    pub images: Vec<(u32, u32, &'a str, &'a str)>,
    /// Its characters beyond the bundled fonts' core files, each once (set by the engine;
    /// empty for most books): the page loads the extension faces that have them.
    pub ext: String,
}

#[derive(Serialize)]
pub struct JsNote<'a> {
    pub label: &'a str,
    pub t: &'a str,
    pub r: Vec<u32>,
    /// Key of the block where the note is printed, if it is.
    pub at: Option<String>,
}

#[derive(Serialize)]
pub struct JsSection<'a> {
    /// 0 front matter, 1 chapter
    pub k: u8,
    pub part: &'a str,
    pub label: &'a str,
    pub num: &'a str,
    pub title: &'a str,
    pub blocks: Vec<JsBlock<'a>>,
}

#[derive(Serialize)]
pub struct JsBlock<'a> {
    pub k: u8,
    /// Stable key as hex: annotations anchor to it.
    pub key: String,
    pub t: &'a str,
    /// Flattened runs: start, end, style, … in UTF-16 units.
    pub r: Vec<u32>,
    /// Links: start, end (UTF-16) and where to: `n:12` a note, `b:<key>` a block,
    /// `u:<url>` the web.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub l: Vec<(u32, u32, String)>,
    /// For an image block: the image's index.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub img: Option<u32>,
    /// For a table: its shape.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tb: Option<&'a crate::TableShape>,
}

/// UTF-16 length of `s`.
pub fn u16_len(s: &str) -> u32 {
    s.chars().map(|c| c.len_utf16() as u32).sum()
}

/// Maps byte offsets to UTF-16 offsets for one string. `at(b)` must be called with
/// non-decreasing `b` for O(n) total work.
pub struct U16Cursor<'a> {
    s: &'a str,
    byte: usize,
    u16: u32,
}

impl<'a> U16Cursor<'a> {
    pub fn new(s: &'a str) -> Self {
        U16Cursor { s, byte: 0, u16: 0 }
    }
    pub fn at(&mut self, b: usize) -> u32 {
        if b < self.byte {
            self.byte = 0;
            self.u16 = 0;
        }
        if self.s.is_ascii() {
            return b as u32;
        }
        self.u16 += u16_len(&self.s[self.byte..b]);
        self.byte = b;
        self.u16
    }
}

pub fn to_js(book: &Book) -> JsBook<'_> {
    JsBook {
        id: &book.id,
        title: &book.meta.title,
        subtitle: &book.meta.subtitle,
        author: &book.meta.author,
        year: &book.meta.year,
        lang: &book.meta.lang,
        words: book.words(),
        sections: book
            .sections
            .iter()
            .map(|s| JsSection {
                k: if s.kind == SectionKind::Front { 0 } else { 1 },
                part: &s.part,
                label: &s.label,
                num: &s.num,
                title: &s.title,
                blocks: s
                    .blocks
                    .iter()
                    .map(|b| {
                        let mut cur = U16Cursor::new(&b.text);
                        let mut r = Vec::with_capacity(b.runs.len() * 3);
                        for run in &b.runs {
                            r.push(cur.at(run.start as usize));
                            r.push(cur.at(run.end as usize));
                            r.push(run.style as u32);
                        }
                        let l = b
                            .links
                            .iter()
                            .map(|l| {
                                let to = match &l.to {
                                    crate::Target::Note(i) => format!("n:{i}"),
                                    crate::Target::Block(k) => format!("b:{k:016x}"),
                                    crate::Target::Url(u) => format!("u:{u}"),
                                };
                                (cur.at(l.start as usize), cur.at(l.end as usize), to)
                            })
                            .collect();
                        JsBlock { k: b.kind as u8, key: format!("{:016x}", b.key), t: &b.text, r, l, img: b.image, tb: b.table.as_ref() }
                    })
                    .collect(),
            })
            .collect(),
        notes: book
            .notes
            .iter()
            .map(|n| {
                let mut cur = U16Cursor::new(&n.text);
                let mut r = Vec::with_capacity(n.runs.len() * 3);
                for run in &n.runs {
                    r.push(cur.at(run.start as usize));
                    r.push(cur.at(run.end as usize));
                    r.push(run.style as u32);
                }
                JsNote { label: &n.label, t: &n.text, r, at: n.at.map(|k| format!("{k:016x}")) }
            })
            .collect(),
        images: book.images.iter().map(|i| (i.w, i.h, i.alt.as_str(), i.mime.as_str())).collect(),
        ext: String::new(),
    }
}
