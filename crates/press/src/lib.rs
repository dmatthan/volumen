//! The press: sets a book's text into lines and columns.
//!
//! Output is a compact binary table (see [`encode`]) the reader maps straight into
//! typed arrays.

pub mod brk;
pub mod fill;
pub mod hyph;
pub mod shape;

pub use fill::{PLine, Params, SectionLayout, flag};
pub use shape::{Family, Typeface, Typo};
use vol_model::Book;

pub struct Press {
    tf: Typeface,
    measurer: Option<(String, shape::Measurer)>,
    mono: shape::Mono,
}

impl Press {
    pub fn new(tf: Typeface) -> Press {
        Press { tf, measurer: None, mono: shape::Mono::default() }
    }

    /// The monospaced face for preformatted text.
    pub fn with_mono(mut self, mono: Option<Typeface>) -> Press {
        self.mono = shape::Mono::new(mono);
        self
    }

    pub fn typeface(&self) -> &Typeface {
        &self.tf
    }

    pub fn mono_typeface(&self) -> Option<&Typeface> {
        self.mono.typeface()
    }

    /// Lays out one section, hyphenated by `hyph` (the book's language's patterns) if given.
    pub fn section(&mut self, book: &Book, index: usize, p: &Params, hyph: Option<&hyph::Patterns>) -> SectionLayout {
        let lang = hyph;
        let blang = &book.meta.lang;
        let stale = self.measurer.as_ref().is_none_or(|(l, m)| m.typo != p.typo || l != blang);
        if stale {
            self.measurer = Some((blang.to_string(), shape::Measurer::new(&self.tf, p.typo, blang)));
        }
        let m = &mut self.measurer.as_mut().unwrap().1;
        fill::layout_section(m, &mut self.mono, &book.sections[index], &book.images, p, lang)
    }

    /// Widths of probe strings in body text, for calibrating against the browser:
    /// returns (exact, rounded to whole px, rounded to 1/60 px) for each.
    pub fn probe(&mut self, typo: &Typo, texts: &[&str]) -> Vec<(f32, f32, f32)> {
        let mut exact = shape::Measurer::new(&self.tf, Typo { round: false, app_units: false, ..*typo }, "en");
        let mut rounded = shape::Measurer::new(&self.tf, Typo { round: true, app_units: false, ..*typo }, "en");
        let mut sixtieths = shape::Measurer::new(&self.tf, Typo { round: false, app_units: true, ..*typo }, "en");
        // word by word, as layout measures (and as browsers shape: no kerning across spaces);
        // a probe starting "<i>" is measured in italic (diagnostics)
        let w = |m: &mut shape::Measurer, t: &str| -> f32 {
            let (st, t) = match t.strip_prefix("<i>") {
                Some(r) => (vol_model::style::ITALIC, r),
                None => (0, t),
            };
            let words: Vec<&str> = t.split(' ').collect();
            let mut w = words.iter().map(|x| m.width(x, st)).sum::<f32>() + (words.len() - 1) as f32 * m.space;
            for p in words.windows(2) {
                if let (Some(l), Some(r)) = (p[0].chars().last(), p[1].chars().next()) {
                    w += m.space_kern(l, st, st, r, st);
                }
            }
            w
        };
        texts.iter().map(|t| (w(&mut exact, t), w(&mut rounded, t), w(&mut sixtieths, t))).collect()
    }

    /// Lays out every section in order.
    pub fn book(&mut self, book: &Book, p: &Params, hyph: Option<&hyph::Patterns>) -> Vec<SectionLayout> {
        (0..book.sections.len()).map(|i| self.section(book, i, p, hyph)).collect()
    }
}

/// Words per line field count in the encoded table.
pub const FIELDS: usize = 9;

/// Encodes layouts as little-endian 32-bit words:
/// `[n_sections, (cols, n_lines) × n_sections, lines…]`, each line being
/// `col, row, block, s, e, flags | spaces << 16` as u32 then `x, avail, natural` as f32.
pub fn encode(layouts: &[(u32, &SectionLayout)]) -> Vec<u8> {
    let n_lines: usize = layouts.iter().map(|(_, l)| l.lines.len()).sum();
    let mut out: Vec<u8> = Vec::with_capacity(4 * (1 + 3 * layouts.len() + FIELDS * n_lines));
    let mut put = |v: u32| out.extend_from_slice(&v.to_le_bytes());
    put(layouts.len() as u32);
    for (idx, l) in layouts {
        put(*idx);
        put(l.cols);
        put(l.lines.len() as u32);
    }
    for (_, l) in layouts {
        for ln in &l.lines {
            put(ln.col);
            put(ln.row);
            put(ln.block);
            put(ln.s);
            put(ln.e);
            put(ln.flags as u32 | (ln.spaces as u32) << 16);
            put(ln.x.to_bits());
            put(ln.avail.to_bits());
            put(ln.natural.to_bits());
        }
    }
    out
}
