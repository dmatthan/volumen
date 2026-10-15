//! Placing a note on a book: the same book, or a later draft of it. A note keeps where
//! it was (block key, UTF-16 offsets), the words it covers (`quote`) and a little on
//! either side (`prefix`, `suffix`), and optionally how far through the book it was
//! (`pos`, 0–1). In order, it is placed:
//!
//! 1. **same**: its words are where it says;
//! 2. **moved**: its words are found exactly (folded as find folds) elsewhere in its
//!    block, or anywhere in the book — the occurrence whose surroundings and position
//!    agree best;
//! 3. **changed**: the words were reworded; the stretch of a paragraph sharing most of
//!    its words, if it shares enough and clearly more than any other stretch;
//! 4. **lost**: nowhere. A note left unplaced is better than one put on the wrong words.

use crate::find::{fold_block, fold_str};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use vol_model::Book;

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Anchor {
    /// Block key, hex (as the reader's anchors name blocks).
    pub key: String,
    pub s: u32,
    pub e: u32,
    pub quote: String,
    #[serde(default)]
    pub prefix: String,
    #[serde(default)]
    pub suffix: String,
    /// How far through the book it was, by blocks (0–1), if known.
    #[serde(default)]
    pub pos: Option<f32>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum How {
    Same,
    Moved,
    Changed,
    Lost,
}

#[derive(Serialize, Clone, Debug)]
pub struct Placed {
    pub key: String,
    pub s: u32,
    pub e: u32,
    pub how: How,
}

struct Folded {
    key: u64,
    /// Index of the block in reading order.
    n: usize,
    /// Index among the blocks with text (its words in `Index::words`).
    w: usize,
    text: String,
    map: Vec<u32>,
}

/// A book made ready to place notes on: blocks by key, and (when first needed) every
/// block's folded text.
pub struct Anchorer<'a> {
    book: &'a Book,
    by_key: HashMap<u64, (usize, usize)>,
    total: usize,
    index: std::cell::OnceCell<Index>,
}

/// Every block's folded text and words, and for each word the blocks that have it.
struct Index {
    blocks: Vec<Folded>,
    words: Vec<Vec<(usize, usize)>>,
    postings: HashMap<String, Vec<u32>>,
}

/// How far the end of `a` agrees with the end of `b`, as a share of the shorter. Two
/// empty ends (both at a paragraph's edge) agree only by half: many paragraphs start
/// with the same word.
fn tail_agree(a: &str, b: &str) -> f32 {
    let n = a.chars().rev().zip(b.chars().rev()).take_while(|(x, y)| x == y).count();
    let len = a.chars().count().min(b.chars().count());
    // (a short context agrees for less: a few characters are weak evidence)
    if a.is_empty() && b.is_empty() { 0.5 } else if len == 0 { 0.0 } else { n as f32 / len.max(12) as f32 }
}
fn head_agree(a: &str, b: &str) -> f32 {
    let n = a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count();
    let len = a.chars().count().min(b.chars().count());
    if a.is_empty() && b.is_empty() { 0.5 } else if len == 0 { 0.0 } else { n as f32 / len.max(12) as f32 }
}

/// Context folded as the block text is, keeping a space at its start (folding alone
/// drops a leading space, but in the block the space is there before the context).
fn fold_ctx(s: &str) -> String {
    let f = fold_block(s).0;
    if s.starts_with(char::is_whitespace) { format!(" {f}") } else { f }
}

/// A quote this long is its own evidence; a shorter one needs its surroundings to agree.
const LONG: usize = 24;
/// Characters of context a note keeps either side (annotations.ts `CTX`): one with fewer
/// reached its paragraph's edge.
const EDGE: usize = 32;

/// Words of folded text, with their byte ranges.
fn words(t: &str) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = None;
    for (i, c) in t.char_indices() {
        if c.is_alphanumeric() {
            start.get_or_insert(i);
        } else if let Some(s) = start.take() {
            out.push((s, i));
        }
    }
    if let Some(s) = start {
        out.push((s, t.len()));
    }
    out
}

