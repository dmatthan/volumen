//! Paragraph breaking: Knuth–Plass over boxes, glue and penalties.
//!
//! Pass 1 breaks without hyphenation at a tight tolerance; pass 2 adds hyphenation and
//! loosens; pass 3 is a first-fit that never fails (overfull lines are allowed only
//! when a single word is wider than the measure).

use crate::hyph::Patterns;
use crate::shape::Measurer;
use unicode_linebreak::{BreakOpportunity, linebreaks};

const INF: f32 = 10_000.0;
const FILL: f32 = 1.0e6;
const LINE_PENALTY: f64 = 10.0;
/// High on purpose: Literata's word space is narrow (0.2 em), so with TeX's usual 50 the
/// breaker hyphenated 16% of lines. At 1500 it is about 6% (Middlemarch, 30.5 em
/// measure), with the median word space stretched by 29%.
const HYPHEN_PENALTY: f32 = 1500.0;
const EXPLICIT_HYPHEN_PENALTY: f32 = 50.0;
const DOUBLE_HYPHEN_DEMERITS: f64 = 3000.0;
const FINAL_HYPHEN_DEMERITS: f64 = 5000.0;
const FITNESS_DEMERITS: f64 = 100.0;

#[derive(Clone, Copy, Debug)]
enum K {
    Box,
    Glue { y: f32, z: f32 },
    /// A possible break. `post` is width the next line gains if the break is taken (the
    /// start of a hyphenated word, drawn on its own).
    Pen { p: f32, flag: bool, post: f32 },
}

#[derive(Clone, Copy, Debug)]
struct Item {
    k: K,
    w: f32,
    /// Byte range of the text this item covers.
    s: u32,
    e: u32,
}

impl Item {
    fn is_box(&self) -> bool {
        matches!(self.k, K::Box)
    }
}

/// How a paragraph should be set.
#[derive(Clone, Copy, Debug)]
pub struct Shape {
    /// Width available to the first line and to the rest, in px.
    pub first: f32,
    pub rest: f32,
    pub justify: bool,
    pub hyphenate: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Line {
    /// Byte range in the paragraph text, trailing space excluded.
    pub s: u32,
    pub e: u32,
    /// Ends in an inserted hyphen.
    pub hyph: bool,
    /// Natural width including any inserted hyphen, px.
    pub natural: f32,
    /// Inter-word spaces on the line.
    pub spaces: u16,
    /// Stretch it on render (all but the last line of a justified paragraph).
    pub justify: bool,
}

/// Style lookup over a paragraph's spans.
pub struct Spans<'a> {
    pub spans: &'a [(usize, usize, u8)],
}

impl Spans<'_> {
    /// Width of text[a..b], shaping each style piece on its own.
    pub fn width(&self, m: &mut Measurer, text: &str, a: usize, b: usize) -> f32 {
        let mut w = 0.0;
        for &(s, e, st) in self.spans {
            if e <= a {
                continue;
            }
            if s >= b {
                break;
            }
            w += m.width(&text[s.max(a)..e.min(b)], st);
        }
        w
    }

    fn style_at(&self, i: usize) -> u8 {
        self.spans.iter().find(|&&(s, e, _)| s <= i && i < e).map(|x| x.2).unwrap_or(0)
    }

    pub fn single_style(&self, a: usize, b: usize) -> Option<u8> {
        let mut found = None;
        for &(s, e, st) in self.spans {
            if e <= a || s >= b {
                continue;
            }
            if s > a || e < b {
                return None;
            }
            found = Some(st);
        }
        found
    }
}

