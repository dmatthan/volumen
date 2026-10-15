//! Fonts and measurement. Words are shaped once per (style, size) and cached by hash.
//!
//! A theme's type is a chain of families: the first that has a character sets it, as a
//! browser picks fallback fonts by cmap. Each family holds any number of files, static or
//! variable, upright or italic; a style picks its file the way CSS font matching does.

use harfrust::{Direction, Feature, Font, Language, Script, ShapeOptions, ShapePlan, ShaperFont, Tag};
use read_fonts::TableProvider;
use rustc_hash::FxHashMap;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use vol_model::style;

/// One font file of a family.
#[derive(Clone)]
pub struct FontFile {
    font: Font,
    pub italic: bool,
    /// Weight range: a variable font's `wght` axis, or a static font's one weight.
    pub wmin: f32,
    pub wmax: f32,
    /// Has real small capitals (`smcp`).
    pub smcp: bool,
    /// `head` flags bit 3: rasterisers set it at whole-pixel sizes (FreeType does).
    pub int_ppem: bool,
}

impl FontFile {
    pub fn new(bytes: Vec<u8>) -> Option<FontFile> {
        let font = Font::new(bytes, 0)?;
        let t = font.tables();
        let os2 = t.os2().ok();
        let mut italic = os2.as_ref().is_some_and(|o| o.fs_selection().bits() & 1 != 0);
        if !italic {
            italic = t.head().ok().is_some_and(|h| h.mac_style().bits() & 2 != 0);
        }
        let weight = os2.as_ref().map(|o| o.us_weight_class() as f32).unwrap_or(400.0);
        let (mut wmin, mut wmax) = (weight, weight);
        if let Ok(fvar) = t.fvar() {
            if let Ok(axes) = fvar.axes() {
                for a in axes {
                    if a.axis_tag() == Tag::new(b"wght") {
                        wmin = a.min_value().to_f32();
                        wmax = a.max_value().to_f32();
                    }
                }
            }
        }
        let int_ppem = t.head().ok().is_some_and(|h| h.flags().bits() & 8 != 0);
        let smcp = t.gsub().ok().and_then(|g| g.feature_list().ok()).is_some_and(|fl| fl.feature_records().iter().any(|r| r.feature_tag() == Tag::new(b"smcp")));
        Some(FontFile { font, italic, wmin, wmax, smcp, int_ppem })
    }

    fn covers(&self, c: char) -> bool {
        self.font.charmap().map_unicode(c).is_some()
    }
}

/// A family: the files a CSS `@font-face` set would declare under one name.
#[derive(Default, Clone)]
pub struct Family {
    pub files: Vec<FontFile>,
}

impl Family {
    /// A family from its files; unreadable ones are skipped.
    pub fn of(files: Vec<Vec<u8>>) -> Family {
        let mut f = Family::default();
        for b in files {
            f.add(b);
        }
        f
    }

    pub fn add(&mut self, bytes: Vec<u8>) -> bool {
        match FontFile::new(bytes) {
            Some(f) => {
                self.files.push(f);
                true
            }
            None => false,
        }
    }

    /// The file CSS font matching would use (font-synthesis off): italic files for italic
    /// text when there are any, then the nearest weight by the CSS rules.
    pub fn pick(&self, italic: bool, w: f32) -> Option<&FontFile> {
        let pool: Vec<&FontFile> = if self.files.iter().any(|f| f.italic == italic) { self.files.iter().filter(|f| f.italic == italic).collect() } else { self.files.iter().collect() };
        if let Some(f) = pool.iter().find(|f| f.wmin <= w && w <= f.wmax) {
            return Some(f);
        }
        let above = || pool.iter().filter(|f| f.wmin > w).min_by(|a, b| a.wmin.total_cmp(&b.wmin)).copied();
        let below = || pool.iter().filter(|f| f.wmax < w).max_by(|a, b| a.wmax.total_cmp(&b.wmax)).copied();
        if (400.0..=500.0).contains(&w) {
            let near = pool.iter().filter(|f| f.wmin > w && f.wmin <= 500.0).min_by(|a, b| a.wmin.total_cmp(&b.wmin)).copied();
            near.or_else(below).or_else(above)
        } else if w < 400.0 {
            below().or_else(above)
        } else {
            above().or_else(below)
        }
    }

    /// Some file of the family has `c`.
    pub fn covers(&self, c: char) -> bool {
        self.files.iter().any(|f| f.covers(c))
    }

