//! One engine for both shells: books and fonts in memory, layouts cached per setting.
//! The Tauri shell calls it natively; the web build calls it through WASM.

pub mod find;
pub mod search;
pub mod anchor;

use rustc_hash::{FxHashMap, FxHasher};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
pub use vol_model::{Book, SectionKind};
pub use vol_press::Params;
/// What the importer makes of a file, as a number (`vol_ingest::VERSION`).
pub const IMPORTER_VERSION: u32 = vol_ingest::VERSION;
use vol_press::hyph::Patterns;
use vol_press::{Family, Press, SectionLayout, Typeface, Typo};

/// What the reader asks a layout for: the page geometry and the theme's type.
#[derive(serde::Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub size: f32,
    pub measure: f32,
    pub rows: u32,
    pub head_rows: u32,
    /// Row height, px (images are fitted to whole rows).
    #[serde(default)]
    pub lh: f32,
    pub justify: bool,
    pub hyphenate: bool,
    pub round: bool,
    /// Glyph advances rounded to 1/60 px (Firefox; see `Typo::app_units`).
    #[serde(default)]
    pub app_units: bool,
    /// Families in fallback order; unknown ones are skipped, and none at all means
    /// the default.
    #[serde(default)]
    pub font: Vec<String>,
    #[serde(default = "body")]
    pub wght: f32,
    #[serde(default = "bold")]
    pub bold: f32,
    /// Letter spacing and extra word spacing, px.
    #[serde(default)]
    pub ls: f32,
    #[serde(default)]
    pub ws: f32,
    /// Further axis settings, e.g. `["SOFT", 50]`.
    #[serde(default)]
    pub axes: Vec<(String, f32)>,
    /// How the renderer kerns around word spaces (see `Typo::space_kern`).
    #[serde(default)]
    pub space_kern: u8,
    /// The renderer shapes each inline element on its own (see `Params::link_runs`).
    #[serde(default)]
    pub link_runs: bool,
}

fn body() -> f32 {
    vol_press::shape::BODY_WGHT
}
fn bold() -> f32 {
    vol_press::shape::BOLD_WGHT
}

impl Request {
    pub fn plain(size: f32, measure: f32, rows: u32) -> Request {
        Request { size, measure, rows, head_rows: 7, lh: size * 1.5, justify: true, hyphenate: true, round: false, app_units: false, font: vec![], wght: body(), bold: bold(), ls: 0.0, ws: 0.0, axes: vec![], space_kern: 0, link_runs: false }
    }

    fn typo(&self) -> Typo {
        let mut axes = [(0u32, 0.0f32); 4];
        for (slot, (t, v)) in axes.iter_mut().zip(self.axes.iter().filter(|(t, _)| t.len() == 4)) {
            let b = t.as_bytes();
            *slot = (u32::from_be_bytes([b[0], b[1], b[2], b[3]]), *v);
        }
        Typo { size: self.size, wght: self.wght, bold: self.bold, ls: self.ls, ws: self.ws, axes, round: self.round, app_units: self.app_units, space_kern: self.space_kern }
    }

    fn params(&self) -> Params {
        Params { typo: self.typo(), measure: self.measure, rows: self.rows, head_rows: self.head_rows, lh: if self.lh > 0.0 { self.lh } else { self.size * 1.5 }, link_runs: self.link_runs, justify: self.justify, hyphenate: self.hyphenate }
    }

    fn key(&self) -> u64 {
        let mut h = FxHasher::default();
        format!("{self:?}").hash(&mut h);
        h.finish()
    }
}

/// What the reader needs to know about a family to style it like the press sets it.
#[derive(serde::Serialize)]
pub struct FamilyInfo {
    pub files: usize,
    pub smcp: bool,
    pub italic: bool,
    /// (min, max) weight of each file.
    pub weights: Vec<(f32, f32)>,
}

pub const DEFAULT_FAMILY: &str = "Literata";
/// The face of preformatted text.
pub const MONO_FAMILY: &str = "JetBrains Mono";

pub struct Engine {
    families: FxHashMap<String, Arc<Family>>,
    /// One press per typeface (fallback chain).
    presses: FxHashMap<Vec<String>, Press>,
    books: FxHashMap<String, Book>,
    /// Layouts for the most recent parameters of each book.
    cache: FxHashMap<String, (u64, FxHashMap<u32, SectionLayout>)>,
    /// Folded text for find, built on a book's first search.
    finders: FxHashMap<String, find::Index>,
    /// Hyphenation patterns by language code (`vol_press::hyph`).
    patterns: FxHashMap<&'static str, Patterns>,
}