fn items(m: &mut Measurer, text: &str, spans: &Spans, sh: &Shape, hyph: Option<&Patterns>, lang: Option<&Patterns>) -> Vec<Item> {
    let mut out: Vec<Item> = Vec::with_capacity(text.len() / 3);
    let space = m.space;
    // a renderer on whole pixels rounds negative word spacing too, so it cannot shrink
    // a line precisely: lines then only stretch
    let shrink = if m.round { 0.0 } else { space * 0.33 };
    let (y, z) = if sh.justify { (space * 0.5, shrink) } else { (0.0, 0.0) };
    let rag = space * 4.0;
    let mut prev = 0usize;
    // Some faces kern across the word space, and browsers then shape the whole run. That
    // kerning belongs to the space's glue: it vanishes with the glue at a line break, as
    // the space does. (glue item, last character before the space, its style, the space's)
    let mut pending: Option<(usize, char, u8, u8)> = None;
    for (idx, op) in linebreaks(text) {
        let seg = &text[prev..idx];
        // only ASCII spaces are word spaces; a thin or non-breaking space is part of the word
        let content_len = seg.trim_end_matches([' ', '\t', '\n', '\r', '\u{2028}']).len();
        let (cs, ce) = (prev, prev + content_len);
        if ce > cs {
            if let (Some((gi, lc, sl, ss)), Some(rc)) = (pending.take(), text[cs..].chars().next()) {
                out[gi].w += m.space_kern(lc, sl, ss, rc, spans.style_at(cs));
                // and before it, the same (see below)
                if m.system_set(rc, spans.style_at(cs) & vol_model::style::ITALIC != 0) && !m.system_set(lc, sl & vol_model::style::ITALIC != 0) {
                    out[gi].w += m.size * 0.05;
                }
            }
            push_word(&mut out, m, text, spans, cs, ce, hyph, lang, sh.first.min(sh.rest));
        }
        let has_space = ce < idx && text[ce..idx].contains([' ', '\t']);
        let forced = op == BreakOpportunity::Mandatory;
        pending = None;
        if forced {
            out.push(Item { k: K::Glue { y: FILL, z: 0.0 }, w: 0.0, s: ce as u32, e: idx as u32 });
            out.push(Item { k: K::Pen { p: -INF, flag: false, post: 0.0 }, w: 0.0, s: ce as u32, e: idx as u32 });
        } else if has_space {
            if sh.justify {
                out.push(Item { k: K::Glue { y, z }, w: space, s: ce as u32, e: idx as u32 });
            } else {
                // ragged right: the line's stretch lives only at its end
                out.push(Item { k: K::Glue { y: rag, z: 0.0 }, w: 0.0, s: ce as u32, e: ce as u32 });
                out.push(Item { k: K::Pen { p: 0.0, flag: false, post: 0.0 }, w: 0.0, s: ce as u32, e: ce as u32 });
                out.push(Item { k: K::Glue { y: -rag, z: 0.0 }, w: space, s: ce as u32, e: idx as u32 });
            }
            if let Some(lc) = text[cs..ce].chars().last() {
                pending = Some((out.len() - 1, lc, spans.style_at(ce - lc.len_utf8()), spans.style_at(ce)));
                // after text set in a system fallback font (CJK), the browser may set the space
                // and what follows it in that font, whose widths are unknowable here: allow for it
                if m.system_set(lc, spans.style_at(ce - lc.len_utf8()) & vol_model::style::ITALIC != 0) {
                    let i = out.len() - 1;
                    out[i].w += m.size * 0.05;
                }
            }
        } else if ce > cs {
            // break after a hyphen or dash with no space
            let explicit = text[cs..ce].ends_with(['-', '\u{2010}']);
            let p = if explicit { EXPLICIT_HYPHEN_PENALTY } else { 0.0 };
            out.push(Item { k: K::Pen { p, flag: explicit, post: 0.0 }, w: 0.0, s: ce as u32, e: ce as u32 });
        }
        prev = idx;
    }
    out
}

/// Penalty of a break inside a word too wide for any line: allowed, never preferred.
const EMERGENCY_PENALTY: f32 = 3000.0;

/// Where `word` may be hyphenated (byte offsets into it), if anywhere: its alphabetic core,
/// one style, at least six letters, no capitals after the first.
pub(crate) fn syllable_cuts(word: &str, lang: &Patterns) -> Vec<usize> {
    if word.len() < 6 {
        return Vec::new();
    }
    // punctuation stays attached to the ends
    let core_s = word.find(|c: char| c.is_alphabetic()).unwrap_or(word.len());
    let core_e = word.rfind(|c: char| c.is_alphabetic()).map(|i| i + word[i..].chars().next().unwrap().len_utf8()).unwrap_or(0);
    let core = if core_e > core_s { &word[core_s..core_e] } else { "" };
    if core.chars().count() < 6 || !core.chars().all(char::is_alphabetic) || core.chars().skip(1).any(char::is_uppercase) {
        return Vec::new();
    }
    let syll: Vec<&str> = lang.syllables(core, 2, 3);
    let mut at = core_s;
    syll[..syll.len().saturating_sub(1)]
        .iter()
        .map(|s| {
            at += s.len();
            at
        })
        .collect()
}