    pub fn smcp(&self) -> bool {
        self.pick(false, 400.0).is_some_and(|f| f.smcp)
    }
}

/// The families a theme sets type in, in fallback order.
#[derive(Clone)]
pub struct Typeface {
    pub families: Vec<Arc<Family>>,
}

impl Typeface {
    /// One family, no fallback (tests and tools).
    pub fn single(files: Vec<Vec<u8>>) -> Option<Typeface> {
        Typeface::new(vec![Arc::new(Family::of(files))])
    }

    pub fn new(families: Vec<Arc<Family>>) -> Option<Typeface> {
        if families.is_empty() || families[0].files.is_empty() {
            return None;
        }
        Some(Typeface { families })
    }
}

/// The type settings a layout is measured with. They must match the CSS the reader sets.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Typo {
    /// Body size in CSS px.
    pub size: f32,
    /// Weight of body text and of bold (`<b>`, headings).
    pub wght: f32,
    pub bold: f32,
    /// Letter spacing added after every character, and extra space per word space, px.
    pub ls: f32,
    pub ws: f32,
    /// Further axis settings (tag, value); a zero tag is unused.
    pub axes: [(u32, f32); 4],
    /// Glyph advances and kerning are rounded to whole px, as text renderers without
    /// subpixel positioning do (Chromium on Linux).
    pub round: bool,
    /// Each glyph's advance is rounded to 1/60 px, as Firefox lays text out (in "app units"
    /// of 1/60 CSS px). Exclusive with `round`.
    pub app_units: bool,
    /// How the renderer kerns around word spaces, for faces that kern with the space:
    /// 0 not at all, 1 only a glyph with the space after it (WebKit), 2 both sides of the
    /// space (Chromium). Calibration finds out.
    pub space_kern: u8,
}

impl Typo {
    pub fn plain(size: f32, round: bool) -> Typo {
        Typo { size, wght: BODY_WGHT, bold: BOLD_WGHT, ls: 0.0, ws: 0.0, axes: [(0, 0.0); 4], round, app_units: false, space_kern: 0 }
    }
}

/// Default weights (Literata). Themes set their own.
pub const BOLD_WGHT: f32 = 650.0;
pub const BODY_WGHT: f32 = 400.0;
/// Superscripts and subscripts are set at this fraction of the size. Must match the CSS.
pub const SCRIPT_SCALE: f32 = 0.7;
/// Small capitals for a face without `smcp`: capitals at this fraction of the size,
/// tracked and a little heavier so their strokes match the lowercase. Must match the CSS.
pub const SC_SCALE: f32 = 0.78;
pub const SC_TRACK: f32 = 0.05;
pub const SC_WGHT: f32 = 30.0;

/// Optical size for a font size in CSS px. The CSS sets the same value explicitly
/// (`font-variation-settings`); each font clamps it to its own axis.
pub fn opsz(px: f32) -> f32 {
    px.clamp(6.0, 144.0)
}

/// A length as FreeType holds it: 26.6 fixed point, so a value a hair under a half rounds
/// up once quantised.
fn px26(v: f32) -> f32 {
    (v * 64.0).round() / 64.0
}

struct Inst {
    font: Font,
    plan: ShapePlan,
    plan_sc: ShapePlan,
    scale: f32,
}

/// Style bits of an instance: italic, bold, script size, synthesised small caps.
const I_ITALIC: u8 = 1;
const I_BOLD: u8 = 2;
const I_SCRIPT: u8 = 4;
const I_SYNTH_SC: u8 = 8;

/// Every font instance one layout needs, at one size.
pub struct Measurer {
    tf: Typeface,
    pub typo: Typo,
    insts: FxHashMap<(u8, u8), Inst>,
    /// Which family sets a character, upright and italic.
    cover: FxHashMap<(bool, char), u8>,
    lang: Option<Language>,
    cache: FxHashMap<u64, f32>,
    buf: Option<harfrust::Buffer>,
    /// The first family has no small capitals: they are synthesised.
    pub synth_sc: bool,
    pub size: f32,
    pub round: bool,
    pub space: f32,
    pub hyphen: f32,
}

