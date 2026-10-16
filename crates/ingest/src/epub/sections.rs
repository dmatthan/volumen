//! Sections as found, made into the book's chapters and front matter.
use super::*;

/// Turns found sections into chapters: headings become labels and titles, title pages,
/// contents lists and part-only sections are folded away.
pub(super) fn shape_sections(raw: Vec<RawSection>, meta: &Meta) -> Vec<Section> {
    let norm = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let (nt, na) = (norm(&meta.title), norm(&meta.author));
    let mut out: Vec<Section> = Vec::new();
    let mut part = String::new();
    // a book of pictures (a comic, a picture book, fixed pages): most of its sections are
    // a picture with a few words or none, and those are its pages, not title pages
    let few = |rs: &RawSection| rs.blocks.iter().filter(|b| b.block.kind != Kind::H).map(|b| vol_model::words(&b.block.text)).sum::<usize>() < 15;
    let pictured = raw.iter().filter(|rs| few(rs) && rs.blocks.iter().any(|b| b.block.kind == Kind::Image)).count();
    let pictures = pictured > raw.iter().filter(|rs| !few(rs)).count();
    for rs in raw {
        let mut blocks = rs.blocks;
        // leading headings name the section; apparatus has no chapter head, so its own
        // heading stays in its text ("Colophon", an epigraph poem's title)
        let mut heads_text: Vec<String> = Vec::new();
        if rs.matter {
            heads_text.extend(blocks.iter().take_while(|b| b.block.kind == Kind::H).map(|b| b.block.text.replace('\n', " ")));
        } else {
            while blocks.first().is_some_and(|b| b.block.kind == Kind::H) {
                heads_text.push(blocks.remove(0).block.text.replace('\n', " "));
            }
        }
        let prose_words: usize = blocks.iter().filter(|b| b.block.kind != Kind::H).map(|b| vol_model::words(&b.block.text)).sum();
        let label_src = rs.toc_label.clone().unwrap_or_else(|| heads_text.first().cloned().unwrap_or_default());
        let lt = norm(&label_src);
        // a section named after the book (or its author) is its title page, unless it is
        // long enough to be the work itself: a story printed whole under its title
        let whole = prose_words >= 1000;
        if lt.contains("contents") || (!lt.is_empty() && (lt == nt || lt == na) && !whole) {
            continue;
        }
        let mut h = heads::parse(&label_src);
        // the heading text may carry a title the TOC label lacks
        if h.title.is_empty() {
            for t in &heads_text {
                let p = heads::parse(t);
                if !p.title.is_empty() && norm(&p.title) != norm(&h.label) {
                    h.title = p.title;
                    break;
                }
            }
        }
        let picture = pictures && blocks.iter().any(|b| b.block.kind == Kind::Image);
        if prose_words < 15 && !picture {
            // a part heading ("Book I. Miss Brooke") or a title page: carry the part on
            if !h.label.is_empty() && blocks.iter().all(|b| b.block.kind == Kind::H || vol_model::words(&b.block.text) < 8) {
                part = if h.title.is_empty() { h.label.clone() } else { format!("{} · {}", h.label, h.title) };
            }
            continue;
        }
        let mut blocks: Vec<Block> = blocks.into_iter().map(|b| b.block).collect();
        // no scene break at a section's edges (a rule under a title, before a footer)
        while blocks.first().is_some_and(|b| b.kind == Kind::Break) {
            blocks.remove(0);
        }
        while blocks.last().is_some_and(|b| b.kind == Kind::Break) {
            blocks.pop();
        }
        // a Gutenberg-style "THE ..." centre heading right after the label is the title
        if h.title.is_empty() && h.label.is_empty() && h.num.is_empty() {
            h.title = String::new();
        }
        // a section named after the book is its title page; what survives of it (a
        // dedication, an epigraph) is front matter, not a chapter
        let title_page = !nt.is_empty() && lt.starts_with(&nt) && !whole;
        let front = title_page || rs.matter || matches!(lt.as_str(), "dedication" | "epigraph" | "frontispiece");
        if title_page {
            while blocks.first().is_some_and(|b| norm(&b.text).starts_with(&nt) || (!na.is_empty() && norm(&b.text) == na)) {
                blocks.remove(0);
            }
            if blocks.iter().map(|b| vol_model::words(&b.text)).sum::<usize>() < 15 {
                continue;
            }
            let ded = blocks.first().is_some_and(|b| b.text.starts_with("To ") || b.text.starts_with("TO "));
            h = heads::Head { label: String::new(), num: String::new(), title: if ded { "Dedication".into() } else { "Front matter".into() } };
        }
        if let Some(i) = blocks.iter().position(|b| b.kind == Kind::P)
            && !front {
                vol_model::apply_lead_in(&mut blocks[i]);
            }
        // a page of pictures with no name of its own goes on from the one before
        if picture && h.label.is_empty() && h.title.is_empty() && rs.toc_label.is_none()
            && let Some(last) = out.last_mut() {
                last.blocks.extend(blocks);
                continue;
            }
        let n = out.len() + 1;
        out.push(Section {
            kind: if front { SectionKind::Front } else { SectionKind::Chapter },
            part: std::mem::take(&mut part),
            label: h.label,
            num: if h.num.is_empty() { n.to_string() } else { h.num },
            title: h.title,
            blocks,
        });
    }
    out
}