impl<'a> Anchorer<'a> {
    pub fn new(book: &'a Book) -> Anchorer<'a> {
        let mut by_key = HashMap::new();
        let mut total = 0;
        for (si, sec) in book.sections.iter().enumerate() {
            for (bi, b) in sec.blocks.iter().enumerate() {
                by_key.insert(b.key, (si, bi));
                total += 1;
            }
        }
        Anchorer { book, by_key, total: total.max(1), index: std::cell::OnceCell::new() }
    }

    fn index(&self) -> &Index {
        self.index.get_or_init(|| {
            let mut blocks = Vec::new();
            let mut n = 0;
            for sec in &self.book.sections {
                for b in &sec.blocks {
                    if !b.text.is_empty() {
                        let (text, map) = fold_block(&b.text);
                        blocks.push(Folded { key: b.key, n, w: blocks.len(), text, map });
                    }
                    n += 1;
                }
            }
            let words: Vec<Vec<(usize, usize)>> = blocks.iter().map(|f| words(&f.text)).collect();
            let mut postings: HashMap<String, Vec<u32>> = HashMap::new();
            for (bi, (f, ws)) in blocks.iter().zip(&words).enumerate() {
                for &(s, e) in ws {
                    let p = postings.entry(f.text[s..e].to_string()).or_default();
                    if p.last() != Some(&(bi as u32)) {
                        p.push(bi as u32);
                    }
                }
            }
            Index { blocks, words, postings }
        })
    }

    fn block_text(&self, key: u64) -> Option<&str> {
        let &(s, b) = self.by_key.get(&key)?;
        Some(&self.book.sections[s].blocks[b].text)
    }

    pub fn place(&self, a: &Anchor) -> Placed {
        let key = u64::from_str_radix(&a.key, 16).ok();
        let hex = |k: u64| format!("{k:016x}");
        let long = a.quote.chars().count() >= LONG;
        // 1. where it says — and, for a short quote, with its surroundings: in a later
        //    draft keys are by place, so another paragraph may now have this one's key
        if let Some(t) = key.and_then(|k| self.block_text(k)) {
            let u: Vec<u16> = t.encode_utf16().collect();
            if (a.e as usize) <= u.len() && a.s < a.e && String::from_utf16_lossy(&u[a.s as usize..a.e as usize]) == a.quote {
                let before = String::from_utf16_lossy(&u[..a.s as usize]);
                let after = String::from_utf16_lossy(&u[a.e as usize..]);
                // (by characters only: nothing near it may have changed for this shortcut;
                // otherwise the search below weighs every candidate)
                let ctx = tail_agree(&before, &a.prefix) + head_agree(&after, &a.suffix);
                if ctx >= if long { 1.2 } else { 1.8 } {
                    return Placed { key: a.key.clone(), s: a.s, e: a.e, how: How::Same };
                }
            }
        }
        let q = fold_str(&a.quote);
        if q.is_empty() {
            return Placed { key: a.key.clone(), s: a.s, e: a.e, how: How::Lost };
        }
        let pre = fold_ctx(&a.prefix);
        let suf = fold_ctx(&a.suffix);
        let ix = self.index();
        let blocks = &ix.blocks;
        let total = self.total as f32;
        let qw: Vec<&str> = words(&q).iter().map(|&(s, e)| &q[s..e]).collect();
        // how well an occurrence's surroundings agree with the note's (0–2): this decides
        // (the note's own context words, nearest the quote first, split once; the block's
        //  words are known by position, so nothing is split or allocated per candidate)
        let pick = |t: &str, before: bool| -> Vec<String> {
            let ws: Vec<&str> = t.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).collect();
            let it: Vec<&str> = if before { ws.iter().rev().take(5).copied().collect() } else { ws.iter().take(5).copied().collect() };
            it.into_iter().map(str::to_string).collect()
        };
        let (pre_w, suf_w) = (pick(&pre, true), pick(&suf, false));
        let agree_words = |f: &Folded, want: &[String], from: usize, before: bool| -> f32 {
            let ws = &ix.words[f.w];
            // six words of the block on that side of the quote
            let near: Vec<&str> = if before {
                let k = ws.partition_point(|w| w.1 <= from);
                ws[k.saturating_sub(6)..k].iter().rev().map(|&(s, e)| &f.text[s..e]).collect()
            } else {
                let k = ws.partition_point(|w| w.0 < from);
                ws[k..(k + 6).min(ws.len())].iter().map(|&(s, e)| &f.text[s..e]).collect()
            };
            if want.is_empty() {
                return if near.is_empty() { 0.5 } else { 0.0 };
            }
            let mut used = [false; 6];
            let mut m = 0;
            for w in want {
                if let Some(i) = near.iter().enumerate().position(|(i, h)| !used[i] && *h == w.as_str()) {
                    used[i] = true;
                    m += 1;
                }
            }
            m as f32 / want.len().max(3) as f32
        };
        // a context shorter than the context kept reached its paragraph's edge: the same
        // words, edge to edge, in another paragraph are whole agreement ("Oh!" said Syme.)
        let (pre_edge, suf_edge) = (!pre.is_empty() && a.prefix.chars().count() < EDGE, !suf.is_empty() && a.suffix.chars().count() < EDGE);
        let ctx = |f: &Folded, i: usize, j: usize| {
            let clip_b = &f.text[f.text.floor_char_boundary(i.saturating_sub(pre.len() + 8))..i];
            let clip_a = &f.text[j..f.text.ceil_char_boundary((j + suf.len() + 8).min(f.text.len()))];
            let b = if pre_edge && f.text[..i] == *pre { 1.0 } else { tail_agree(clip_b, &pre).max(agree_words(f, &pre_w, i, true)) };
            let e = if suf_edge && f.text[j..] == *suf { 1.0 } else { head_agree(clip_a, &suf).max(agree_words(f, &suf_w, j, false)) };
            b + e
        };
        // where it is: its old block, near its old place (0–2): this only breaks ties
        let place = |f: &Folded| {
            let mut p = if key == Some(f.key) { 1.0 } else { 0.0 };
            if let Some(at) = a.pos {
                p += 1.0 - ((f.n as f32 / total) - at).abs().min(1.0);
            }
            p
        };
        // 2. exactly, in its block or anywhere: only blocks with its rarest word can have
        //    it (a quote is whole words; if that finds nothing, every block is looked at)
        let rare = qw.iter().filter_map(|w| ix.postings.get(*w)).min_by_key(|p| p.len());
        let look: Vec<&Folded> = match rare {
            Some(p) if !qw.is_empty() => p.iter().map(|&b| &blocks[b as usize]).collect(),
            _ => blocks.iter().collect(),
        };
        let mut best: Option<(f32, f32, &Folded, usize, usize)> = None;
        let mut count = 0;
        let starts_word = q.chars().next().is_some_and(char::is_alphanumeric);
        let ends_word = q.chars().next_back().is_some_and(char::is_alphanumeric);
        for f in look {
            // (a quote is whole words: "a" is the word, not every letter a)
            let at_edge = |i: usize, j: usize| {
                (!starts_word || !f.text[..i].chars().next_back().is_some_and(char::is_alphanumeric))
                    && (!ends_word || !f.text[j..].chars().next().is_some_and(char::is_alphanumeric))
            };
            for (i, _) in f.text.match_indices(q.as_str()).filter(|&(i, _)| at_edge(i, i + q.len())) {
                count += 1;
                let c = ctx(f, i, i + q.len());
                let rank = c * 2.0 + place(f);
                if best.is_none_or(|b| rank > b.0) {
                    best = Some((rank, c, f, i, i + q.len()));
                }
            }
        }
        if let Some((_, c, f, i, j)) = best {
            // found once and long enough to be itself, or its surroundings agree (its old
            // key is no evidence here: in a later draft it may name another paragraph)
            let tiny = q.chars().count() < 4;
            if (count == 1 && long) || c >= if long { 0.6 } else if tiny { 1.5 } else { 1.2 } {
                return Placed { key: hex(f.key), s: f.map[i], e: f.map[j], how: How::Moved };
            }
        }
        // 3. reworded: the window of a block's words sharing most of the quote's
        let n = qw.len();
        if n < 3 {
            return Placed { key: a.key.clone(), s: a.s, e: a.e, how: How::Lost };
        }
        // the quote's distinct words, and how often each is wanted
        let mut distinct: Vec<&str> = Vec::new();
        let mut need: Vec<i32> = Vec::new();
        for w in &qw {
            match distinct.iter().position(|d| d == w) {
                Some(i) => need[i] += 1,
                None => {
                    distinct.push(w);
                    need.push(1);
                }
            }
        }
        // blocks that have enough of its distinct words at all
        let mut hits: HashMap<u32, usize> = HashMap::new();
        for w in &distinct {
            for &b in ix.postings.get(*w).map(Vec::as_slice).unwrap_or(&[]) {
                *hits.entry(b).or_insert(0) += 1;
            }
        }
        let floor = (distinct.len() as f32 * 0.6).ceil() as usize;
        let mut cands: Vec<(f32, &Folded, usize, usize)> = Vec::new();
        for (&b, &h) in &hits {
            if h < floor {
                continue;
            }
            let f = &blocks[b as usize];
            let ws = &ix.words[b as usize];
            // each word as the quote's word it is, if any
            let ids: Vec<Option<usize>> = ws.iter().map(|&(s, e)| distinct.iter().position(|d| *d == &f.text[s..e])).collect();
            // slide a window of the quote's length (and a little either side), counting as
            // it goes; of windows equally like it, the one whose surroundings agree most
            let mut top: Option<(f32, f32, usize, usize)> = None;
            for len in [n.saturating_sub(2).max(1), n, n + 2] {
                if len > ws.len() {
                    continue;
                }
                let mut cnt = vec![0i32; distinct.len()];
                let mut m = 0i32;
                for st in 0..=ws.len() - len {
                    if st == 0 {
                        for id in ids[..len].iter().flatten() {
                            cnt[*id] += 1;
                            if cnt[*id] <= need[*id] {
                                m += 1;
                            }
                        }
                    } else {
                        if let Some(id) = ids[st - 1] {
                            if cnt[id] <= need[id] {
                                m -= 1;
                            }
                            cnt[id] -= 1;
                        }
                        if let Some(id) = ids[st + len - 1] {
                            cnt[id] += 1;
                            if cnt[id] <= need[id] {
                                m += 1;
                            }
                        }
                    }
                    // shared words over the longer of the two, so a window is not
                    // rewarded for being longer
                    let sim = m as f32 / len.max(n) as f32;
                    let (i, j) = (ws[st].0, ws[st + len - 1].1);
                    if top.is_none_or(|t| sim > t.0 + 1e-6) {
                        top = Some((sim, ctx(f, i, j), i, j));
                    } else if top.is_some_and(|t| sim > t.0 - 1e-6) {
                        let c = ctx(f, i, j);
                        if c > top.unwrap().1 {
                            top = Some((sim, c, i, j));
                        }
                    }
                }
            }
            if let Some((sim, _, i, j)) = top {
                cands.push((sim, f, i, j));
            }
        }
        // (best first; equal ones in reading order, so the outcome never depends on the
        // order a hash map hands them over)
        cands.sort_by(|x, y| y.0.total_cmp(&x.0).then(x.1.n.cmp(&y.1.n)));
        if let Some(&(top, ..)) = cands.first() {
            if top >= 0.6 {
                // the stretches close to the best by words are told apart by their
                // surroundings (and place): the one taken must agree well, and clearly
                // better than the rest unless it is the only one close
                let mut close: Vec<(f32, f32, &Folded, usize, usize)> =
                    cands.iter().filter(|c| c.0 >= top - 0.15).map(|&(sim, f, i, j)| (ctx(f, i, j), sim, f, i, j)).collect();
                close.sort_by(|x, y| (y.0 * 2.0 + place(y.2)).total_cmp(&(x.0 * 2.0 + place(x.2))));
                let (c, _, f, i, j) = close[0];
                let next = close.get(1).map(|x| x.0).unwrap_or(0.0);
                // (a reworded passage keeps most of the words around it; one whose
                // surroundings are all different is somewhere else that happens to share
                // its words)
                if c >= if n <= 3 { 1.2 } else { 0.8 } && (close.len() == 1 || c - next >= 0.4) {
                    return Placed { key: hex(f.key), s: f.map[i], e: f.map[j], how: How::Changed };
                }
            }
        }
        Placed { key: a.key.clone(), s: a.s, e: a.e, how: How::Lost }
    }
}