/// A word as boxes with the breaks it allows between them. Normally that is its hyphenation
/// points (with `hyph`); a word wider than any line (a long compound, a rule of dashes, a
/// URL) breaks at its hyphens (with `lang`, even where hyphenation is otherwise off) if
/// they are enough, and otherwise also between any two of its characters without a
/// hyphen, never preferred, so no line is ever wider than its measure.
#[allow(clippy::too_many_arguments)]
fn push_word(out: &mut Vec<Item>, m: &mut Measurer, text: &str, spans: &Spans, cs: usize, ce: usize, hyph: Option<&Patterns>, lang: Option<&Patterns>, limit: f32) {
    let full = spans.width(m, text, cs, ce);
    let word = &text[cs..ce];
    let over = full > limit;
    let single = spans.single_style(cs, ce).is_some();
    let syl_lang = if over { hyph.or(lang) } else { hyph };
    let syl: Vec<usize> = match syl_lang {
        Some(l) if single => syllable_cuts(word, l).into_iter().map(|c| cs + c).collect(),
        _ => Vec::new(),
    };
    // a word too wide that its hyphens can set breaks only at them; one they cannot also
    // breaks anywhere, never preferred. (offset, with a hyphen)
    let syllables_do = over && !syl.is_empty() && {
        let mut a = cs;
        let mut ok = true;
        for (i, &c) in syl.iter().chain(std::iter::once(&ce)).enumerate() {
            let hyphen = if i < syl.len() { m.hyphen } else { 0.0 };
            ok &= spans.width(m, text, a, c) + hyphen <= limit;
            a = c;
        }
        ok
    };
    let cuts: Vec<(usize, bool)> = if over && !syllables_do {
        word.char_indices().skip(1).filter(|&(_, c)| !combining(c)).map(|(i, _)| (cs + i, syl.contains(&(cs + i)))).collect()
    } else {
        syl.iter().map(|&c| (c, true)).collect()
    };
    if cuts.is_empty() {
        out.push(Item { k: K::Box, w: full, s: cs as u32, e: ce as u32 });
        return;
    }
    let mut pieces: Vec<(usize, usize, f32)> = Vec::with_capacity(cuts.len() + 1);
    let mut a = cs;
    for c in cuts.iter().map(|c| c.0).chain(std::iter::once(ce)) {
        pieces.push((a, c, spans.width(m, text, a, c)));
        a = c;
    }
    // scale pieces so they sum to the whole word (kerning and ligatures across cuts)
    let sum: f32 = pieces.iter().map(|p| p.2).sum();
    let k = if sum > 0.0 { full / sum } else { 1.0 };
    // At a break the browser draws the word's two parts each on its own, so their widths
    // differ from their shares of the whole word (kerning and ligatures across the cut, and
    // rounding): the break carries both corrections, which count only if it is taken.
    let hw = m.hyphen;
    let mut scaled_prefix = 0.0;
    for (i, &(a, b, w)) in pieces.iter().enumerate() {
        if i > 0 {
            let pre = spans.width(m, text, cs, a) - scaled_prefix;
            let post = spans.width(m, text, a, ce) - (full - scaled_prefix);
            let hyphen = cuts[i - 1].1;
            let (p, w) = if hyphen { (HYPHEN_PENALTY, hw + pre) } else { (EMERGENCY_PENALTY, pre) };
            out.push(Item { k: K::Pen { p, flag: hyphen, post }, w, s: a as u32, e: a as u32 });
        }
        out.push(Item { k: K::Box, w: w * k, s: a as u32, e: b as u32 });
        scaled_prefix += w * k;
    }
}

/// Combining marks stay with the character before them.
fn combining(c: char) -> bool {
    matches!(c as u32, 0x300..=0x36F | 0x1AB0..=0x1AFF | 0x1DC0..=0x1DFF | 0x20D0..=0x20FF | 0xFE20..=0xFE2F | 0xFE00..=0xFE0F | 0x200D)
}

#[derive(Clone, Copy)]
struct Node {
    /// Item index of the break; usize::MAX for the paragraph start.
    at: usize,
    line: u32,
    fit: u8,
    total: f64,
    prev: u32,
    hyph: bool,
    /// Width the line after this break starts with beyond its items (see `K::Pen::post`).
    post: f32,
}

