//! The book model: what ingest produces, press lays out and the reader renders.
//!
//! Text is plain UTF-8 per block; inline styling is a list of runs over byte ranges.
//! Everything the frontend receives is converted to UTF-16 offsets at the boundary
//! (`js` module), because that is how JavaScript indexes strings.

use serde::{Deserialize, Serialize};

pub mod js;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Book {
    /// Content hash of the source file, hex. Stable across re-imports of the same file.
    pub id: String,
    pub meta: Meta,
    pub sections: Vec<Section>,
    /// Footnotes and endnotes, by index (`Target::Note`).
    pub notes: Vec<Note>,
    /// Images' sizes and descriptions, by index (`Block::image`); their bytes are stored
    /// apart from the model.
    pub images: Vec<Image>,
    /// The cover image as found at import; stored apart from the model, never serialised.
    #[serde(skip)]
    pub cover: Option<Cover>,
}

/// A note a marker in the text refers to.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Note {
    /// The marker as printed ("12", "*").
    pub label: String,
    pub text: String,
    pub runs: Vec<Run>,
    /// The block where the note itself is printed in the book, if it is (endnotes).
    pub at: Option<u64>,
}

/// An image's type when it is a rich block: XHTML drawn by the reader (ingest's rich.rs).
pub const RICH: &str = "application/xhtml+xml";

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Image {
    pub mime: String,
    /// Pixel size, and the size it is meant to be shown at in CSS px (smaller for images
    /// made for high-density screens).
    pub w: u32,
    pub h: u32,
    pub alt: String,
    /// Never serialised: stored apart (see `Book::images`).
    #[serde(skip)]
    pub bytes: Vec<u8>,
}

/// Where a link goes.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum Target {
    Note(u32),
    /// Another place in the book: the block with this key.
    Block(u64),
    Url(String),
}

/// A link over a byte range of a block's text.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Link {
    pub start: u32,
    pub end: u32,
    pub to: Target,
}

/// Saved books start with this tag and a format number; the first format had neither.
/// 2 added notes, links and images; 3 tables.
pub const SAVE_MAGIC: &[u8; 4] = b"VOL\x03";
const SAVE_MAGIC_V2: &[u8; 4] = b"VOL\x02";

/// `[start, end)` moved onto `text`'s characters: inside it, on character boundaries
/// (outward), or `None` if nothing is left.
fn on_chars(text: &str, start: u32, end: u32) -> Option<(u32, u32)> {
    let mut a = (start as usize).min(text.len());
    let mut z = (end as usize).min(text.len());
    while !text.is_char_boundary(a) {
        a -= 1;
    }
    while !text.is_char_boundary(z) {
        z += 1;
    }
    (a < z).then_some((a as u32, z as u32))
}

impl Book {
    /// Puts every style run and link back onto its block's characters. Importers keep
    /// them there; this makes a mistake in one a matter of a misplaced italic, not of a
    /// slice through the middle of a character (a crash, and on the web a dead engine).
    /// Returns how many had to be moved or dropped.
    pub fn repair(&mut self) -> usize {
        let mut fixed = 0;
        let mut fix = |text: &str, s: &mut u32, e: &mut u32| -> bool {
            match on_chars(text, *s, *e) {
                Some(r) if r == (*s, *e) => true,
                Some((a, z)) => {
                    (*s, *e) = (a, z);
                    fixed += 1;
                    true
                }
                None => {
                    fixed += 1;
                    false
                }
            }
        };
        for b in self.sections.iter_mut().flat_map(|s| s.blocks.iter_mut()) {
            let t = b.text.as_str();
            b.runs.retain_mut(|r| fix(t, &mut r.start, &mut r.end));
            b.links.retain_mut(|l| fix(t, &mut l.start, &mut l.end));
        }
        for n in &mut self.notes {
            let t = n.text.as_str();
            n.runs.retain_mut(|r| fix(t, &mut r.start, &mut r.end));
        }
        fixed
    }

    pub fn save(&self) -> Option<Vec<u8>> {
        let mut out = SAVE_MAGIC.to_vec();
        out.extend(postcard::to_allocvec(self).ok()?);
        Some(out)
    }

