//! Hyphenation by Liang's patterns, compiled to the compact automata of the `hypher`
//! crate (Laurenz Mädje, MIT/Apache; its algorithm is reproduced here). `hypher` builds
//! every language into the binary — 600 KB for the fifteen we offer, 40% of the web
//! engine — so here the automata are data: the desktop embeds them all, the web build
//! fetches only the book's language (`assets/hyph/<code>.bin`).

use std::sync::Arc;

/// One language's patterns.
#[derive(Clone)]
pub struct Patterns {
    data: Arc<[u8]>,
}

/// The languages we have patterns for, by ISO 639-1 code.
pub const LANGS: &[&str] = &["en", "de", "fr", "es", "it", "pt", "nl", "sv", "da", "no", "fi", "pl", "cs", "ru", "la"];

/// The patterns a book's language takes: its two-letter code if we have it (`nb` and `nn`
/// are Norwegian), English when a book does not say.
pub fn lang_code(lang: &str) -> Option<&'static str> {
    let b = lang.as_bytes();
    if b.len() < 2 {
        return Some("en");
    }
    let code = [b[0].to_ascii_lowercase(), b[1].to_ascii_lowercase()];
    let code = match &code {
        b"nb" | b"nn" => *b"no",
        _ => code,
    };
    LANGS.iter().copied().find(|l| l.as_bytes() == code)
}

impl Patterns {
    pub fn new(bytes: Vec<u8>) -> Option<Patterns> {
        // a root address and at least one node
        (bytes.len() > 5).then(|| Patterns { data: bytes.into() })
    }

    /// The syllables of `word`, at least `left` characters before the first break and
    /// `right` after the last.
    pub fn syllables<'w>(&self, word: &'w str, left: usize, right: usize) -> Vec<&'w str> {
        let data = &self.data[..];
        let root = State::root(data);
        let dotted = lowercase_and_dot(word);
        let (min_idx, max_idx) = char_to_byte_bounds(word, left, right);
        let mut levels = vec![0u8; word.len().saturating_sub(1)];
        for start in 0..dotted.len() {
            if !is_char_boundary(dotted[start]) {
                continue;
            }
            let mut state = root;
            for &b in &dotted[start..] {
                let Some(next) = state.transition(b) else { break };
                state = next;
                for (offset, level) in state.levels() {
                    let split = start + offset;
                    if split >= min_idx && split <= max_idx {
                        let slot = &mut levels[split - 2];
                        *slot = (*slot).max(level);
                    }
                }
            }
        }
        // odd levels are breaks
        let mut out = Vec::new();
        let mut from = 0;
        for (i, &l) in levels.iter().enumerate() {
            if l % 2 == 1 {
                out.push(&word[from..i + 1]);
                from = i + 1;
            }
        }
        out.push(&word[from..]);
        out
    }
}

fn lowercase_and_dot(word: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(word.len() + 2);
    out.push(b'.');
    for mut c in word.chars() {
        let mut lower = c.to_lowercase();
        if let (Some(l), None) = (lower.next(), lower.next()) {
            // only where the lowercase takes the same bytes, so offsets stay the word's
            if l.len_utf8() == c.len_utf8() {
                c = l;
            }
        }
        let mut buf = [0u8; 4];
        out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
    }
    out.push(b'.');
    out
}

fn char_to_byte_bounds(word: &str, left: usize, right: usize) -> (usize, usize) {
    let (left, right) = (left.max(1), right.max(1));
    let min_idx = 1 + word.chars().take(left).map(char::len_utf8).sum::<usize>();
    let max_idx = 1 + word.len() - word.chars().rev().take(right).map(char::len_utf8).sum::<usize>();
    (min_idx, max_idx)
}

fn is_char_boundary(b: u8) -> bool {
    (b as i8) >= -0x40
}

/// A node of the automaton: its levels, its transitions and where they lead.
#[derive(Clone, Copy)]
struct State<'a> {
    data: &'a [u8],
    addr: usize,
    stride: usize,
    levels: &'a [u8],
    trans: &'a [u8],
    targets: &'a [u8],
}

impl<'a> State<'a> {
    fn root(data: &'a [u8]) -> Self {
        let addr = u32::from_be_bytes(data[..4].try_into().unwrap()) as usize;
        Self::at(data, addr)
    }

    fn at(data: &'a [u8], addr: usize) -> Self {
        let node = &data[addr..];
        let mut pos = 0;
        let has_levels = node[pos] >> 7 != 0;
        let stride = usize::from((node[pos] >> 5) & 3);
        let mut count = usize::from(node[pos] & 31);
        pos += 1;
        if count == 31 {
            count = usize::from(node[pos]);
            pos += 1;
        }
        let mut levels: &[u8] = &[];
        if has_levels {
            let offset = (usize::from(node[pos]) << 4) | (usize::from(node[pos + 1]) >> 4);
            let len = usize::from(node[pos + 1] & 15);
            levels = &data[offset..offset + len];
            pos += 2;
        }
        let trans = &node[pos..pos + count];
        pos += count;
        let targets = &node[pos..pos + stride * count];
        Self { data, addr, stride, levels, trans, targets }
    }

    fn transition(self, b: u8) -> Option<Self> {
        self.trans.iter().position(|&x| x == b).map(|idx| {
            let offset = self.stride * idx;
            let delta = from_be_bytes(&self.targets[offset..offset + self.stride]);
            Self::at(self.data, (self.addr as isize + delta) as usize)
        })
    }

    fn levels(self) -> impl Iterator<Item = (usize, u8)> + 'a {
        let mut offset = 0;
        self.levels.iter().map(move |&packed| {
            offset += usize::from(packed / 10);
            (offset, packed % 10)
        })
    }
}

fn from_be_bytes(buf: &[u8]) -> isize {
    match buf.len() {
        1 => i8::from_be_bytes([buf[0]]) as isize,
        2 => i16::from_be_bytes([buf[0], buf[1]]) as isize,
        3 => ((usize::from(buf[0]) << 16 | usize::from(buf[1]) << 8 | usize::from(buf[2])) as isize) - (1 << 23),
        _ => panic!("invalid stride"),
    }
}

#[cfg(test)]
pub(crate) fn english() -> Patterns {
    Patterns::new(std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/hyph/en.bin")).unwrap()).unwrap()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn as_hypher_does() {
        let en = english();
        let h = |w: &str| en.syllables(w, 2, 3).join("-");
        assert_eq!(h("extensive"), "ex-ten-sive");
        assert_eq!(h("Probability"), "Prob-a-bil-ity");
        assert_eq!(h("hello"), "hello");
        assert_eq!(h("recognize"), "rec-og-nize");
        let de = Patterns::new(std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/hyph/de.bin")).unwrap()).unwrap();
        assert_eq!(de.syllables("Eingabeaufforderung", 2, 2).join("-"), "Ein-ga-be-auf-for-de-rung");
        assert_eq!(lang_code("en-GB"), Some("en"));
        assert_eq!(lang_code("nb"), Some("no"));
        assert_eq!(lang_code("ja"), None);
    }
}