struct Sums {
    w: Vec<f32>,
    y: Vec<f32>,
    z: Vec<f32>,
}

fn sums(its: &[Item]) -> Sums {
    let n = its.len();
    let (mut w, mut y, mut z) = (Vec::with_capacity(n + 1), Vec::with_capacity(n + 1), Vec::with_capacity(n + 1));
    let (mut a, mut b, mut c) = (0.0f32, 0.0f32, 0.0f32);
    for it in its {
        w.push(a);
        y.push(b);
        z.push(c);
        match it.k {
            K::Box => a += it.w,
            K::Glue { y: gy, z: gz } => {
                a += it.w;
                b += gy;
                c += gz;
            }
            K::Pen { .. } => {}
        }
    }
    w.push(a);
    y.push(b);
    z.push(c);
    Sums { w, y, z }
}

/// First item index of a line that follows a break at `at`: discardables are skipped.
fn line_start(its: &[Item], at: usize) -> usize {
    let mut i = if at == usize::MAX { 0 } else { at + 1 };
    while i < its.len() && !its[i].is_box() {
        if let K::Pen { p, .. } = its[i].k {
            if p <= -INF {
                break;
            }
        }
        i += 1;
    }
    i
}

fn knuth_plass(its: &[Item], sh: &Shape, tolerance: f64) -> Option<Vec<usize>> {
    let sm = sums(its);
    let width = |line: u32| if line == 0 { sh.first } else { sh.rest };
    let mut nodes: Vec<Node> = vec![Node { at: usize::MAX, line: 0, fit: 1, total: 0.0, prev: u32::MAX, hyph: false, post: 0.0 }];
    let mut active: Vec<u32> = vec![0];
    let mut starts: Vec<usize> = vec![line_start(its, usize::MAX)];
    for b in 0..its.len() {
        let (pw, pp, flag, post) = match its[b].k {
            K::Pen { p, flag, post } if p < INF => (its[b].w, p, flag, post),
            K::Glue { .. } if b > 0 && its[b - 1].is_box() => (0.0, 0.0, false, 0.0),
            _ => continue,
        };
        let forced = pp <= -INF;
        let mut best: [Option<(f64, u32)>; 4] = [None; 4];
        let mut i = 0;
        while i < active.len() {
            let a = active[i] as usize;
            let st = starts[i];
            let node = nodes[a];
            let w = sm.w[b] - sm.w[st] + pw + node.post;
            let l = width(node.line);
            let r = if w < l {
                let y = sm.y[b] - sm.y[st];
                if y > 0.0 { ((l - w) / y) as f64 } else { INF as f64 }
            } else if w > l {
                let z = sm.z[b] - sm.z[st];
                if z > 0.0 { ((l - w) / z) as f64 } else { -INF as f64 }
            } else {
                0.0
            };
            if r < -1.0 || forced {
                active.swap_remove(i);
                starts.swap_remove(i);
            } else {
                i += 1;
            }
            if r < -1.0 {
                continue;
            }
            let bad = if r >= INF as f64 { INF as f64 } else { 100.0 * r.abs().powi(3) };
            if bad > tolerance && !(forced && r >= 0.0) {
                continue;
            }
            let bad = bad.min(INF as f64);
            let mut d = (LINE_PENALTY + bad).powi(2);
            if pp >= 0.0 {
                d += (pp as f64).powi(2);
            } else if pp > -INF {
                d -= (pp as f64).powi(2);
            }
            if flag && node.hyph {
                d += DOUBLE_HYPHEN_DEMERITS;
            }
            if forced && node.hyph {
                d += FINAL_HYPHEN_DEMERITS;
            }
            let fit = if r < -0.5 { 0 } else if r <= 0.5 { 1 } else if r <= 1.0 { 2 } else { 3 };
            if (fit as i32 - node.fit as i32).abs() > 1 {
                d += FITNESS_DEMERITS;
            }
            let total = node.total + d;
            if best[fit as usize].is_none_or(|(t, _)| total < t) {
                best[fit as usize] = Some((total, a as u32));
            }
        }
        for (fit, bst) in best.iter().enumerate() {
            if let Some((total, a)) = *bst {
                let line = nodes[a as usize].line + 1;
                nodes.push(Node { at: b, line, fit: fit as u8, total, prev: a, hyph: flag, post });
                active.push((nodes.len() - 1) as u32);
                starts.push(line_start(its, b));
            }
        }
        if active.is_empty() {
            return None;
        }
    }
    // the last forced break ends the paragraph; take its best node
    let end = its.len() - 1;
    let best = nodes.iter().enumerate().filter(|(_, n)| n.at == end).min_by(|a, b| a.1.total.total_cmp(&b.1.total))?.0;
    let mut out = Vec::new();
    let mut n = best as u32;
    while n != 0 && n != u32::MAX {
        out.push(nodes[n as usize].at);
        n = nodes[n as usize].prev;
    }
    out.reverse();
    Some(out)
}