    /// Reads a saved book of this format or an earlier one (what an earlier format lacks,
    /// such as notes or tables, comes with a fresh import).
    pub fn restore(bytes: &[u8]) -> Result<Book, String> {
        if let Some(rest) = bytes.strip_prefix(SAVE_MAGIC) {
            return postcard::from_bytes(rest).map_err(|e| e.to_string());
        }
        if let Some(rest) = bytes.strip_prefix(SAVE_MAGIC_V2) {
            let v2: v2::Book = postcard::from_bytes(rest).map_err(|e| e.to_string())?;
            return Ok(v2.into());
        }
        let v1: v1::Book = postcard::from_bytes(bytes).map_err(|e| e.to_string())?;
        Ok(v1.into())
    }
}

/// The saved form before tables.
mod v2 {
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct Book {
        id: String,
        meta: super::Meta,
        sections: Vec<Section>,
        notes: Vec<super::Note>,
        images: Vec<super::Image>,
    }
    #[derive(Deserialize)]
    struct Section {
        kind: super::SectionKind,
        part: String,
        label: String,
        num: String,
        title: String,
        blocks: Vec<Block>,
    }
    #[derive(Deserialize)]
    struct Block {
        key: u64,
        kind: super::Kind,
        text: String,
        runs: Vec<super::Run>,
        links: Vec<super::Link>,
        image: Option<u32>,
    }
    impl From<Book> for super::Book {
        fn from(b: Book) -> Self {
            super::Book {
                id: b.id,
                meta: b.meta,
                sections: b
                    .sections
                    .into_iter()
                    .map(|s| super::Section {
                        kind: s.kind,
                        part: s.part,
                        label: s.label,
                        num: s.num,
                        title: s.title,
                        blocks: s
                            .blocks
                            .into_iter()
                            .map(|b| super::Block { links: b.links, image: b.image, ..super::Block::new(b.key, b.kind, b.text, b.runs) })
                            .collect(),
                    })
                    .collect(),
                notes: b.notes,
                images: b.images,
                cover: None,
            }
        }
    }
}

/// The saved form before notes, links and images.
mod v1 {
    use serde::Deserialize;