fn features(sc: bool, spaced: bool) -> Vec<Feature> {
    let mut f = vec![Feature::new(Tag::new(b"onum"), 1, ..), Feature::new(Tag::new(b"pnum"), 1, ..)];
    if sc {
        f.push(Feature::new(Tag::new(b"smcp"), 1, ..));
        f.push(Feature::new(Tag::new(b"c2sc"), 1, ..));
    }
    // browsers drop optional ligatures from letter-spaced text
    if spaced {
        f.push(Feature::new(Tag::new(b"liga"), 0, ..));
        f.push(Feature::new(Tag::new(b"clig"), 0, ..));
    }
    f
}

fn style_bits(st: u8, synth_sc: bool) -> u8 {
    let mut i = 0;
    if st & style::ITALIC != 0 {
        i |= I_ITALIC;
    }
    if st & style::BOLD != 0 {
        i |= I_BOLD;
    }
    if st & (style::SUP | style::SUB) != 0 {
        i |= I_SCRIPT;
    }
    if synth_sc && st & style::SMALLCAPS != 0 {
        i |= I_SYNTH_SC;
    }
    i
}

/// The "family" of full-width characters none of the theme's faces has: browsers set them
/// in a system CJK font, and every such font sets them on a square of one em.
const SYSTEM_WIDE: u8 = 255;

/// East Asian wide and full-width characters: ideographs, kana, Hangul, their punctuation.
fn wide(c: char) -> bool {
    matches!(c as u32,
        0x1100..=0x115F | 0x2E80..=0x303E | 0x3041..=0x33FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xA000..=0xA4CF
        | 0xAC00..=0xD7A3 | 0xF900..=0xFAFF | 0xFE30..=0xFE4F | 0xFF00..=0xFF60 | 0xFFE0..=0xFFE6 | 0x20000..=0x3FFFD)
}

/// Default-ignorable characters: drawn as nothing by browsers.
fn ignorable(c: char) -> bool {
    matches!(c, '\u{ad}' | '\u{34f}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}' | '\u{feff}')
}

/// Characters a renderer sets in whatever font the text around them uses.
fn neutral(c: char) -> bool {
    matches!(c, ' ' | '\u{a0}' | '\u{ad}' | '\u{200b}'..='\u{200d}' | '\u{2060}' | '\u{feff}')
}

impl Measurer {
    pub fn new(tf: &Typeface, typo: Typo, lang: &str) -> Measurer {
        let language: Option<Language> = lang.parse().ok();
        let synth_sc = !tf.families[0].smcp();
        let mut m = Measurer {
            tf: tf.clone(),
            typo,
            insts: FxHashMap::default(),
            cover: FxHashMap::default(),
            lang: language,
            cache: FxHashMap::default(),
            buf: Some(harfrust::Buffer::new()),
            synth_sc,
            size: typo.size,
            round: typo.round,
            space: 0.0,
            hyphen: 0.0,
        };
        m.space = m.width(" ", 0);
        m.hyphen = m.width("-", 0);
        m
    }

    /// The same faces and settings at another size.
    pub fn at_size(&self, size: f32) -> Measurer {
        let mut m = Measurer {
            tf: self.tf.clone(),
            typo: Typo { size, ..self.typo },
            insts: FxHashMap::default(),
            cover: FxHashMap::default(),
            lang: self.lang.clone(),
            cache: FxHashMap::default(),
            buf: Some(harfrust::Buffer::new()),
            synth_sc: self.synth_sc,
            size,
            round: self.round,
            space: 0.0,
            hyphen: 0.0,
        };
        m.space = m.width(" ", 0);
        m.hyphen = m.width("-", 0);
        m
    }

    fn inst(&mut self, fam: u8, bits: u8) -> &Inst {
        let (tf, typo, lang) = (&self.tf, &self.typo, &self.lang);
        self.insts.entry((fam, bits)).or_insert_with(|| {
            let mut px = typo.size;
            if bits & I_SCRIPT != 0 {
                px *= SCRIPT_SCALE;
            }
            let mut w = if bits & I_BOLD != 0 { typo.bold } else { typo.wght };
            if bits & I_SYNTH_SC != 0 {
                px *= SC_SCALE;
                w += SC_WGHT;
            }
            let family = &tf.families[fam as usize];
            let file = family.pick(bits & I_ITALIC != 0, w).or_else(|| family.files.first()).expect("a family with no files");
            let mut vars: Vec<(Tag, f32)> = vec![(Tag::new(b"opsz"), opsz(px)), (Tag::new(b"wght"), w.clamp(file.wmin, file.wmax))];
            for &(t, v) in &typo.axes {
                if t != 0 {
                    vars.push((Tag::from_u32(t), v));
                }
            }
            let font = file.font.instance_builder().variations(vars).build();
            // a font that asks for whole-pixel sizes is drawn at one by renderers that also
            // round advances (FreeType); its advances scale from that size
            if typo.round && file.int_ppem {
                px = px.round().max(1.0);
            }
            let spaced = typo.ls != 0.0;
            let plan = ShapePlan::new(&font, Direction::LeftToRight, Some(Script::LATIN), lang.as_ref(), &features(false, spaced));
            let plan_sc = ShapePlan::new(&font, Direction::LeftToRight, Some(Script::LATIN), lang.as_ref(), &features(true, spaced));
            let scale = px / font.units_per_em() as f32;
            Inst { font, plan, plan_sc, scale }
        })
    }