/// Greedy first fit: always succeeds.
fn first_fit(its: &[Item], sh: &Shape) -> Vec<usize> {
    let sm = sums(its);
    let mut out = Vec::new();
    let mut st = line_start(its, usize::MAX);
    let mut line = 0u32;
    let mut last_ok: Option<usize> = None;
    let mut post = 0.0f32;
    let post_of = |i: usize| if let K::Pen { post, .. } = its[i].k { post } else { 0.0 };
    let mut b = 0;
    while b < its.len() {
        let (pw, forced, legal) = match its[b].k {
            K::Pen { p, .. } => (its[b].w, p <= -INF, p < INF),
            K::Glue { .. } => (0.0, false, b > 0 && its[b - 1].is_box()),
            K::Box => (0.0, false, false),
        };
        if legal {
            let l = if line == 0 { sh.first } else { sh.rest };
            let w = sm.w[b] - sm.w[st] + pw + post;
            let z = sm.z[b] - sm.z[st];
            if w - z > l && last_ok.is_some() {
                let k = last_ok.take().unwrap();
                out.push(k);
                post = post_of(k);
                st = line_start(its, k);
                line += 1;
                b = k + 1;
                continue;
            }
            if forced {
                out.push(b);
                st = line_start(its, b);
                line += 1;
                last_ok = None;
            } else {
                last_ok = Some(b);
            }
        }
        b += 1;
    }
    out
}