impl Default for Engine {
    fn default() -> Self {
        Engine::new()
    }
}

impl Engine {
    /// An engine with no fonts: add them with [`Engine::add_font`].
    pub fn new() -> Engine {
        Engine { families: FxHashMap::default(), presses: FxHashMap::default(), books: FxHashMap::default(), cache: FxHashMap::default(), finders: FxHashMap::default(), patterns: FxHashMap::default() }
    }

    /// Adds a language's hyphenation patterns (`assets/hyph/<code>.bin`).
    pub fn add_patterns(&mut self, code: &str, bytes: Vec<u8>) -> Result<(), String> {
        let code = vol_press::hyph::LANGS.iter().copied().find(|l| *l == code).ok_or_else(|| format!("no patterns for {code}"))?;
        let pat = Patterns::new(bytes).ok_or("unreadable hyphenation patterns")?;
        self.patterns.insert(code, pat);
        // layouts made without them are stale
        self.cache.clear();
        Ok(())
    }

    /// Every language's patterns from a directory (native tools and tests).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn add_patterns_from(&mut self, dir: &std::path::Path) {
        for code in vol_press::hyph::LANGS {
            if let Ok(b) = std::fs::read(dir.join(format!("{code}.bin"))) {
                self.add_patterns(code, b).ok();
            }
        }
    }

    /// The language whose patterns a book needs and the engine lacks, if any (the web
    /// build fetches them before the first layout).
    pub fn patterns_wanted(&self, id: &str) -> Option<&'static str> {
        let code = vol_press::hyph::lang_code(&self.books.get(id)?.meta.lang)?;
        (!self.patterns.contains_key(code)).then_some(code)
    }

    /// Adds a font file to a family (created on first use).
    pub fn add_font(&mut self, family: &str, bytes: Vec<u8>) -> Result<(), String> {
        let fam = self.families.entry(family.to_string()).or_default();
        if !Arc::make_mut(fam).add(bytes) {
            return Err(format!("a font file for {family} could not be read"));
        }
        // anything set with this family is stale (an extension changes every chain it joins)
        if family.starts_with(MONO_FAMILY) || family.ends_with("~ext") {
            self.presses.clear();
        } else {
            self.presses.retain(|k, _| !k.iter().any(|f| f == family));
        }
        self.cache.clear();
        Ok(())
    }

    pub fn has_family(&self, family: &str) -> bool {
        self.families.get(family).is_some_and(|f| !f.files.is_empty())
    }

    pub fn family_files(&self, family: &str) -> &[vol_press::shape::FontFile] {
        self.families.get(family).map(|f| f.files.as_slice()).unwrap_or(&[])
    }

    pub fn family_info(&self, family: &str) -> Option<FamilyInfo> {
        let f = self.families.get(family)?;
        Some(FamilyInfo { files: f.files.len(), smcp: f.smcp(), italic: f.files.iter().any(|x| x.italic), weights: f.files.iter().map(|x| (x.wmin, x.wmax)).collect() })
    }

    /// The press for a request's typeface: its known families in order.
    fn press(&mut self, font: &[String]) -> Result<&mut Press, String> {
        // each family followed by its extension, if loaded: the page picks between a bundled
        // face's two files by unicode-range, which is this order (fonts.css)
        let mut chain: Vec<String> = Vec::new();
        for f in font {
            if self.has_family(f) {
                chain.push(f.clone());
                let ext = format!("{f}~ext");
                if self.has_family(&ext) {
                    chain.push(ext);
                }
            }
        }
        if chain.is_empty() {
            chain.push(DEFAULT_FAMILY.to_string());
        }
        if !self.presses.contains_key(&chain) {
            let fams = chain.iter().filter_map(|f| self.families.get(f).cloned()).collect();
            let tf = Typeface::new(fams).ok_or("no fonts are loaded")?;
            let mono_ext = format!("{MONO_FAMILY}~ext");
            let mono = self.families.get(MONO_FAMILY).filter(|f| !f.files.is_empty()).and_then(|f| Typeface::new([Some(f.clone()), self.families.get(&mono_ext).cloned()].into_iter().flatten().collect()));
            self.presses.insert(chain.clone(), Press::new(tf).with_mono(mono));
        }
        Ok(self.presses.get_mut(&chain).unwrap())
    }

    /// Reads an EPUB or text file; returns the new book's id.
    pub fn import(&mut self, bytes: &[u8], name: &str) -> Result<String, String> {
        let book = vol_ingest::any(bytes, name).map_err(|e| e.to_string())?;
        Ok(self.insert(book))
    }

    /// Reads a file and keeps only chapters `from` to `to` (counted from 1): an extract for
    /// a page, a sample (the kit). Its own id, so it never stands in for the whole book.
    pub fn import_chapters(&mut self, bytes: &[u8], name: &str, from: usize, to: usize) -> Result<String, String> {
        let mut book = vol_ingest::any(bytes, name).map_err(|e| e.to_string())?;
        let mut n = 0;
        book.sections.retain(|s| {
            if s.kind != SectionKind::Chapter {
                return false;
            }
            n += 1;
            n >= from && n <= to
        });
        if book.sections.is_empty() {
            return Err(format!("the book has no chapter {from}"));
        }
        book.id = format!("{}-{from}-{to}", book.id);
        Ok(self.insert(book))
    }

    pub fn insert(&mut self, mut book: Book) -> String {
        book.repair();
        let id = book.id.clone();
        self.cache.remove(&id);
        self.finders.remove(&id);
        self.books.insert(id.clone(), book);
        id
    }

    /// Restores a book saved with [`Engine::save`].
    pub fn restore(&mut self, bytes: &[u8]) -> Result<String, String> {
        let book = Book::restore(bytes).map_err(|e| format!("a saved book is damaged ({e})"))?;
        Ok(self.insert(book))
    }

    pub fn save(&self, id: &str) -> Option<Vec<u8>> {
        self.books.get(id).and_then(Book::save)
    }

    /// The cover found at import (only until the book is saved and restored).
    pub fn cover(&self, id: &str) -> Option<&vol_model::Cover> {
        self.books.get(id).and_then(|b| b.cover.as_ref())
    }

    /// An image found at import (only until the book is saved and restored: the shells
    /// store image bytes themselves).
    /// The sizes the reader measured for images it draws itself (rich blocks): CSS px at
    /// their natural width. Layouts made with the old sizes are dropped.
    pub fn set_image_sizes(&mut self, id: &str, sizes: &[(u32, u32, u32)]) -> bool {
        let Some(b) = self.books.get_mut(id) else { return false };
        for &(i, w, h) in sizes {
            if let Some(img) = b.images.get_mut(i as usize) {
                (img.w, img.h) = (w, h);
            }
        }
        self.cache.remove(id);
        true
    }

    pub fn image(&self, id: &str, idx: usize) -> Option<&vol_model::Image> {
        self.books.get(id).and_then(|b| b.images.get(idx)).filter(|i| !i.bytes.is_empty())
    }

    pub fn has(&self, id: &str) -> bool {
        self.books.contains_key(id)
    }

    pub fn book(&self, id: &str) -> Option<&Book> {
        self.books.get(id)
    }

    pub fn forget(&mut self, id: &str) {
        self.books.remove(id);
        self.cache.remove(id);
        self.finders.remove(id);
    }

    /// The book as the frontend reads it (JSON, UTF-16 offsets).
    pub fn book_json(&self, id: &str) -> Option<String> {
        let b = self.books.get(id)?;
        let mut js = vol_model::js::to_js(b);
        js.ext = beyond_core(b);
        serde_json::to_string(&js).ok()
    }

    /// What a book needs beyond its theme's face, which must be loaded (with its extension,
    /// if the book wants one): its characters that face lacks, each once (the fallback faces
    /// are fetched only for these), and whether it has preformatted text (the monospaced
    /// face). JSON `{ "fallback": "…", "pre": bool }`.
    pub fn font_needs(&self, id: &str, family: &str) -> Option<String> {
        let b = self.books.get(id)?;
        let fams: Vec<&Arc<Family>> = [self.families.get(family), self.families.get(&format!("{family}~ext"))].into_iter().flatten().collect();
        let mut seen = rustc_hash::FxHashSet::default();
        let mut fallback = String::new();
        let mut take = |t: &str| {
            for c in t.chars() {
                if seen.len() < 2000 && !c.is_control() && !c.is_whitespace() && !matches!(c, '\u{ad}' | '\u{200b}'..='\u{200f}' | '\u{2060}' | '\u{feff}') && seen.insert(c) && !fams.iter().any(|f| f.covers(c)) {
                    fallback.push(c);
                }
            }
        };
        take(&b.meta.title);
        for s in &b.sections {
            take(&s.title);
            take(&s.label);
            for x in &s.blocks {
                take(&x.text);
            }
        }
        for n in &b.notes {
            take(&n.text);
        }
        let pre = b.sections.iter().any(|s| s.blocks.iter().any(|x| x.kind == vol_model::Kind::Pre));
        serde_json::to_string(&serde_json::json!({ "fallback": fallback, "pre": pre })).ok()
    }

    /// The book has characters beyond the bundled fonts' core files: their extensions
    /// (`Name~ext`) are wanted for it.
    pub fn ext_wanted(&self, id: &str) -> bool {
        self.books.get(id).is_some_and(|b| !beyond_core(b).is_empty())
    }

    /// Finds `query` in a book. Encoded as u32s: `[total, phrase, (sec, block, s, e, near) × hits]`,
    /// offsets UTF-16 within the block.
    pub fn find(&mut self, id: &str, query: &str, limit: usize) -> Option<Vec<u32>> {
        let book = self.books.get(id)?;
        let ix = self.finders.entry(id.to_string()).or_insert_with(|| find::Index::build(book));
        let f = ix.find(query, limit);
        let mut out = Vec::with_capacity(2 + f.hits.len() * 5);
        out.extend([f.total, f.phrase as u32]);
        for h in f.hits {
            out.extend([h.sec, h.block, h.s, h.e, h.near as u32]);
        }
        Some(out)
    }

    /// Places notes on a book (see `anchor`): where each belongs now, and how it was found.
    pub fn place(&self, id: &str, anchors: &[anchor::Anchor]) -> Option<Vec<anchor::Placed>> {
        let book = self.books.get(id)?;
        let a = anchor::Anchorer::new(book);
        Some(anchors.iter().map(|x| a.place(x)).collect())
    }

    /// (exact, whole px, 1/60 px) widths of probe strings, for calibrating against the webview.
    pub fn probe(&mut self, r: &Request, texts: &[&str]) -> Result<Vec<(f32, f32, f32)>, String> {
        let typo = r.typo();
        Ok(self.press(&r.font)?.probe(&typo, texts))
    }

    /// Lays out the given sections (all when empty) and returns the encoded table.
    pub fn layout(&mut self, id: &str, sections: &[u32], r: &Request) -> Result<Vec<u8>, String> {
        let key = r.key();
        let p = r.params();
        let missing: Vec<u32> = {
            let book = self.books.get(id).ok_or("missing book")?;
            let entry = self.cache.entry(id.to_string()).or_insert_with(|| (key, FxHashMap::default()));
            if entry.0 != key {
                *entry = (key, FxHashMap::default());
            }
            let want: Vec<u32> = if sections.is_empty() { (0..book.sections.len() as u32).collect() } else { sections.to_vec() };
            want.into_iter().filter(|s| (*s as usize) < book.sections.len() && !entry.1.contains_key(s)).collect()
        };
        if !missing.is_empty() {
            let book = self.books.remove(id).ok_or("missing book")?;
            let hyph = vol_press::hyph::lang_code(&book.meta.lang).and_then(|c| self.patterns.get(c)).cloned();
            let res = self.press(&r.font).map(|press| lay(press, &book, &missing, &p, hyph.as_ref()));
            self.books.insert(id.to_string(), book);
            let entry = self.cache.get_mut(id).unwrap();
            for (s, l) in res? {
                entry.1.insert(s, l);
            }
        }
        let book = &self.books[id];
        let entry = &self.cache[id];
        let want: Vec<u32> = if sections.is_empty() { (0..book.sections.len() as u32).collect() } else { sections.to_vec() };
        let refs: Vec<(u32, &SectionLayout)> = want.iter().filter_map(|s| entry.1.get(s).map(|l| (*s, l))).collect();
        Ok(vol_press::encode(&refs))
    }
}

