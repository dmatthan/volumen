//! Manuscripts as writers keep them (Word, Markdown): a run of paragraphs, some of them
//! headings, with footnotes. The importers (`docx.rs`, `markdown.rs`) produce a `Doc`;
//! this turns it into a book: chapters from the headings, the rest as the EPUB importer
//! would set it.

use crate::{Error, finish_book, heads};
use vol_model::{Block, Kind, Link, Meta, Note, Section, SectionKind, Target, TextBuilder, fnv64};

pub(crate) enum Para {
    /// A heading of this level (1 the highest; a document title is 0).
    Heading(u8, TextBuilder),
    P(TextBuilder),
    Quote(TextBuilder),
    Item(TextBuilder),
    /// Code or preformatted text: lines and spaces kept.
    Pre(String),
    /// A scene break.
    Break,
}

/// A manuscript: what the file says about itself, its paragraphs, its footnotes. A
/// footnote marker is a link with the payload `n:<index>` over the marker's text.
pub(crate) struct Doc {
    pub meta: Meta,
    pub paras: Vec<Para>,
    pub notes: Vec<(String, TextBuilder)>,
}

/// A paragraph that is a scene break as writers type one: asterisks, a hash, a tilde, a
/// dinkus character, alone.
pub(crate) fn is_break(t: &str) -> bool {
    let t = t.trim();
    !t.is_empty() && t.chars().count() <= 12 && t.chars().all(|c| c.is_whitespace() || matches!(c, '*' | '#' | '~' | '⁂' | '•' | '·' | '◆' | '❦' | '§' | '+' | '-' | '_' | '='))
}

fn block(b: TextBuilder, kind: Kind, key: u64) -> Block {
    let (text, runs, links) = b.finish_with_links();
    let mut blk = Block::new(key, kind, text, runs);
    blk.links = links
        .into_iter()
        .filter_map(|(s, e, p)| Some(Link { start: s, end: e, to: Target::Note(p.strip_prefix("n:")?.parse().ok()?) }))
        .collect();
    blk
}