/// Breaks one paragraph of `text` into lines.
pub fn break_lines(m: &mut Measurer, text: &str, spans: &[(usize, usize, u8)], sh: &Shape, lang: Option<&Patterns>) -> Vec<Line> {
    let sp = Spans { spans };
    if text.trim().is_empty() {
        return Vec::new();
    }
    let its = items(m, text, &sp, sh, None, lang);
    let tol1 = if sh.justify { 400.0 } else { 1000.0 };
    let (its, brks) = match knuth_plass(&its, sh, tol1) {
        Some(b) => (its, b),
        None => {
            let hy = if sh.hyphenate { lang } else { None };
            let its2 = if hy.is_some() { items(m, text, &sp, sh, hy, lang) } else { its };
            match knuth_plass(&its2, sh, if sh.justify { 2000.0 } else { 5000.0 }) {
                Some(b) => (its2, b),
                None => {
                    let b = first_fit(&its2, sh);
                    (its2, b)
                }
            }
        }
    };
    let mut lines = Vec::with_capacity(brks.len());
    let mut prev = usize::MAX;
    for (li, &b) in brks.iter().enumerate() {
        let st = line_start(&its, prev);
        let mut natural = if prev == usize::MAX { 0.0 } else if let K::Pen { post, .. } = its[prev].k { post } else { 0.0 };
        let mut spaces = 0u16;
        let (mut s, mut e) = (u32::MAX, 0u32);
        // trailing glue before a break is not part of the line
        let mut last_box = st;
        for i in st..b.min(its.len()) {
            if its[i].is_box() {
                last_box = i;
            }
        }
        for i in st..=last_box.min(its.len().saturating_sub(1)) {
            let it = &its[i];
            match it.k {
                K::Box => {
                    natural += it.w;
                    s = s.min(it.s);
                    e = e.max(it.e);
                }
                K::Glue { .. } => {
                    if it.w > 0.0 {
                        natural += it.w;
                        spaces += 1;
                    }
                }
                K::Pen { .. } => {}
            }
        }
        let hyph = matches!(its[b].k, K::Pen { flag: true, .. }) && its[b].w > 0.0;
        if hyph {
            natural += its[b].w;
        }
        let forced = matches!(its[b].k, K::Pen { p, .. } if p <= -INF);
        if s == u32::MAX {
            s = its.get(st).map(|i| i.s).unwrap_or(0);
            e = s;
        }
        lines.push(Line { s, e, hyph, natural, spaces, justify: sh.justify && !forced && li + 1 < brks.len() });
        prev = b;
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shape::{Measurer, Typeface, Typo};

    fn faces() -> Typeface {
        let d = concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/fonts/");
        Typeface::single(vec![std::fs::read(format!("{d}Literata.ttf")).unwrap(), std::fs::read(format!("{d}Literata-Italic.ttf")).unwrap()]).unwrap()
    }

    #[test]
    fn breaks_cover_text_and_fit() {
        let f = faces();
        let mut m = Measurer::new(&f, Typo::plain(19.0, false), "en");
        let text = "The suburb of Saffron Park lay on the sunset side of London, as red and ragged as a cloud of sunset. It was built of a bright brick throughout; its sky-line was fantastic, and even its ground plan was wild. It had been the outburst of a speculative builder, faintly tinged with art, who called its architecture sometimes Elizabethan and sometimes Queen Anne, apparently under the impression that the two sovereigns were identical.";
        let spans = [(0, text.len(), 0u8)];
        let sh = Shape { first: 560.0 - 25.0, rest: 560.0, justify: true, hyphenate: true };
        let lines = break_lines(&mut m, text, &spans, &sh, Some(&crate::hyph::english()));
        assert!(lines.len() >= 5, "{}", lines.len());
        for (i, l) in lines.iter().enumerate() {
            let avail = if i == 0 { sh.first } else { sh.rest };
            // a line may shrink (natural > avail) by at most its shrinkability
            assert!(l.natural <= avail + l.spaces as f32 * m.space * 0.34 + 0.01, "line {i} overfull: {} > {avail}", l.natural);
            if l.justify {
                assert!(l.natural > avail * 0.85, "line {i} too loose: {}", l.natural);
            }
        }
        // lines tile the text
        let mut at = 0;
        for l in &lines {
            assert!(text[at as usize..l.s as usize].trim().is_empty());
            at = l.e;
        }
        assert_eq!(lines.last().unwrap().e as usize, text.len());
        assert!(!lines.last().unwrap().justify);
    }

    #[test]
    fn a_word_too_wide_breaks_at_its_hyphens_when_they_are_enough() {
        let f = faces();
        let mut m = Measurer::new(&f, Typo::plain(15.0, false), "en");
        let t = "Temperature";
        // hyphenation off for the paragraph: the word still takes its hyphens, not a cut
        // between any two letters
        let sh = Shape { first: 60.0, rest: 60.0, justify: false, hyphenate: false };
        let lines = break_lines(&mut m, t, &[(0, t.len(), 0)], &sh, Some(&crate::hyph::english()));
        assert!(lines.len() >= 2);
        assert!(lines[..lines.len() - 1].iter().all(|l| l.hyph), "{:?}", lines.iter().map(|l| &t[l.s as usize..l.e as usize]).collect::<Vec<_>>());
        assert!(lines.iter().all(|l| l.natural + if l.hyph { m.hyphen } else { 0.0 } <= 60.0));
    }

    #[test]
    fn a_word_wider_than_the_measure_breaks_inside() {
        let f = faces();
        let mut m = Measurer::new(&f, Typo::plain(19.0, false), "en");
        let text = "Before ——————————————————————————————————————————————————— after.";
        let spans = [(0, text.len(), 0u8)];
        let sh = Shape { first: 300.0, rest: 300.0, justify: true, hyphenate: true };
        let lines = break_lines(&mut m, text, &spans, &sh, Some(&crate::hyph::english()));
        assert!(lines.len() >= 3);
        for l in &lines {
            assert!(l.natural <= 300.0 + 0.01, "overfull: {}", l.natural);
        }
    }

    #[test]
    fn ragged_and_forced_lines() {
        let f = faces();
        let mut m = Measurer::new(&f, Typo::plain(19.0, false), "en");
        let text = "Since I can do no good because a woman,\nReach constantly at something that is near it.";
        let spans = [(0, text.len(), 0u8)];
        let sh = Shape { first: 500.0, rest: 470.0, justify: false, hyphenate: false };
        let lines = break_lines(&mut m, text, &spans, &sh, None);
        assert_eq!(lines.len(), 2);
        assert_eq!(&text[lines[0].s as usize..lines[0].e as usize], "Since I can do no good because a woman,");
    }
}