    #[derive(Deserialize)]
    pub struct Book {
        id: String,
        meta: super::Meta,
        sections: Vec<Section>,
    }
    #[derive(Deserialize)]
    struct Section {
        kind: super::SectionKind,
        part: String,
        label: String,
        num: String,
        title: String,
        blocks: Vec<Block>,
    }
    #[derive(Deserialize)]
    struct Block {
        key: u64,
        kind: super::Kind,
        text: String,
        runs: Vec<super::Run>,
    }
    impl From<Book> for super::Book {
        fn from(b: Book) -> Self {
            super::Book {
                id: b.id,
                meta: b.meta,
                sections: b
                    .sections
                    .into_iter()
                    .map(|s| super::Section {
                        kind: s.kind,
                        part: s.part,
                        label: s.label,
                        num: s.num,
                        title: s.title,
                        blocks: s.blocks.into_iter().map(|b| super::Block::new(b.key, b.kind, b.text, b.runs)).collect(),
                    })
                    .collect(),
                notes: vec![],
                images: vec![],
                cover: None,
            }
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Cover {
    pub mime: String,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct Meta {
    pub title: String,
    pub subtitle: String,
    pub author: String,
    pub year: String,
    /// BCP 47, e.g. "en".
    pub lang: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum SectionKind {
    /// Dedication, epigraph, preface: before the first chapter, no chapter head.
    Front,
    Chapter,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Section {
    pub kind: SectionKind,
    /// The part this section opens, e.g. "Book I · Miss Brooke"; empty for most.
    pub part: String,
    /// "Chapter IV", "Part II" or empty.
    pub label: String,
    /// Short number for lists and the map: "IV", "2".
    pub num: String,
    pub title: String,
    pub blocks: Vec<Block>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Kind {
    /// Running paragraph; indented unless it follows a heading, break or the start.
    P = 0,
    /// Subheading inside a chapter.
    H = 1,
    /// Block quotation.
    Q = 2,
    /// List item.
    Li = 3,
    /// Verse: lines separated by '\n', each broken on its own with a hanging indent.
    Verse = 4,
    /// Attribution under verse or a quote, set right in italic.
    Attrib = 5,
    /// Signature, set right in small capitals.
    Sign = 6,
    /// A centred line or paragraph (a dedication, a caption): its styles are its own.
    Center = 7,
    /// Section break (⁂). Has no text.
    Break = 8,
    /// An image (`Block::image`); its text is the image's description, not printed.
    Image = 9,
    /// A table (`Block::table`): its text is its cells, a tab between cells and a line
    /// break between rows.
    Table = 10,
    /// Preformatted text: its lines and spaces as written, set in a monospaced face.
    Pre = 11,
}

/// A table's shape; its cells are its block's text (see `Kind::Table`).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct TableShape {
    /// Columns, the widest row's count of cells by their spans.
    pub cols: u32,
    /// Rows at the head (`th` rows), repeated nowhere yet but set in bold.
    pub header_rows: u32,
    /// Each cell's column span, in reading order.
    pub spans: Vec<u8>,
}

pub mod style {
    pub const ITALIC: u8 = 1;
    pub const BOLD: u8 = 2;
    /// All small capitals (c2sc + smcp).
    pub const SMALLCAPS: u8 = 4;
    pub const SUP: u8 = 8;
    pub const SUB: u8 = 16;
}

/// A styled byte range of a block's text. Runs never overlap and are sorted.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub struct Run {
    pub start: u32,
    pub end: u32,
    pub style: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Block {
    /// Stable identity from the block's place in the source (document and ordinal).
    pub key: u64,
    pub kind: Kind,
    pub text: String,
    pub runs: Vec<Run>,
    pub links: Vec<Link>,
    /// For `Kind::Image`: the index in `Book::images`.
    pub image: Option<u32>,
    /// For `Kind::Table`: its shape.
    pub table: Option<TableShape>,
}

impl Block {
    pub fn new(key: u64, kind: Kind, text: String, runs: Vec<Run>) -> Self {
        Block { key, kind, text, runs, links: Vec::new(), image: None, table: None }
    }

    /// Style at every byte boundary is resolved by walking runs; this yields
    /// maximal (start, end, style) spans covering the whole text.
    pub fn spans(&self) -> impl Iterator<Item = (usize, usize, u8)> + '_ {
        let len = self.text.len();
        let mut out = Vec::with_capacity(self.runs.len() * 2 + 1);
        let mut at = 0usize;
        for r in &self.runs {
            let (s, e) = (r.start as usize, r.end as usize);
            if s > at {
                out.push((at, s, 0));
            }
            if e > s {
                out.push((s, e, r.style));
            }
            at = e;
        }
        if at < len {
            out.push((at, len, 0));
        }
        out.into_iter()
    }
}

impl Book {
    pub fn words(&self) -> usize {
        self.sections.iter().flat_map(|s| &s.blocks).filter(|b| b.kind != Kind::Image).map(|b| words(&b.text)).sum()
    }
}

/// Words in a text: what lies between spaces, and in writing without spaces, about what
/// a word is worth there (Chinese and Japanese: two characters; Thai, Lao, Khmer and
/// Burmese: five). Counting by spaces alone made a Chinese paragraph one word.
pub fn words(s: &str) -> usize {
    let (mut n, mut word, mut han, mut sea) = (0usize, false, 0usize, 0usize);
    for c in s.chars() {
        match unspaced(c) {
            1 => han += 1,
            2 => sea += 1,
            // (East Asian punctuation parts words as a space does)
            _ if c.is_whitespace() || (c as u32 >= 0x2E80 && !c.is_alphanumeric()) => word = false,
            _ if !word => {
                n += 1;
                word = true;
            }
            _ => {}
        }
        if unspaced(c) != 0 {
            word = false;
        }
    }
    n + han.div_ceil(2) + sea.div_ceil(5)
}

/// 1: Han and kana; 2: the scripts of South-East Asia written without spaces; 0: others.
fn unspaced(c: char) -> u8 {
    match c as u32 {
        0x3040..=0x30FF | 0x31F0..=0x31FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF | 0xFF66..=0xFF9F | 0x20000..=0x3134F => 1,
        0x0E00..=0x0EFF | 0x1000..=0x109F | 0x1780..=0x17FF => 2,
        _ => 0,
    }
}

/// FNV-1a, 64-bit. Used for content ids; not for security.
pub fn fnv64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Builds block text and runs from styled pieces, merging neighbours with one style
/// and collapsing whitespace the way HTML does.
#[derive(Default, Clone)]
pub struct TextBuilder {
    text: String,
    runs: Vec<Run>,
    pending_space: bool,
    /// Links recorded while building: byte range and an opaque payload (ingest's own).
    pub links: Vec<(u32, u32, String)>,
    /// A link being built: where it starts (once its first text arrives) and its payload.
    open_link: Option<(Option<u32>, String)>,
}

impl TextBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    /// Appends text, collapsing whitespace as HTML does: only ASCII whitespace collapses.
    /// Non-breaking, thin and other typographic spaces are text and are kept. A space held
    /// between two zero-width no-break spaces (Standard Ebooks' "word&#xFEFF; &#xFEFF;…") is
    /// a non-breaking space; other U+FEFF (a deprecated joiner, never drawn) is dropped.
    pub fn push(&mut self, s: &str, style: u8) {
        let normalised;
        let s = if s.contains('\u{feff}') {
            normalised = s.replace("\u{feff} \u{feff}", "\u{a0}").replace('\u{feff}', "");
            normalised.as_str()
        } else {
            s
        };
        for (i, piece) in s.split([' ', '\t', '\n', '\r', '\x0c']).enumerate() {
            if i > 0 {
                self.pending_space = true;
            }
            if piece.is_empty() {
                continue;
            }
            if self.pending_space && !self.text.is_empty() && !self.text.ends_with(['\n', '\t']) {
                self.raw(" ", 0);
            }
            self.pending_space = false;
            self.raw(piece, style);
        }
    }

    /// Appends text built elsewhere (a table cell), its runs and links shifted along.
    pub fn append(&mut self, text: &str, runs: &[Run], links: &[(u32, u32, String)]) {
        let base = self.text.len() as u32;
        self.text.push_str(text);
        self.runs.extend(runs.iter().map(|r| Run { start: r.start + base, end: r.end + base, style: r.style }));
        self.links.extend(links.iter().map(|(s, e, p)| (s + base, e + base, p.clone())));
        self.pending_space = false;
    }

    /// The boundary between two table cells (a tab; see `Kind::Table`).
    pub fn cell(&mut self) {
        while self.text.ends_with(' ') {
            self.text.pop();
        }
        let len = self.text.len() as u32;
        for r in self.runs.iter_mut() {
            r.end = r.end.min(len);
        }
        self.runs.retain(|r| r.start < r.end);
        self.text.push('\t');
        self.pending_space = false;
    }

    /// A hard line break (verse lines, <br>).
    pub fn newline(&mut self) {
        while self.text.ends_with(' ') {
            self.text.pop();
            if let Some(r) = self.runs.last_mut()
                && r.end as usize > self.text.len() {
                    r.end = self.text.len() as u32;
                }
        }
        if !self.text.is_empty() && !self.text.ends_with('\n') {
            self.text.push('\n');
        }
        self.pending_space = false;
    }

    /// Starts a link over the text pushed until `end_link`.
    pub fn begin_link(&mut self, payload: String) {
        self.open_link = Some((None, payload));
    }

    pub fn end_link(&mut self) {
        if let Some((Some(s), payload)) = self.open_link.take() {
            let e = self.text.trim_end_matches([' ', '\n']).len() as u32;
            if e > s {
                self.links.push((s, e, payload));
            }
        }
    }

    /// Bytes of text so far.
    pub fn len(&self) -> usize {
        self.text.len()
    }

    /// The text so far.
    pub fn text(&self) -> &str {
        &self.text
    }

    fn raw(&mut self, s: &str, style: u8) {
        let start = self.text.len() as u32;
        // a link starts at its first text, not at the space set before it
        if let Some((st @ None, _)) = self.open_link.as_mut()
            && s != " " {
                *st = Some(start);
            }
        self.text.push_str(s);
        let end = self.text.len() as u32;
        if style == 0 {
            return;
        }
        if let Some(r) = self.runs.last_mut() {
            if r.style == style && r.end == start {
                r.end = end;
                return;
            }
            // a space between two runs of one style joins them
            if r.style == style && r.end + 1 == start && &self.text[r.end as usize..start as usize] == " " {
                r.end = end;
                return;
            }
        }
        self.runs.push(Run { start, end, style });
    }

    pub fn is_empty(&self) -> bool {
        self.text.trim().is_empty()
    }

    pub fn finish(self) -> (String, Vec<Run>) {
        let (t, r, _) = self.finish_with_links();
        (t, r)
    }

    pub fn finish_with_links(mut self) -> (String, Vec<Run>, Vec<(u32, u32, String)>) {
        while self.text.ends_with([' ', '\n']) {
            self.text.pop();
        }
        let len = self.text.len() as u32;
        self.runs.retain_mut(|r| {
            r.end = r.end.min(len);
            r.start < r.end
        });
        self.links.retain_mut(|l| {
            l.1 = l.1.min(len);
            l.0 < l.1
        });
        (self.text, self.runs, self.links)
    }
}

/// Adds `add` to the style of text[s..e), splitting runs as needed.
pub fn add_style(block: &mut Block, s: u32, e: u32, add: u8) {
    let mut out: Vec<Run> = Vec::with_capacity(block.runs.len() + 2);
    let mut at = s;
    for r in block.runs.drain(..) {
        if r.end <= s || r.start >= e {
            out.push(r);
            continue;
        }
        if r.start < s {
            out.push(Run { start: r.start, end: s, style: r.style });
        }
        let (a, z) = (r.start.max(s), r.end.min(e));
        if a > at {
            out.push(Run { start: at, end: a, style: add });
        }
        out.push(Run { start: a, end: z, style: r.style | add });
        at = z;
        if r.end > e {
            out.push(Run { start: e, end: r.end, style: r.style });
        }
    }
    if at < e {
        out.push(Run { start: at, end: e, style: add });
    }
    out.sort_by_key(|r| r.start);
    block.runs = out;
}

/// Marks the opening words of a chapter's first paragraph as small capitals: a run of
/// capitalised words if the text starts with one (Gutenberg's "SYME was…"), otherwise
/// the first word.
pub fn apply_lead_in(block: &mut Block) {
    if block.kind != Kind::P || block.text.is_empty() {
        return;
    }
    let t = &block.text;
    let mut i = 0;
    // skip an opening quote
    for c in t.chars() {
        if matches!(c, '“' | '‘' | '"' | '\'') {
            i += c.len_utf8();
        } else {
            break;
        }
    }
    let start = i;
    let rest = &t[start..];
    let word_end = |s: &str| s.find(|c: char| c.is_whitespace() || matches!(c, ',' | '.' | ';' | ':' | '!' | '?' | '—' | '”' | '’')).unwrap_or(s.len());
    let mut end = start;
    let mut caps_end = start;
    let mut p = 0;
    loop {
        let w = &rest[p..];
        let we = word_end(w);
        let word = &w[..we];
        let letters = word.chars().filter(|c| c.is_alphabetic()).count();
        if letters >= 2 && word.chars().all(|c| !c.is_lowercase()) {
            caps_end = start + p + we;
            if w[we..].starts_with(' ') {
                p += we + 1;
                continue;
            }
        }
        break;
    }
    if caps_end > start {
        end = caps_end;
    } else {
        end += word_end(rest);
    }
    if end <= start {
        return;
    }
    // lowercase the shouted words: small caps of lowercase look the same and keep the
    // first capital
    if caps_end > start {
        let lead: String = {
            let seg = &block.text[start..end];
            let mut out = String::with_capacity(seg.len());
            for (wi, w) in seg.split(' ').enumerate() {
                if wi > 0 {
                    out.push(' ');
                }
                let mut cs = w.chars();
                if let Some(f) = cs.next() {
                    out.push(f);
                    out.extend(cs.flat_map(char::to_lowercase));
                }
            }
            out
        };
        if lead.len() == end - start {
            block.text.replace_range(start..end, &lead);
        }
    }
    let (s, e) = (start as u32, end as u32);
    let mut runs: Vec<Run> = Vec::with_capacity(block.runs.len() + 1);
    let mut placed = false;
    for r in block.runs.drain(..) {
        if r.end <= s {
            runs.push(r);
        } else if r.start >= e {
            if !placed {
                runs.push(Run { start: s, end: e, style: style::SMALLCAPS });
                placed = true;
            }
            runs.push(r);
        } else {
            // overlap: combine styles over the overlap, keep the rest
            if r.start < s {
                runs.push(Run { start: r.start, end: s, style: r.style });
            }
            if !placed {
                runs.push(Run { start: s, end: e, style: style::SMALLCAPS | r.style });
                placed = true;
            }
            if r.end > e {
                runs.push(Run { start: e, end: r.end, style: r.style });
            }
        }
    }
    if !placed {
        runs.push(Run { start: s, end: e, style: style::SMALLCAPS });
    }
    block.runs = runs;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_collapses_space_and_merges_runs() {
        let mut b = TextBuilder::new();
        b.push("  Hello\n  ", 0);
        b.push("brave", style::ITALIC);
        b.push(" ", style::ITALIC);
        b.push("new", style::ITALIC);
        b.push(" world ", 0);
        let (t, r) = b.finish();
        assert_eq!(t, "Hello brave new world");
        assert_eq!(r, vec![Run { start: 6, end: 15, style: style::ITALIC }]);
    }

    #[test]
    fn lead_in_shouted_words() {
        let mut b = Block::new(0, Kind::P, "THE suburb of Saffron Park lay".into(), vec![]);
        apply_lead_in(&mut b);
        assert_eq!(b.text, "The suburb of Saffron Park lay");
        assert_eq!(b.runs, vec![Run { start: 0, end: 3, style: style::SMALLCAPS }]);
        let mut b = Block::new(0, Kind::P, "“SYME WAS here,” he said".into(), vec![]);
        apply_lead_in(&mut b);
        assert_eq!(&b.text[b.runs[0].start as usize..b.runs[0].end as usize], "Syme Was");
    }

    #[test]
    fn typographic_spaces_are_kept() {
        let mut b = TextBuilder::new();
        b.push("Mr.\u{a0}Brooke, 10\u{2009}000 —  stone\u{feff} \u{feff}…", 0);
        let (t, _) = b.finish();
        assert_eq!(t, "Mr.\u{a0}Brooke, 10\u{2009}000 — stone\u{a0}…");
    }

    #[test]
    fn links_cover_their_text() {
        let mut b = TextBuilder::new();
        b.push("See note", 0);
        b.push(" ", 0);
        b.begin_link("x".into());
        b.push("12", style::SUP);
        b.end_link();
        b.push(" here.", 0);
        let (t, _, l) = b.finish_with_links();
        assert_eq!(&t[l[0].0 as usize..l[0].1 as usize], "12");
    }

    #[test]
    fn style_added_over_a_range() {
        let mut b = Block::new(0, Kind::P, "abcdefgh".into(), vec![Run { start: 2, end: 5, style: style::ITALIC }]);
        add_style(&mut b, 4, 7, style::SUP);
        assert_eq!(b.runs, vec![Run { start: 2, end: 4, style: 1 }, Run { start: 4, end: 5, style: 9 }, Run { start: 5, end: 7, style: 8 }]);
    }

    #[test]
    fn lead_in_plain_word() {
        let mut b = Block::new(0, Kind::P, "Miss Brooke had".into(), vec![]);
        apply_lead_in(&mut b);
        assert_eq!(b.runs, vec![Run { start: 0, end: 4, style: style::SMALLCAPS }]);
    }
}

#[cfg(test)]
mod repair_tests {
    use super::*;

    #[test]
    fn runs_and_links_off_the_characters_are_put_back_on_them() {
        // "a\u{a0}b": the no-break space is bytes 1..3
        let mut b = Block::new(1, Kind::P, "a\u{a0}b".into(), vec![Run { start: 2, end: 4, style: 1 }, Run { start: 9, end: 12, style: 2 }]);
        b.links = vec![Link { start: 0, end: 2, to: Target::Note(0) }];
        let mut book = Book { id: "x".into(), meta: Meta::default(), sections: vec![Section { kind: SectionKind::Chapter, part: String::new(), label: String::new(), num: "1".into(), title: String::new(), blocks: vec![b] }], notes: vec![], images: vec![], cover: None };
        assert_eq!(book.repair(), 3);
        let b = &book.sections[0].blocks[0];
        assert_eq!(b.runs, vec![Run { start: 1, end: 4, style: 1 }]);
        assert_eq!((b.links[0].start, b.links[0].end), (0, 3));
        assert_eq!(book.repair(), 0);
    }
}

#[cfg(test)]
mod words_tests {
    use super::words;

    #[test]
    fn counts_words_with_and_without_spaces() {
        // spaced text as before: whatever lies between spaces, a lone dash too
        assert_eq!(words("The fox didn't run — twice."), 6);
        assert_eq!(words("  "), 0);
        // Chinese: 11 characters, about six words; the punctuation counts for nothing
        assert_eq!(words("子曰：「學而時習之，不亦說乎？」"), 6);
        // Japanese, mixed with digits
        assert_eq!(words("第1章 吾輩は猫である。"), 6);
        // Thai: 10 letters, two words' worth
        assert_eq!(words("สวัสดีครับ"), 2);
    }
}