#[cfg(not(feature = "parallel"))]
fn lay(press: &mut Press, book: &Book, secs: &[u32], p: &Params, hyph: Option<&Patterns>) -> Vec<(u32, SectionLayout)> {
    secs.iter().map(|&s| (s, press.section(book, s as usize, p, hyph))).collect()
}

#[cfg(feature = "parallel")]
fn lay(press: &mut Press, book: &Book, secs: &[u32], p: &Params, hyph: Option<&Patterns>) -> Vec<(u32, SectionLayout)> {
    use rayon::prelude::*;
    if secs.len() < 3 {
        return secs.iter().map(|&s| (s, press.section(book, s as usize, p, hyph))).collect();
    }
    // one press per worker thread; longest sections first so threads finish together
    let tf = press.typeface().clone();
    let mono = press.mono_typeface().cloned();
    let mut order: Vec<u32> = secs.to_vec();
    order.sort_by_key(|&s| std::cmp::Reverse(book.sections[s as usize].blocks.iter().map(|b| b.text.len()).sum::<usize>()));
    order.par_iter().map_init(|| Press::new(tf.clone()).with_mono(mono.clone()), |pr, &s| (s, pr.section(book, s as usize, p, hyph))).collect()
}

/// The core files' ranges (`assets/fonts/core-ranges.txt`).
fn core_ranges() -> &'static [(u32, u32)] {
    static R: std::sync::OnceLock<Vec<(u32, u32)>> = std::sync::OnceLock::new();
    R.get_or_init(|| {
        include_str!("../../../assets/fonts/core-ranges.txt")
            .lines()
            .map(|l| l.split('#').next().unwrap_or("").trim())
            .filter(|l| !l.is_empty())
            .filter_map(|l| {
                let (a, b) = l.split_once('-').unwrap_or((l, l));
                Some((u32::from_str_radix(a, 16).ok()?, u32::from_str_radix(b, 16).ok()?))
            })
            .collect()
    })
}