    /// The family that sets `c`: the first in the chain whose file for this style maps it.
    fn family_for(&mut self, italic: bool, c: char) -> u8 {
        if let Some(&f) = self.cover.get(&(italic, c)) {
            return f;
        }
        let w = self.typo.wght;
        let f = match self.tf.families.iter().position(|fam| fam.pick(italic, w).is_some_and(|f| f.covers(c))) {
            Some(i) => i as u8,
            // no face has it: a full-width character goes to the system's CJK font
            None if wide(c) => SYSTEM_WIDE,
            None => 0,
        };
        self.cover.insert((italic, c), f);
        f
    }

    /// Advance width of `text` in `style`, in px, letter and word spacing included.
    pub fn width(&mut self, text: &str, st: u8) -> f32 {
        if text.is_empty() {
            return 0.0;
        }
        let mut h = rustc_hash::FxHasher::default();
        st.hash(&mut h);
        text.hash(&mut h);
        let key = h.finish();
        if let Some(&w) = self.cache.get(&key) {
            return w;
        }
        let w = self.measure(text, st);
        self.cache.insert(key, w);
        w
    }

    fn measure(&mut self, text: &str, st: u8) -> f32 {
        // characters a browser never draws take no room (and are never shaped as a missing
        // glyph): zero-width spaces and joiners, the BOM, soft hyphens away from a break
        let visible;
        let text = if text.chars().any(ignorable) {
            visible = text.chars().filter(|&c| !ignorable(c)).collect::<String>();
            if visible.is_empty() {
                return 0.0;
            }
            visible.as_str()
        } else {
            text
        };
        let bits = style_bits(st, self.synth_sc);
        let upper;
        let text = if bits & I_SYNTH_SC != 0 {
            upper = text.to_uppercase();
            upper.as_str()
        } else {
            text
        };
        let italic = bits & I_ITALIC != 0;
        // split into runs by the family that sets each character
        let mut w = 0.0;
        let mut clusters = 0usize;
        let mut run_start = 0usize;
        let mut run_fam: Option<u8> = None;
        for (i, c) in text.char_indices() {
            if neutral(c) && run_fam.is_some() {
                continue;
            }
            let f = self.family_for(italic, c);
            match run_fam {
                Some(rf) if rf != f => {
                    let (rw, rc) = self.shape(&text[run_start..i], rf, bits, st);
                    w += rw;
                    clusters += rc;
                    run_start = i;
                    run_fam = Some(f);
                }
                None => run_fam = Some(f),
                _ => {}
            }
        }
        let (rw, rc) = self.shape(&text[run_start..], run_fam.unwrap_or(0), bits, st);
        w += rw;
        clusters += rc;
        let mut ls = self.typo.ls;
        if bits & I_SYNTH_SC != 0 {
            ls += SC_TRACK * SC_SCALE * self.typo.size * if bits & I_SCRIPT != 0 { SCRIPT_SCALE } else { 1.0 };
        }
        let spaces = text.chars().filter(|&c| c == ' ' || c == '\u{a0}').count();
        w + ls * clusters as f32 + self.typo.ws * spaces as f32
    }