/// A block's position in reading order as a share of the book, for `Anchor::pos`.
pub fn pos_of(book: &Book, key: u64) -> Option<f32> {
    let mut n = 0;
    let mut at = None;
    for sec in &book.sections {
        for b in &sec.blocks {
            if b.key == key {
                at = Some(n);
            }
            n += 1;
        }
    }
    at.map(|a| a as f32 / n.max(1) as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn book(texts: &[&str]) -> Book {
        let blocks = texts.iter().enumerate().map(|(i, t)| vol_model::Block::new(i as u64 + 1, vol_model::Kind::P, t.to_string(), vec![])).collect();
        Book { id: "b".into(), meta: Default::default(), sections: vec![vol_model::Section { kind: vol_model::SectionKind::Chapter, part: String::new(), label: String::new(), num: "1".into(), title: String::new(), blocks }], notes: vec![], images: vec![], cover: None }
    }

    #[test]
    fn a_reworded_short_passage_is_followed() {
        let b = book(&["He put it up on the shelf and left it there.", "“Oh, yes, sir,” said the other eagerly, “the Thursday costume very quite warm, sir. It fastens to the chin.”", "Nothing else."]);
        let a = Anchor { key: format!("{:016x}", 9u64), s: 0, e: 13, quote: "It fastens up".into(), prefix: "day costume is quite warm, sir. ".into(), suffix: " to the chin.”".into(), pos: Some(0.5) };
        let p = Anchorer::new(&b).place(&a);
        assert_eq!((p.how, p.key.as_str()), (How::Changed, "0000000000000002"));
    }
}