/// A book's characters that no core file has (controls aside), each once, at most 4,000.
fn beyond_core(b: &Book) -> String {
    let r = core_ranges();
    let mut seen = rustc_hash::FxHashSet::default();
    let mut out = String::new();
    let mut take = |t: &str| {
        for c in t.chars() {
            if seen.len() < 4000 && !c.is_control() && !r.iter().any(|&(a, z)| (a..=z).contains(&(c as u32))) && seen.insert(c) {
                out.push(c);
            }
        }
    };
    take(&b.meta.title);
    for s in &b.sections {
        take(&s.title);
        take(&s.label);
        for x in &s.blocks {
            take(&x.text);
        }
    }
    for n in &b.notes {
        take(&n.text);
    }
    out
}

/// A reader's note to put into a Word file as a comment (`vol_ingest::annotate`).
#[derive(serde::Deserialize)]
struct WordComment {
    quote: String,
    #[serde(default)]
    prefix: String,
    #[serde(default)]
    suffix: String,
    author: String,
    text: String,
    #[serde(default)]
    date: String,
}

/// Readers' notes put into the writer's Word file as Word comments: the file again, and
/// `{"placed": n, "unplaced": [indices]}`. One function for both shells.
pub fn annotate_docx(docx: &[u8], comments_json: &str) -> Result<(Vec<u8>, String), String> {
    let cs: Vec<WordComment> = serde_json::from_str(comments_json).map_err(|e| e.to_string())?;
    let cs: Vec<vol_ingest::annotate::Comment> = cs
        .into_iter()
        .map(|c| vol_ingest::annotate::Comment { quote: c.quote, prefix: c.prefix, suffix: c.suffix, author: c.author, text: c.text, date: c.date })
        .collect();
    let a = vol_ingest::annotate::annotate(docx, &cs).map_err(|e| e.to_string())?;
    let report = format!("{{\"placed\":{},\"unplaced\":{:?}}}", a.placed, a.unplaced);
    Ok((a.bytes, report))
}

/// Chapters `from` to `to` of a file as an EPUB of their own (`vol_ingest::write`): a
/// sample to put online, or a Word or Markdown manuscript as an EPUB (all its chapters).
pub fn epub_of(bytes: &[u8], name: &str, from: usize, to: usize) -> Result<Vec<u8>, String> {
    vol_ingest::write::sample(bytes, name, from, to)
}