    /// Width and cluster count of one run in one family.
    fn shape(&mut self, text: &str, fam: u8, bits: u8, st: u8) -> (f32, usize) {
        if fam == SYSTEM_WIDE {
            let mut px = self.typo.size;
            if bits & I_SCRIPT != 0 {
                px *= SCRIPT_SCALE;
            }
            if bits & I_SYNTH_SC != 0 {
                px *= SC_SCALE;
            }
            let em = if self.round { px.round() } else if self.typo.app_units { (px * 60.0).round() / 60.0 } else { px };
            let n = text.chars().count();
            return (em * n as f32, n);
        }
        let round = self.round;
        let app_units = self.typo.app_units;
        let lang = self.lang.clone();
        let mut buf = self.buf.take().unwrap_or_default();
        let inst = self.inst(fam, bits);
        let sc = st & style::SMALLCAPS != 0 && bits & I_SYNTH_SC == 0;
        let shaper = ShaperFont::new(&inst.font);
        buf.clear();
        buf.push_str(text);
        buf.set_direction(Direction::LeftToRight);
        buf.set_script(Some(Script::LATIN));
        buf.set_language(lang);
        let plan = if sc { &inst.plan_sc } else { &inst.plan };
        let out = match harfrust::shape(&shaper, &mut buf, ShapeOptions::new().plan(Some(plan))) {
            Ok(()) => {
                let infos = buf.glyph_infos();
                let mut clusters = 0usize;
                let mut last = u32::MAX;
                for gi in infos {
                    if gi.cluster != last {
                        clusters += 1;
                        last = gi.cluster;
                    }
                }
                // the glyph's own advance (at this instance's location) and its kerning
                // adjustment are each rounded to whole px, as Chromium on Linux draws them
                let w = if round {
                    let gm = inst.font.glyph_metrics();
                    let mut w = 0.0f32;
                    for (gi, gp) in infos.iter().zip(buf.glyph_positions()) {
                        let base = gm.h_advance(harfrust::GlyphId::new(gi.glyph_id));
                        w += px26(base * inst.scale).round() + ((gp.x_advance as f32 - base) * inst.scale).round();
                    }
                    w
                } else if app_units {
                    // each glyph's advance (kerning included) in whole 1/60 px, as Firefox
                    buf.glyph_positions().iter().map(|p| (p.x_advance as f32 * inst.scale * 60.0).round()).sum::<f32>() / 60.0
                } else {
                    buf.glyph_positions().iter().map(|p| p.x_advance as f32).sum::<f32>() * inst.scale
                };
                (w, clusters)
            }
            Err(_) => (0.0, 0),
        };
        self.buf = Some(buf);
        out
    }

    /// The character is set in a font none of the theme's faces is (a system CJK font): what
    /// that font does to the space after it is unknowable here.
    pub fn system_set(&mut self, c: char, italic: bool) -> bool {
        self.family_for(italic, c) == SYSTEM_WIDE
    }

    /// Kerning across a word space: between the character before it and the space, and
    /// the space and the character after (each only within one style run, as a browser
    /// shapes). Zero for faces that do not kern with the space.
    pub fn space_kern(&mut self, lc: char, sl: u8, ss: u8, rc: char, sr: u8) -> f32 {
        let mode = self.typo.space_kern;
        if mode == 0 {
            return 0.0;
        }
        let mut k = 0.0;
        let mut a = [0u8; 4];
        let mut b = [0u8; 4];
        if sl == ss {
            let l: &str = lc.encode_utf8(&mut a);
            k += self.width(&format!("{l} "), sl) - self.width(l, sl) - self.width(" ", sl);
        }
        if mode == 2 && ss == sr {
            let r: &str = rc.encode_utf8(&mut b);
            k += self.width(&format!(" {r}"), sr) - self.width(" ", sr) - self.width(r, sr);
        }
        k
    }

