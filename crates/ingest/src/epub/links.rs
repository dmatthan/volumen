//! Links between the parts of an EPUB: notes found and made notes, references kept.
use super::*;

/// Turns the links found into notes and cross-references. A link is a note reference
/// when it says so (EPUB 3 `noteref`), or when its text is a short marker ("12", "[3]",
/// "*") and its target is a note: marked as one, or linking straight back to the
/// reference (Gutenberg's "return"). A note's text runs from its target to the block that
/// links back (at most a few blocks on). Everything else that lands in the book is a
/// cross-reference; links to the web are kept as such.
pub(super) fn resolve_links(sections: &mut [Section], ex: &mut Extractor) -> Vec<vol_model::Note> {
    use vol_model::{Link, Note, Target};
    // where every block is, in reading order
    let mut order: Vec<(usize, usize)> = Vec::new();
    let mut pos: HashMap<u64, usize> = HashMap::new();
    for (si, sec) in sections.iter().enumerate() {
        for (bi, b) in sec.blocks.iter().enumerate() {
            pos.insert(b.key, order.len());
            order.push((si, bi));
        }
    }
    // which blocks link to which ids (to find links back)
    let mut back: HashMap<&str, Vec<u64>> = HashMap::new();
    for (key, links) in &ex.raw_links {
        for (_, _, p) in links {
            if let Some(t) = p.split('|').nth(1) {
                back.entry(t).or_default().push(*key);
            }
        }
    }
    let target_key = |t: &str| -> Option<u64> {
        if t.contains('#') { ex.ids.get(t).and_then(|i| i.key) } else { ex.first_of_file.get(t).copied() }
    };
    let short = |label: &str| {
        let l = label.trim().trim_matches(['[', ']', '(', ')', '{', '}']);
        !l.is_empty() && l.chars().count() <= 4 && l.chars().all(|c| c.is_alphanumeric() || "*†‡§¶‖#".contains(c))
    };
    let mut notes: Vec<Note> = Vec::new();
    let mut note_of: HashMap<String, u32> = HashMap::new();
    let mut resolved: Vec<(u64, Vec<Link>, Vec<(u32, u32)>)> = Vec::new();
    for &(si, bi) in &order {
        let b = &sections[si].blocks[bi];
        let Some(raw) = ex.raw_links.get(&b.key) else { continue };
        let mut links = Vec::new();
        let mut sup = Vec::new();
        for (s, e, p) in raw {
            let parts: Vec<&str> = p.splitn(3, '|').collect();
            if parts[0] == "u" {
                links.push(Link { start: *s, end: *e, to: Target::Url(parts[1].to_string()) });
                continue;
            }
            let (explicit, target, own) = (parts[0] == "1", parts[1], parts.get(2).copied().unwrap_or(""));
            let label = b.text.get(*s as usize..*e as usize).unwrap_or("");
            // a note: printed nowhere (an aside), or printed in the book
            let note_idx = if let Some(i) = note_of.get(target) {
                Some(*i)
            } else if let Some((t, r, _)) = ex.asides.get(target).filter(|_| explicit || short(label)) {
                notes.push(Note { label: label.trim().to_string(), text: t.clone(), runs: r.clone(), at: None });
                Some(notes.len() as u32 - 1)
            } else if let Some(tk) = target_key(target) {
                let start = pos.get(&tk).copied();
                // the block within a few after the target that links back to this reference
                let back_at = start.and_then(|st| {
                    let from = back.get(own).filter(|_| !own.is_empty())?;
                    (st..(st + 8).min(order.len())).find(|&i| from.contains(&sections[order[i].0].blocks[order[i].1].key))
                });
                let marked = ex.ids.get(target).is_some_and(|i| i.notelike);
                if let Some(st) = start.filter(|_| explicit || (short(label) && (back_at.is_some() || marked))) {
                    let end = back_at.unwrap_or(st);
                    notes.push(note_text(sections, &order[st..=end], label));
                    notes.last_mut().unwrap().at = Some(tk);
                    Some(notes.len() as u32 - 1)
                } else {
                    links.push(Link { start: *s, end: *e, to: Target::Block(tk) });
                    None
                }
            } else {
                None
            };
            if let Some(i) = note_idx {
                note_of.insert(target.to_string(), i);
                links.push(Link { start: *s, end: *e, to: Target::Note(i) });
                sup.push((*s, *e));
            }
        }
        resolved.push((b.key, links, sup));
    }
    for (key, links, sup) in resolved {
        let (si, bi) = order[pos[&key]];
        let b = &mut sections[si].blocks[bi];
        for (s, e) in sup {
            // a note marker is set as a superscript unless it is already raised
            if !b.spans().any(|(a, z, st)| a < e as usize && z > s as usize && st & (style::SUP | style::SUB) != 0) {
                vol_model::add_style(b, s, e, style::SUP);
            }
        }
        b.links = links;
    }
    notes
}

/// A note's text from the blocks it is printed in: their text joined by line breaks, with
/// the link back to the reference and the printed label at its head left out.
pub(super) fn note_text(sections: &[Section], blocks: &[(usize, usize)], label: &str) -> vol_model::Note {
    let mut b = TextBuilder::new();
    for (n, &(si, bi)) in blocks.iter().enumerate() {
        let blk = &sections[si].blocks[bi];
        if n > 0 {
            b.newline();
        }
        for (s, e, st) in blk.spans() {
            b.push(blk.text.get(s..e).unwrap_or(""), st);
        }
    }
    let (mut text, mut runs) = b.finish();
    // the printed label and backlink words at the head or end: "101 (return)", "↩︎"
    let lab = label.trim().trim_matches(['[', ']', '(', ')']);
    let mut cut = 0;
    let head = text.trim_start();
    let lead = text.len() - head.len();
    let mut h = head;
    for strip in [lab, "(return)", "return", "Return", "↩︎", "↩", ".", ")", "]", ":"] {
        h = h.trim_start();
        if !strip.is_empty() && h.starts_with(strip) && (strip != lab || h[strip.len()..].starts_with([' ', '.', ')', ']', '\n', '('])) {
            h = &h[strip.len()..];
        }
    }
    let h2 = h.trim_start().trim_start_matches("()").trim_start();
    cut += lead + (head.len() - h2.len());
    for tail in ["↩︎", "↩", "(return)", "Return to text", "return"] {
        let t = text.trim_end();
        if t.ends_with(tail) {
            text.truncate(t.len() - tail.len());
        }
    }
    let t = text.trim_end().len();
    text.truncate(t);
    // Gutenberg wraps each note in brackets: "[ A considerable portion … ]"
    if text[cut.min(text.len())..].trim_start().starts_with('[') && text.ends_with(']') {
        text.pop();
        cut = text.len() - text[cut..].trim_start()[1..].trim_start().len();
    }
    if cut > 0 && cut <= text.len() {
        text.drain(..cut);
        runs = runs
            .into_iter()
            .filter_map(|r| {
                let (s, e) = (r.start.saturating_sub(cut as u32), r.end.saturating_sub(cut as u32).min(text.len() as u32));
                (e > s).then_some(vol_model::Run { start: s, end: e, style: r.style })
            })
            .collect();
    } else {
        runs.retain_mut(|r| {
            r.end = r.end.min(text.len() as u32);
            r.start < r.end
        });
    }
    vol_model::Note { label: label.trim().to_string(), text, runs, at: None }
}