pub(crate) fn assemble(source: &[u8], name: &str, mut doc: Doc) -> Result<crate::Book, Error> {
    // the title: a heading of level 0, or a single highest heading before any text
    let levels: Vec<u8> = doc.paras.iter().filter_map(|p| if let Para::Heading(l, _) = p { Some(*l) } else { None }).collect();
    let top = levels.iter().copied().filter(|&l| l > 0).min();
    let first_text = doc.paras.iter().position(|p| !matches!(p, Para::Heading(..)));
    let mut title_at = doc.paras.iter().position(|p| matches!(p, Para::Heading(0, _)));
    if title_at.is_none() {
        if let Some(t) = top {
            let n = levels.iter().filter(|&&l| l == t).count();
            let at = doc.paras.iter().position(|p| matches!(p, Para::Heading(l, _) if *l == t));
            if n == 1 && levels.iter().any(|&l| l > t) && at.is_some_and(|a| first_text.is_none_or(|f| a < f)) {
                title_at = at;
            }
        }
    }
    if let Some(i) = title_at {
        if let Para::Heading(_, b) = doc.paras.remove(i) {
            let (t, _) = b.finish();
            if doc.meta.title.trim().is_empty() {
                doc.meta.title = t;
            }
        }
    }
    if doc.meta.title.trim().is_empty() {
        let stem = name.rsplit(['/', '\\']).next().unwrap_or(name);
        let stem = stem.rsplit_once('.').map(|x| x.0).unwrap_or(stem);
        doc.meta.title = stem.replace(['_'], " ");
    }
    if doc.meta.lang.is_empty() {
        doc.meta.lang = "en".into();
    }
    // a document of headings only (every line styled "Title" or "Heading 1") is its
    // headings, read as text: as chapters they would all be empty
    if !doc.paras.iter().any(|p| match p {
        Para::P(b) | Para::Quote(b) | Para::Item(b) => !b.is_empty(),
        Para::Pre(t) => !t.trim().is_empty(),
        _ => false,
    }) {
        for p in &mut doc.paras {
            if let Para::Heading(_, b) = p {
                *p = Para::P(std::mem::take(b));
            }
        }
    }
    // chapters are the highest headings left; deeper ones are headings within them
    let chap = doc.paras.iter().filter_map(|p| if let Para::Heading(l, _) = p { Some(*l) } else { None }).min();
    let file = fnv64(name.as_bytes());
    let mut ord = 0u64;
    let mut key = || {
        ord += 1;
        file ^ ord.wrapping_mul(0x9e3779b97f4a7c15)
    };
    let mut sections: Vec<Section> = Vec::new();
    for p in doc.paras {
        if let Para::Heading(l, b) = &p {
            if Some(*l) == chap {
                let (t, _) = b.clone().finish();
                let h = heads::parse(&t);
                let n = sections.iter().filter(|s| s.kind == SectionKind::Chapter).count() + 1;
                let (label, title) = if h.label.is_empty() { (String::new(), heads::tidy(&t)) } else { (h.label, h.title) };
                sections.push(Section { kind: SectionKind::Chapter, part: String::new(), label, num: if h.num.is_empty() { n.to_string() } else { h.num }, title, blocks: Vec::new() });
                continue;
            }
        }
        if sections.is_empty() {
            // text before the first chapter: an opening section of its own
            sections.push(Section { kind: if chap.is_some() { SectionKind::Front } else { SectionKind::Chapter }, part: String::new(), label: String::new(), num: "1".into(), title: String::new(), blocks: Vec::new() });
        }
        let blk = match p {
            Para::Heading(_, b) => block(b, Kind::H, key()),
            Para::P(b) if is_break(b.text()) => Block::new(0, Kind::Break, String::new(), vec![]),
            Para::P(b) => block(b, Kind::P, key()),
            Para::Quote(b) => block(b, Kind::Q, key()),
            Para::Item(b) => block(b, Kind::Li, key()),
            Para::Pre(t) => Block::new(key(), Kind::Pre, t, vec![]),
            Para::Break => Block::new(0, Kind::Break, String::new(), vec![]),
        };
        if blk.kind != Kind::Break && blk.text.is_empty() {
            continue;
        }
        sections.last_mut().unwrap().blocks.push(blk);
    }
    for s in &mut sections {
        // no break at a chapter's edges
        while s.blocks.first().is_some_and(|b| b.kind == Kind::Break) {
            s.blocks.remove(0);
        }
        while s.blocks.last().is_some_and(|b| b.kind == Kind::Break) {
            s.blocks.pop();
        }
    }
    sections.retain(|s| !s.blocks.is_empty());
    // a manuscript with no headings: parts of about 2,600 words, as plain text
    if sections.len() == 1 && chap.is_none() {
        let all: Vec<Block> = sections.drain(..).flat_map(|s| s.blocks).collect();
        let long = all.iter().map(|b| vol_model::words(&b.text)).sum::<usize>() > 5000;
        let mut w = 0;
        for b in all {
            if sections.is_empty() || (long && w > 2600 && b.kind != Kind::Break) {
                let n = sections.len() + 1;
                sections.push(Section { kind: SectionKind::Chapter, part: String::new(), label: if long { format!("Part {n}") } else { String::new() }, num: n.to_string(), title: String::new(), blocks: Vec::new() });
                w = 0;
            }
            w += vol_model::words(&b.text);
            sections.last_mut().unwrap().blocks.push(b);
        }
    }
    if sections.is_empty() {
        return Err(Error::Empty);
    }
    for s in &mut sections {
        if s.kind == SectionKind::Chapter {
            if let Some(b) = s.blocks.iter_mut().find(|b| b.kind == Kind::P) {
                vol_model::apply_lead_in(b);
            }
        }
    }
    let notes = doc
        .notes
        .into_iter()
        .map(|(label, b)| {
            let (text, runs) = b.finish();
            Note { label, text, runs, at: None }
        })
        .collect();
    let mut book = finish_book(source, doc.meta, sections);
    book.notes = notes;
    Ok(book)
}