    pub fn cached(&self) -> usize {
        self.cache.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(n: &str) -> Vec<u8> {
        std::fs::read(format!("{}/../../assets/fonts/{n}", env!("CARGO_MANIFEST_DIR"))).unwrap()
    }
    fn fam(files: &[&str]) -> Arc<Family> {
        Arc::new(Family::of(files.iter().map(|f| read(f)).collect()))
    }

    #[test]
    fn static_family_matches_like_css() {
        let f = fam(&["Charis-Regular.ttf", "Charis-Medium.ttf", "Charis-SemiBold.ttf", "Charis-Bold.ttf", "Charis-Italic.ttf"]);
        let w = |it: bool, w: f32| f.pick(it, w).map(|x| (x.wmin, x.italic)).unwrap();
        assert_eq!(w(false, 400.0), (400.0, false));
        assert_eq!(w(false, 450.0), (500.0, false)); // 400–500: the nearest heavier up to 500
        assert_eq!(w(false, 650.0), (700.0, false)); // above 500: heavier first
        assert_eq!(w(false, 350.0), (400.0, false)); // below 400: lighter first, else heavier
        assert_eq!(w(true, 700.0), (400.0, true)); // italic text keeps to the italic files
        assert!(f.smcp());
    }

    #[test]
    fn fallback_sets_missing_characters_in_the_next_family() {
        // (bundled faces come as a core file and an extension, chained as the page picks
        // between them: Cyrillic is in Literata's extension)
        let tf = Typeface::new(vec![fam(&["Newsreader.ttf"]), fam(&["Newsreader.ext.ttf"]), fam(&["Literata.ttf"]), fam(&["Literata.ext.ttf"])]).unwrap();
        let mut m = Measurer::new(&tf, Typo::plain(20.0, false), "en");
        assert_eq!(m.family_for(false, 'a'), 0);
        assert_eq!(m.family_for(false, 'Ж'), 3);
        let lit = Typeface::new(vec![fam(&["Literata.ttf"]), fam(&["Literata.ext.ttf"])]).unwrap();
        let mut l = Measurer::new(&lit, Typo::plain(20.0, false), "en");
        // Cyrillic measured in Literata either way
        assert!((m.width("Жизнь", 0) - l.width("Жизнь", 0)).abs() < 0.01);
        assert!((m.width("Kiev", 0) - l.width("Kiev", 0)).abs() > 0.1);
        // Newsreader kerns across the space; only when the renderer does
        assert_eq!(m.space_kern('T', 0, 0, 'A', 0), 0.0);
        let mut k = Measurer::new(&tf, Typo { space_kern: 2, ..Typo::plain(20.0, false) }, "en");
        let mut k1 = Measurer::new(&tf, Typo { space_kern: 1, ..Typo::plain(20.0, false) }, "en");
        assert!(k.space_kern('T', 0, 0, 'A', 0) < -1.0);
        assert!(k1.space_kern('T', 0, 0, 'A', 0) > k.space_kern('T', 0, 0, 'A', 0) && k1.space_kern('T', 0, 0, 'A', 0) < -0.4);
        assert_eq!(l.space_kern('T', 0, 0, 'A', 0), 0.0);
    }

    #[test]
    fn spacing_and_synthesised_small_caps() {
        let tf = Typeface::single(vec![read("Fraunces.ttf")]).unwrap();
        let mut a = Measurer::new(&tf, Typo::plain(20.0, false), "en");
        let mut b = Measurer::new(&tf, Typo { ls: 1.0, ws: 3.0, ..Typo::plain(20.0, false) }, "en");
        // every character gains the letter spacing (ligatures are off when spaced)
        let plain: f32 = "office".chars().map(|c| a.width(&c.to_string(), 0)).sum();
        assert!((b.width("office", 0) - (plain + 6.0)).abs() < 0.6, "{} vs {}", b.width("office", 0), plain + 6.0);
        assert!((b.space - (a.space + 4.0)).abs() < 0.01);
        assert!(a.synth_sc);
        // synthesised small caps: capitals at 0.78 of the size, tracked
        let sc = a.width("Paris", style::SMALLCAPS);
        assert!(sc > a.width("Paris", 0) && sc < a.width("PARIS", 0) * 1.1, "{sc}");
        // what browsers never draw takes no room
        assert_eq!(a.width("stone\u{feff}", 0), a.width("stone", 0));
        assert_eq!(a.width("\u{2060}\u{200b}", 0), 0.0);
    }
}

/// The monospaced face preformatted text is set in, measured at whatever size each block
/// needs (one measurer per size, kept).
#[derive(Default)]
pub struct Mono {
    tf: Option<Typeface>,
    sizes: FxHashMap<(u32, bool, bool), Measurer>,
}

impl Mono {
    pub fn new(tf: Option<Typeface>) -> Mono {
        Mono { tf, sizes: FxHashMap::default() }
    }

    pub fn typeface(&self) -> Option<&Typeface> {
        self.tf.as_ref()
    }

    /// Width of `text` at `size`; None without the face (then the theme's face measures).
    pub fn width(&mut self, size: f32, round: bool, app_units: bool, text: &str) -> Option<f32> {
        let tf = self.tf.as_ref()?;
        let m = self.sizes.entry((size.to_bits(), round, app_units)).or_insert_with(|| Measurer::new(tf, Typo { app_units, ..Typo::plain(size, round) }, "en"));
        Some(m.width(text, 0))
    }
}
