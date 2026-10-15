//! EPUB 2 and 3 into the book model.
//!
//! Sections follow the table of contents: every TOC target (a file, or an element id
//! inside one) starts a section. Without a usable TOC, each spine document is one.

use crate::heads;
use crate::css;
use crate::rich;
use crate::{Error, finish_book};
use scraper::{ElementRef, Html, Node};
use std::collections::{HashMap, HashSet};
use std::io::{Cursor, Read};
use vol_model::{Block, Kind, Meta, Section, SectionKind, TextBuilder, fnv64, style};

struct Zip<'a> {
    z: zip::ZipArchive<Cursor<&'a [u8]>>,
}

impl Zip<'_> {
    fn bytes(&mut self, path: &str) -> Option<Vec<u8>> {
        let name = if self.z.index_for_name(path).is_some() { path.to_string() } else { percent_decode(path) };
        let mut f = self.z.by_name(&name).ok()?;
        let mut out = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut out).ok()?;
        Some(out)
    }

    fn text(&mut self, path: &str) -> Option<String> {
        let name = if self.z.index_for_name(path).is_some() { path.to_string() } else { percent_decode(path) };
        let mut f = self.z.by_name(&name).ok()?;
        let mut s = String::with_capacity(f.size() as usize);
        let mut bytes = Vec::with_capacity(f.size() as usize);
        f.read_to_end(&mut bytes).ok()?;
        match String::from_utf8(bytes) {
            Ok(t) => s.push_str(&t),
            Err(e) => s.push_str(&String::from_utf8_lossy(e.as_bytes())),
        }
        Some(s)
    }
}

const VOID: &[&str] = &["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"];

/// XHTML allows `<a id="x"/>`; an HTML parser reads that as an open tag that swallows
/// everything after it. Expands self-closing non-void tags to an explicit pair.
fn expand_self_closing(src: &str) -> std::borrow::Cow<'_, str> {
    if !src.contains("/>") {
        return src.into();
    }
    let b = src.as_bytes();
    let mut out = String::with_capacity(src.len() + 256);
    let mut last = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'<' || i + 1 >= b.len() || !b[i + 1].is_ascii_alphabetic() {
            i += 1;
            continue;
        }
        // find the end of this tag, skipping quoted attribute values
        let mut j = i + 1;
        let mut quote = 0u8;
        while j < b.len() {
            let c = b[j];
            if quote != 0 {
                if c == quote {
                    quote = 0;
                }
            } else if c == b'"' || c == b'\'' {
                quote = c;
            } else if c == b'>' {
                break;
            }
            j += 1;
        }
        if j >= b.len() {
            break;
        }
        if b[j - 1] == b'/' {
            let name_end = (i + 1..j).find(|&k| !(b[k].is_ascii_alphanumeric() || b[k] == b':' || b[k] == b'-')).unwrap_or(j);
            let name = &src[i + 1..name_end];
            if !VOID.iter().any(|v| v.eq_ignore_ascii_case(name)) {
                out.push_str(&src[last..j - 1]);
                out.push_str("></");
                out.push_str(name);
                out.push('>');
                last = j + 1;
            }
        }
        i = j + 1;
    }
    out.push_str(&src[last..]);
    out.into()
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Resolves `rel` against the directory of `base` (both zip paths).
fn resolve(base: &str, rel: &str) -> String {
    let rel = percent_decode(rel);
    let mut parts: Vec<&str> = base.split('/').collect();
    parts.pop();
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn elements<'a>(doc: &'a Html, name: &'a str) -> impl Iterator<Item = ElementRef<'a>> + 'a {
    doc.root_element().descendent_elements().filter(move |e| e.value().name().eq_ignore_ascii_case(name))
}

fn text_of(e: ElementRef) -> String {
    e.text().collect::<String>().split_whitespace().collect::<Vec<_>>().join(" ")
}

struct TocEntry {
    file: String,
    frag: Option<String>,
    label: String,
}

pub fn parse(bytes: &[u8]) -> Result<crate::Book, Error> {
    let z = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| Error::Unreadable("it is not a zip archive"))?;
    let mut z = Zip { z };
    let container = z.text("META-INF/container.xml").ok_or(Error::Unreadable("it has no META-INF/container.xml"))?;
    let cdoc = Html::parse_document(&container);
    let opf_path = elements(&cdoc, "rootfile")
        .find_map(|e| e.attr("full-path").map(str::to_string))
        .ok_or(Error::Unreadable("its container names no package file"))?;
    let opf_src = z.text(&opf_path).ok_or(Error::Unreadable("its package file is missing"))?;
    let opf = Html::parse_document(&opf_src);

    let meta_of = |n: &str| elements(&opf, n).map(text_of).find(|t| !t.is_empty()).unwrap_or_default();
    let mut meta = Meta {
        title: meta_of("dc:title"),
        author: meta_of("dc:creator"),
        year: meta_of("dc:date").chars().take(4).collect(),
        lang: meta_of("dc:language"),
        subtitle: String::new(),
    };
    if meta.lang.is_empty() {
        meta.lang = "en".into();
    }
    if let Some((t, sub)) = meta.title.split_once(" / ").or_else(|| meta.title.split_once(": ")).or_else(|| meta.title.split_once("; ")) {
        if !t.is_empty() && sub.len() < 80 {
            let (t, sub) = (t.to_string(), sub.to_string());
            meta.title = t;
            meta.subtitle = sub;
        }
    }

    struct Item {
        href: String,
        media: String,
        props: String,
    }
    let mut manifest: HashMap<String, Item> = HashMap::new();
    for e in elements(&opf, "item") {
        if let (Some(id), Some(href)) = (e.attr("id"), e.attr("href")) {
            manifest.insert(
                id.to_string(),
                Item {
                    href: resolve(&opf_path, href),
                    media: e.attr("media-type").unwrap_or("").to_string(),
                    props: e.attr("properties").unwrap_or("").to_string(),
                },
            );
        }
    }
    let spine: Vec<String> = elements(&opf, "itemref")
        .filter(|e| e.attr("linear") != Some("no"))
        .filter_map(|e| e.attr("idref"))
        .filter_map(|id| manifest.get(id))
        .filter(|m| m.media.contains("html") || m.media.contains("xml"))
        .map(|m| m.href.clone())
        .collect();

    // table of contents: EPUB 3 nav, else NCX
    let mut toc: Vec<TocEntry> = Vec::new();
    if let Some(nav) = manifest.values().find(|m| m.props.split_whitespace().any(|p| p == "nav")) {
        if let Some(src) = z.text(&nav.href) {
            let d = Html::parse_document(&expand_self_closing(&src));
            let navs: Vec<ElementRef> = elements(&d, "nav").collect();
            let toc_nav = navs
                .iter()
                .find(|n| n.attr("epub:type").or_else(|| n.attr("type")).unwrap_or("").contains("toc"))
                .or(navs.first());
            if let Some(n) = toc_nav {
                for a in n.descendent_elements().filter(|e| e.value().name() == "a") {
                    if let Some(href) = a.attr("href") {
                        let (f, frag) = split_href(href);
                        toc.push(TocEntry { file: resolve(&nav.href, f), frag, label: text_of(a) });
                    }
                }
            }
        }
    }
    if toc.is_empty() {
        let ncx = elements(&opf, "spine").find_map(|e| e.attr("toc")).and_then(|id| manifest.get(id)).map(|m| m.href.clone()).or_else(|| {
            manifest.values().find(|m| m.media == "application/x-dtbncx+xml").map(|m| m.href.clone())
        });
        if let Some(p) = ncx {
            if let Some(src) = z.text(&p) {
                let d = Html::parse_document(&src);
                for np in elements(&d, "navpoint") {
                    let label = np.descendent_elements().find(|e| e.value().name() == "text").map(text_of).unwrap_or_default();
                    if let Some(src) = np.descendent_elements().find(|e| e.value().name() == "content").and_then(|e| e.attr("src")) {
                        let (f, frag) = split_href(src);
                        toc.push(TocEntry { file: resolve(&p, f), frag, label });
                    }
                }
            }
        }
    }
    // keep only entries that point into the spine, in spine order, first one per target
    let spine_pos: HashMap<&str, usize> = spine.iter().enumerate().map(|(i, s)| (s.as_str(), i)).collect();
    let mut seen = HashSet::new();
    toc.retain(|t| spine_pos.contains_key(t.file.as_str()) && seen.insert((t.file.clone(), t.frag.clone())));

    let mut ex = Extractor::default();
    let toc_by_file: HashMap<&str, Vec<&TocEntry>> = toc.iter().fold(HashMap::new(), |mut m, t| {
        m.entry(t.file.as_str()).or_default().push(t);
        m
    });
    let mut sheets: HashMap<String, css::Sheet> = HashMap::new();
    let mut raw_sheets: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for path in &spine {
        let Some(src) = z.text(path) else { continue };
        let doc = Html::parse_document(&expand_self_closing(&src));
        // the publisher's styles, as far as they hide text or style it (css.rs): the
        // sheets the document links, each read once, then its own <style> elements
        let mut own: Vec<css::Sheet> = Vec::new();
        let mut linked: Vec<String> = Vec::new();
        for l in elements(&doc, "link") {
            if l.attr("rel").is_some_and(|r| r.to_ascii_lowercase().contains("stylesheet")) {
                if let Some(h) = l.attr("href") {
                    let p = resolve(path, split_href(h).0);
                    if !sheets.contains_key(&p) {
                        let parsed = z.text(&p).map(|t| css::parse_sheet(&t)).unwrap_or_default();
                        sheets.insert(p.clone(), parsed);
                    }
                    linked.push(p);
                }
            }
        }
        for st in elements(&doc, "style") {
            own.push(css::parse_sheet(&st.text().collect::<String>()));
        }
        let all: Vec<&css::Sheet> = linked.iter().filter_map(|p| sheets.get(p)).chain(own.iter()).collect();
        css::set(css::cascade(&doc, &all));
        ex.rules = linked.iter().flat_map(|p| raw_sheets.entry(p.clone()).or_insert_with(|| z.text(p).map(|t| css::raw_rules(&t)).unwrap_or_default()).clone()).collect();
        for st in elements(&doc, "style") {
            ex.rules.extend(css::raw_rules(&st.text().collect::<String>()));
        }
        ex.file = fnv64(path.as_bytes());
        ex.ordinal = 0;
        ex.path = path.clone();
        ex.targets.clear();
        let body = elements(&doc, "body").next().unwrap_or(doc.root_element());
        // the document's own semantics: its body's, or its first section's
        ex.doc_matter = matter_of(&body) || body.descendants().filter_map(ElementRef::wrap).find(|e| matches!(e.value().name(), "section" | "article")).is_some_and(|e| matter_of(&e));
        let entries = toc_by_file.get(path.as_str());
        if let Some(es) = entries {
            for e in es {
                match &e.frag {
                    Some(f) => {
                        ex.targets.insert(f.clone(), e.label.clone());
                    }
                    None => ex.start_section(Some(e.label.clone()), ex.doc_matter),
                }
            }
        } else if toc.is_empty() {
            ex.start_section(None, ex.doc_matter);
        }
        ex.walk(body, Ctx::default());
        ex.flush_para(Ctx::default());
    }
    css::set(HashMap::new());
    let raw = std::mem::take(&mut ex.sections);
    let mut sections = shape_sections(raw, &meta);
    if sections.is_empty() {
        return Err(Error::Empty);
    }
    let images = load_images(&mut z, &ex.images, &ex.rich, &mut sections);
    let notes = resolve_links(&mut sections, &mut ex);
    // the cover: an item marked cover-image (EPUB 3), else the one <meta name="cover"> names
    let cover_item = manifest.values().find(|m| m.props.split_whitespace().any(|p| p == "cover-image")).or_else(|| {
        elements(&opf, "meta").find(|e| e.attr("name") == Some("cover")).and_then(|e| e.attr("content")).and_then(|id| manifest.get(id))
    });
    let cover = cover_item
        .filter(|m| m.media.starts_with("image/") && !m.media.contains("svg"))
        .and_then(|m| z.bytes(&m.href).map(|b| vol_model::Cover { mime: m.media.clone(), bytes: b }))
        .filter(|c| c.bytes.len() < 8_000_000);
    let mut book = finish_book(bytes, meta, sections);
    book.cover = cover;
    book.notes = notes;
    book.images = images;
    Ok(book)
}

/// Reads and measures the images the walk met. Ones that cannot be shown, or are mere
/// icons (Gutenberg's "enlarge" buttons, ornaments under 24 px), lose their blocks.
fn load_images(z: &mut Zip, found: &[(String, String, f32)], rich: &[String], sections: &mut [Section]) -> Vec<vol_model::Image> {
    // only images whose blocks survived shaping (a dropped title page takes its art along)
    let used: HashSet<u32> = sections.iter().flat_map(|s| &s.blocks).filter_map(|b| b.image).collect();
    let mut out: Vec<vol_model::Image> = Vec::new();
    let mut remap: Vec<Option<u32>> = Vec::with_capacity(found.len());
    for (i, (path, alt, density)) in found.iter().enumerate() {
        let img = (|| {
            if !used.contains(&(i as u32)) {
                return None;
            }
            // a rich block: its XHTML, its size not known until a browser draws it
            if let Some(n) = path.strip_prefix("rich:").and_then(|n| n.parse::<usize>().ok()) {
                return Some(vol_model::Image { mime: vol_model::RICH.into(), w: 0, h: 0, alt: alt.clone(), bytes: rich.get(n)?.clone().into_bytes() });
            }
            if path.to_ascii_lowercase().contains("enlarge") {
                return None;
            }
            let bytes = z.bytes(path)?;
            if bytes.len() > 20_000_000 {
                return None;
            }
            let mime = match imagesize::image_type(&bytes).ok()? {
                imagesize::ImageType::Png => "image/png",
                imagesize::ImageType::Jpeg => "image/jpeg",
                imagesize::ImageType::Gif => "image/gif",
                imagesize::ImageType::Webp => "image/webp",
                _ => return None,
            };
            let d = imagesize::blob_size(&bytes).ok()?;
            let (w, h) = ((d.width as f32 / density).round() as u32, (d.height as f32 / density).round() as u32);
            if w < 24 || h < 24 {
                return None;
            }
            // Gutenberg names images by number and repeats it as their description
            let alt = if alt.chars().all(|c| c.is_ascii_digit() || c.is_whitespace() || c == '_') { String::new() } else { alt.clone() };
            Some(vol_model::Image { mime: mime.into(), w, h, alt, bytes })
        })();
        remap.push(img.map(|i| {
            out.push(i);
            out.len() as u32 - 1
        }));
    }
    for sec in sections.iter_mut() {
        sec.blocks.retain_mut(|b| match b.image {
            Some(i) => match remap.get(i as usize).copied().flatten() {
                Some(j) => {
                    b.image = Some(j);
                    true
                }
                None => false,
            },
            None => b.kind != Kind::Image,
        });
    }
    out
}

/// Turns the links found into notes and cross-references. A link is a note reference
/// when it says so (EPUB 3 `noteref`), or when its text is a short marker ("12", "[3]",
/// "*") and its target is a note: marked as one, or linking straight back to the
/// reference (Gutenberg's "return"). A note's text runs from its target to the block that
/// links back (at most a few blocks on). Everything else that lands in the book is a
/// cross-reference; links to the web are kept as such.
fn resolve_links(sections: &mut [Section], ex: &mut Extractor) -> Vec<vol_model::Note> {
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
fn note_text(sections: &[Section], blocks: &[(usize, usize)], label: &str) -> vol_model::Note {
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

fn split_href(h: &str) -> (&str, Option<String>) {
    match h.split_once('#') {
        Some((f, frag)) => (f, if frag.is_empty() { None } else { Some(percent_decode(frag)) }),
        None => (h, None),
    }
}

/// A section as found, before headings are interpreted.
struct RawSection {
    toc_label: Option<String>,
    blocks: Vec<RawBlock>,
    /// The book says this is apparatus, not reading (an imprint, a colophon, a copyright
    /// page, endnotes: `matter_of`): unnumbered, without a chapter head.
    matter: bool,
}

/// Whether an element's semantics (EPUB 3 `epub:type`, DPUB-ARIA `role`) make it
/// apparatus rather than something to read as a chapter. Prefaces, introductions,
/// appendices and the like stay chapters: they are read.
fn matter_of(e: &ElementRef) -> bool {
    const APPARATUS: &[&str] = &[
        "imprint", "colophon", "copyright-page", "titlepage", "halftitlepage", "seriespage", "dedication", "epigraph",
        "endnotes", "footnotes", "rearnotes", "loi", "lot", "index", "credits", "contributors", "other-credits", "errata", "acknowledgments", "toc",
    ];
    let t = e.attr("epub:type").unwrap_or("");
    let r = e.attr("role").unwrap_or("");
    t.split_whitespace().any(|w| APPARATUS.contains(&w)) || r.split_whitespace().any(|w| w.strip_prefix("doc-").is_some_and(|w| APPARATUS.contains(&w)))
}

struct RawBlock {
    block: Block,
}

#[derive(Clone, Copy, Default)]
struct Ctx {
    quote: bool,
    li: bool,
}

#[derive(Default)]
struct Extractor {
    sections: Vec<RawSection>,
    /// The document being read is apparatus (`matter_of` its body or first section).
    doc_matter: bool,
    targets: HashMap<String, String>,
    file: u64,
    ordinal: u64,
    para: Option<TextBuilder>,
    /// The document being read (zip path), against which links resolve.
    path: String,
    /// Ids seen since the last block, and every id as `path#id` → the block it opens.
    pending_ids: Vec<String>,
    ids: HashMap<String, IdInfo>,
    first_of_file: HashMap<String, u64>,
    /// Links as found, per block key: range and payload (see `Inl::link`).
    raw_links: HashMap<u64, Vec<(u32, u32, String)>>,
    /// Footnotes printed nowhere in the flow (EPUB 3 asides): `path#id` → text.
    asides: HashMap<String, (String, Vec<vol_model::Run>, Vec<(u32, u32, String)>)>,
    /// Images to read once the walk is done: path, description, pixel density.
    images: Vec<(String, String, f32)>,
    /// Images met inside a paragraph, set after it.
    after_para: Vec<(String, String, f32)>,
    /// Rich blocks' XHTML (`rich:<n>` among the images), and the rules of the document
    /// being read, as written, for them.
    rich: Vec<String>,
    rules: Vec<(String, String)>,
}

#[derive(Clone, Copy)]
struct IdInfo {
    key: Option<u64>,
    /// The element says it is a note (epub:type, role or class).
    notelike: bool,
}

/// What inline text collection notices besides the text.
struct Inl<'a> {
    path: &'a str,
    ids: Vec<(String, bool)>,
    images: Vec<(String, String, f32)>,
}

fn notelike(e: &ElementRef) -> bool {
    let check = |e: &ElementRef| {
        let t = e.attr("epub:type").unwrap_or("");
        let r = e.attr("role").unwrap_or("");
        t.contains("note") || r.contains("footnote") || r.contains("endnote") || e.value().classes().any(|c| {
            let c = c.to_ascii_lowercase();
            c.contains("footnote") || c.contains("endnote") || c == "foot" || c == "note"
        })
    };
    if check(e) {
        return true;
    }
    let mut p = e.parent().and_then(ElementRef::wrap);
    for _ in 0..2 {
        match p {
            Some(x) if check(&x) => return true,
            Some(x) => p = x.parent().and_then(ElementRef::wrap),
            None => break,
        }
    }
    false
}

/// An image element's source as a zip path, its description, and the pixel density of
/// the source chosen (the densest a srcset offers).
fn image_src(e: &ElementRef, path: &str) -> Option<(String, String, f32)> {
    let alt = e.attr("alt").unwrap_or("").trim().to_string();
    let mut best: Option<(&str, f32)> = e.attr("src").map(|s| (s, 1.0));
    if let Some(set) = e.attr("srcset") {
        for c in set.split(',') {
            let mut it = c.split_whitespace();
            if let (Some(u), d) = (it.next(), it.next()) {
                let d = d.and_then(|d| d.strip_suffix('x')).and_then(|d| d.parse::<f32>().ok()).unwrap_or(1.0);
                if best.is_none_or(|b| d > b.1) {
                    best = Some((u, d));
                }
            }
        }
    }
    let (src, d) = best?;
    if src.starts_with("data:") || src.contains("://") {
        return None;
    }
    Some((resolve(path, src), alt, d))
}

const SKIP: &[&str] = &[
    "script", "style", "head", "title", "svg", "math", "video", "audio", "iframe", "object", "picture", "canvas", "nav",
];
const BLOCK: &[&str] = &[
    "p", "div", "section", "article", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "figcaption",
    "header", "footer", "main", "dl", "dt", "dd", "hr", "center", "address", "body", "hgroup", "table",
];
const SKIP_CLASSES: &[&str] = &["pg-boilerplate", "pagenum", "pageno", "page-number", "footnotes", "x-ebookmaker-cover"];

fn has_class(e: &ElementRef, list: &[&str]) -> bool {
    e.value().classes().any(|c| list.iter().any(|l| c.eq_ignore_ascii_case(l)))
}

fn is_verse(e: &ElementRef) -> bool {
    e.value().classes().any(|c| {
        let c = c.to_ascii_lowercase();
        c.contains("poem") || c.contains("stanza") || c.contains("verse") || c.contains("poetry") || c == "lg"
    })
}

fn is_noteref(e: &ElementRef) -> bool {
    e.attr("epub:type").is_some_and(|t| t.contains("noteref")) || e.attr("role") == Some("doc-noteref")
}

impl Extractor {
    fn start_section(&mut self, label: Option<String>, matter: bool) {
        self.flush_para(Ctx::default());
        self.sections.push(RawSection { toc_label: label, blocks: Vec::new(), matter });
    }

    fn push(&mut self, kind: Kind, b: TextBuilder) -> Option<u64> {
        if b.is_empty() && kind != Kind::Break && kind != Kind::Image {
            return None;
        }
        if self.sections.is_empty() {
            self.sections.push(RawSection { toc_label: None, blocks: Vec::new(), matter: self.doc_matter });
        }
        let (text, runs, links) = b.finish_with_links();
        self.ordinal += 1;
        let key = self.file ^ self.ordinal.wrapping_mul(0x9e3779b97f4a7c15);
        for id in self.pending_ids.drain(..) {
            if let Some(i) = self.ids.get_mut(&id) {
                i.key.get_or_insert(key);
            }
        }
        self.first_of_file.entry(self.path.clone()).or_insert(key);
        if !links.is_empty() {
            self.raw_links.insert(key, links);
        }
        self.sections.last_mut().unwrap().blocks.push(RawBlock { block: Block::new(key, kind, text, runs) });
        Some(key)
    }

    /// A rich block (rich.rs): kept as an image whose bytes are its XHTML; its text is
    /// what it says, for find and for a screen reader.
    fn rich(&mut self, e: ElementRef) {
        if let Some(id) = e.value().id() {
            let full = format!("{}#{}", self.path, id);
            self.see_id(full, false);
        }
        let text: String = e.text().collect::<Vec<_>>().join(" ").split_whitespace().collect::<Vec<_>>().join(" ");
        let alt = e.attr("alttext").or(e.attr("aria-label")).map(str::to_string).unwrap_or(text);
        let n = self.rich.len();
        self.rich.push(rich::fragment(&e, &self.rules));
        self.push_image((format!("rich:{n}"), alt, 1.0));
    }

    fn push_image(&mut self, img: (String, String, f32)) {
        let mut b = TextBuilder::new();
        b.push(&img.1, 0);
        let idx = self.images.len() as u32;
        self.images.push(img);
        if self.push(Kind::Image, b).is_some() {
            self.sections.last_mut().unwrap().blocks.last_mut().unwrap().block.image = Some(idx);
        }
    }

    /// Takes what inline collection noticed: ids for the next block, images for after it.
    fn absorb(&mut self, cx: Inl) {
        for (id, nl) in cx.ids {
            self.see_id(id, nl);
        }
        self.after_para.extend(cx.images);
    }

    fn see_id(&mut self, full: String, notelike: bool) {
        self.ids.entry(full.clone()).or_insert(IdInfo { key: None, notelike });
        self.pending_ids.push(full);
    }

    fn flush_para(&mut self, ctx: Ctx) {
        if let Some(b) = self.para.take() {
            self.push(if ctx.quote { Kind::Q } else { Kind::P }, b);
        }
        for img in std::mem::take(&mut self.after_para) {
            self.push_image(img);
        }
    }

    fn check_target(&mut self, e: &ElementRef) {
        if let Some(id) = e.value().id() {
            if let Some(label) = self.targets.remove(id) {
                self.start_section(Some(label), matter_of(e));
            }
        }
    }

    fn walk(&mut self, el: ElementRef, ctx: Ctx) {
        for child in el.children() {
            match child.value() {
                Node::Text(t) => {
                    if !t.trim().is_empty() {
                        self.para.get_or_insert_with(TextBuilder::new).push(t, 0);
                    } else if let Some(p) = self.para.as_mut() {
                        p.push(" ", 0);
                    }
                }
                Node::Element(_) => {
                    let e = ElementRef::wrap(child).unwrap();
                    let name = e.value().name().to_ascii_lowercase();
                    if e.attr("id") == Some("pg-header") || e.attr("id") == Some("pg-footer") || has_class(&e, SKIP_CLASSES) || css::hidden(&e) {
                        continue;
                    }
                    // a footnote kept out of the flow (EPUB 3): kept as a note
                    if name == "aside" {
                        if let (true, Some(id)) = (notelike(&e), e.value().id()) {
                            let mut b = TextBuilder::new();
                            let mut cx = Inl { path: &self.path, ids: vec![], images: vec![] };
                            inline(e, &mut b, 0, &mut cx);
                            self.asides.insert(format!("{}#{}", self.path, id), b.finish_with_links());
                        }
                        continue;
                    }
                    if name == "figure" || name == "img" {
                        self.flush_para(ctx);
                        self.figure(e);
                        continue;
                    }
                    // what the press cannot set from text: drawn as the publisher made it
                    if (name == "table" && rich::is_diagram_table(&e)) || (name == "svg" && rich::is_figure_svg(&e)) || name == "math" {
                        self.flush_para(ctx);
                        self.rich(e);
                        continue;
                    }
                    if name == "table" {
                        self.flush_para(ctx);
                        self.table(e);
                        continue;
                    }
                    if name == "pre" {
                        self.flush_para(ctx);
                        self.pre(e);
                        continue;
                    }
                    if SKIP.contains(&name.as_str()) {
                        continue;
                    }
                    if !BLOCK.contains(&name.as_str()) && !is_verse(&e) {
                        // inline content in block position joins the open paragraph
                        if contains_target(&e, &self.targets) {
                            self.flush_para(ctx);
                            self.check_target(&e);
                        }
                        let path = std::mem::take(&mut self.path);
                        let mut cx = Inl { path: &path, ids: vec![], images: vec![] };
                        let p = self.para.get_or_insert_with(TextBuilder::new);
                        inline(e, p, 0, &mut cx);
                        let cx = Inl { path: "", ids: cx.ids, images: cx.images };
                        self.path = path;
                        self.absorb(cx);
                        continue;
                    }
                    self.flush_para(ctx);
                    self.check_target(&e);
                    if let Some(id) = e.value().id() {
                        let full = format!("{}#{}", self.path, id);
                        self.see_id(full, notelike(&e));
                    }
                    self.block(e, &name, ctx);
                }
                _ => {}
            }
        }
    }

    /// A figure or a lone image: its images as image blocks, then its caption.
    fn figure(&mut self, e: ElementRef) {
        if let Some(id) = e.value().id() {
            let full = format!("{}#{}", self.path, id);
            self.see_id(full, false);
        }
        let imgs: Vec<_> = if e.value().name().eq_ignore_ascii_case("img") { vec![e] } else { e.descendent_elements().filter(|d| d.value().name().eq_ignore_ascii_case("img")).collect() };
        for img in imgs {
            if let Some(src) = image_src(&img, &self.path) {
                self.push_image(src);
            }
        }
        // a figure drawn in SVG, or a diagram in a table
        for d in e.descendent_elements() {
            let n = d.value().name().to_ascii_lowercase();
            if (n == "svg" && rich::is_figure_svg(&d)) || (n == "table" && rich::is_diagram_table(&d)) || n == "math" {
                self.rich(d);
            }
        }
        if let Some(cap) = e.descendent_elements().find(|d| d.value().name().eq_ignore_ascii_case("figcaption")) {
            let mut b = TextBuilder::new();
            let mut cx = Inl { path: &self.path, ids: vec![], images: vec![] };
            // a caption in italic, as captions are set (its own styles may still undo it)
            inline(cap, &mut b, css::apply(style::ITALIC, css::of(&cap)), &mut cx);
            let cx = Inl { path: "", ids: cx.ids, images: vec![] };
            self.absorb(cx);
            self.push(Kind::Center, b);
        }
    }

    /// A table: its rows and cells as one block (`Kind::Table`). Rows come from `tr` in
    /// order (a nested table is read as text in its cell); a row of `th` at the head is a
    /// header row, set in bold.
    fn table(&mut self, e: ElementRef) {
        if let Some(id) = e.value().id() {
            let full = format!("{}#{}", self.path, id);
            self.see_id(full, false);
        }
        let is = |x: &ElementRef, n: &str| x.value().name().eq_ignore_ascii_case(n);
        // the rows of this table, not of tables nested in its cells
        let mut rows: Vec<ElementRef> = Vec::new();
        fn rows_of<'a>(el: ElementRef<'a>, out: &mut Vec<ElementRef<'a>>) {
            for c in el.child_elements() {
                match c.value().name().to_ascii_lowercase().as_str() {
                    "tr" => out.push(c),
                    "thead" | "tbody" | "tfoot" => rows_of(c, out),
                    _ => {}
                }
            }
        }
        rows_of(e, &mut rows);
        let mut b = TextBuilder::new();
        let mut shape = vol_model::TableShape::default();
        let mut first_row = true;
        for tr in rows {
            let cells: Vec<ElementRef> = tr.child_elements().filter(|c| is(c, "td") || is(c, "th")).collect();
            if cells.is_empty() {
                continue;
            }
            if !first_row {
                b.newline();
            }
            let header = first_row && cells.iter().all(|c| is(c, "th"));
            let mut cols = 0u32;
            for (i, c) in cells.iter().enumerate() {
                if i > 0 {
                    b.cell();
                }
                let span = c.attr("colspan").and_then(|v| v.trim().parse::<u8>().ok()).unwrap_or(1).clamp(1, 20);
                shape.spans.push(span);
                cols += span as u32;
                // a cell is built on its own: its line breaks are U+2028 (a forced break the
                // breaker honours), so they never read as the table's row separators
                let mut cb = TextBuilder::new();
                self.collect(*c, &mut cb, if is(c, "th") { style::BOLD } else { 0 });
                let (t, mut r, mut l) = cb.finish_with_links();
                // (U+2028 is three bytes where '\n' was one: what lies after each moves on)
                let at = |o: u32| o + 2 * t.as_bytes()[..o as usize].iter().filter(|&&c| c == b'\n').count() as u32;
                for x in &mut r {
                    (x.start, x.end) = (at(x.start), at(x.end));
                }
                for x in &mut l {
                    (x.0, x.1) = (at(x.0), at(x.1));
                }
                b.append(&t.replace('\n', "\u{2028}"), &r, &l);
            }
            if header {
                shape.header_rows = 1;
            }
            shape.cols = shape.cols.max(cols);
            first_row = false;
        }
        if shape.spans.is_empty() || b.is_empty() {
            return;
        }
        if self.push(Kind::Table, b).is_some() {
            self.sections.last_mut().unwrap().blocks.last_mut().unwrap().block.table = Some(shape);
        }
    }

    /// Preformatted text: its lines and spaces as written (the leading newline HTML ignores
    /// is dropped, tabs become spaces to stops of eight, trailing spaces and blank lines go).
    fn pre(&mut self, e: ElementRef) {
        if let Some(id) = e.value().id() {
            let full = format!("{}#{}", self.path, id);
            self.see_id(full, false);
        }
        fn gather(el: ElementRef, out: &mut String) {
            for c in el.children() {
                match c.value() {
                    Node::Text(t) => out.push_str(t),
                    Node::Element(_) => {
                        let ce = ElementRef::wrap(c).unwrap();
                        let n = ce.value().name().to_ascii_lowercase();
                        if n == "br" {
                            out.push('\n');
                        } else if !SKIP.contains(&n.as_str()) {
                            gather(ce, out);
                        }
                    }
                    _ => {}
                }
            }
        }
        let mut raw = String::new();
        gather(e, &mut raw);
        let raw = raw.replace("\r\n", "\n").replace('\r', "\n");
        let raw = raw.strip_prefix('\n').unwrap_or(&raw);
        let mut lines: Vec<String> = raw
            .split('\n')
            .map(|l| {
                let mut out = String::new();
                for c in l.chars() {
                    if c == '\t' {
                        let n = 8 - out.chars().count() % 8;
                        out.extend(std::iter::repeat_n(' ', n));
                    } else if c != '\u{feff}' {
                        out.push(c);
                    }
                }
                out.trim_end().to_string()
            })
            .collect();
        while lines.last().is_some_and(|l| l.is_empty()) {
            lines.pop();
        }
        while lines.first().is_some_and(|l| l.is_empty()) {
            lines.remove(0);
        }
        if lines.is_empty() {
            return;
        }
        // indentation the whole block shares only moves it off the text's margin
        let common = lines.iter().filter(|l| !l.is_empty()).map(|l| l.len() - l.trim_start_matches(' ').len()).min().unwrap_or(0);
        let mut b = TextBuilder::new();
        b.append(&lines.iter().map(|l| l.get(common..).unwrap_or("")).collect::<Vec<_>>().join("\n"), &[], &[]);
        self.push(Kind::Pre, b);
    }

    /// Text collected inline from `e`, with what it noticed absorbed.
    fn collect(&mut self, e: ElementRef, b: &mut TextBuilder, st: u8) {
        let n = e.value().name().as_bytes();
        let heading = n.len() == 2 && n[0].eq_ignore_ascii_case(&b'h') && n[1].is_ascii_digit();
        let st = if heading { st } else { css::apply(st, css::of(&e)) };
        let path = std::mem::take(&mut self.path);
        let mut cx = Inl { path: &path, ids: vec![], images: vec![] };
        inline(e, b, st, &mut cx);
        let cx = Inl { path: "", ids: cx.ids, images: cx.images };
        self.path = path;
        self.absorb(cx);
    }

    fn block(&mut self, e: ElementRef, name: &str, ctx: Ctx) {
        if name == "hr" {
            self.push(Kind::Break, TextBuilder::new());
            return;
        }
        if name.strip_prefix('h').and_then(|d| d.parse::<u8>().ok()).is_some() {
            let mut b = TextBuilder::new();
            self.collect(e, &mut b, 0);
            self.push(Kind::H, b);
            self.flush_para(ctx);
            return;
        }
        if is_verse(&e) {
            // stanza containers: recurse so each stanza is its own block
            if e.child_elements().any(|c| is_verse(&c) && BLOCK.contains(&c.value().name())) {
                self.walk(e, ctx);
                return;
            }
            let mut b = TextBuilder::new();
            self.collect(e, &mut b, 0);
            let (text, runs) = b.finish();
            // a last line that starts with a dash is the attribution
            let (lines, attrib) = match text.rfind('\n') {
                Some(i) if text[i + 1..].trim_start().starts_with(['—', '-']) => (i, Some(i + 1)),
                _ => (text.len(), None),
            };
            let mut v = TextBuilder::new();
            push_slice(&mut v, &text, &runs, 0, lines);
            self.push(Kind::Verse, v);
            if let Some(a) = attrib {
                let mut t = TextBuilder::new();
                push_slice(&mut t, &text, &runs, a, text.len());
                self.push(Kind::Attrib, t);
            }
            return;
        }
        let has_block_child = e.child_elements().any(|c| {
            let n = c.value().name().to_ascii_lowercase();
            BLOCK.contains(&n.as_str()) || is_verse(&c) || contains_target(&c, &self.targets)
        });
        if has_block_child {
            let c = Ctx { quote: ctx.quote || name == "blockquote", li: ctx.li };
            self.walk(e, c);
            self.flush_para(c);
            return;
        }
        let mut b = TextBuilder::new();
        self.collect(e, &mut b, 0);
        // the publisher's alignment where a style sheet gives it, else what the class says
        let align = css::of(&e).align;
        let kind = if name == "li" {
            Kind::Li
        } else if ctx.quote || name == "blockquote" {
            Kind::Q
        } else if align == Some(1) || (align.is_none() && e.value().classes().any(|c| c.contains("center") || c.contains("centre"))) {
            Kind::Center
        } else if align == Some(2) {
            Kind::Attrib
        } else if align.is_none() && e.value().classes().any(|c| c.contains("right") || c.contains("signature") || c.contains("sign")) {
            Kind::Sign
        } else {
            Kind::P
        };
        self.push(kind, b);
        self.flush_para(ctx);
    }
}

fn contains_target(e: &ElementRef, targets: &HashMap<String, String>) -> bool {
    if targets.is_empty() {
        return false;
    }
    e.value().id().is_some_and(|id| targets.contains_key(id)) || e.descendent_elements().any(|d| d.value().id().is_some_and(|id| targets.contains_key(id)))
}

fn push_slice(b: &mut TextBuilder, text: &str, runs: &[vol_model::Run], from: usize, to: usize) {
    let mut at = from;
    for r in runs {
        let (s, e) = ((r.start as usize).max(from), (r.end as usize).min(to));
        if s >= e {
            continue;
        }
        if s > at {
            push_lines(b, &text[at..s], 0);
        }
        push_lines(b, &text[s..e], r.style);
        at = e;
    }
    if at < to {
        push_lines(b, &text[at..to], 0);
    }
}

fn push_lines(b: &mut TextBuilder, s: &str, st: u8) {
    for (i, l) in s.split('\n').enumerate() {
        if i > 0 {
            b.newline();
        }
        b.push(l, st);
    }
}

fn inline(e: ElementRef, b: &mut TextBuilder, st: u8, cx: &mut Inl) {
    for child in e.children() {
        match child.value() {
            Node::Text(t) => b.push(t, st),
            Node::Element(_) => {
                let c = ElementRef::wrap(child).unwrap();
                let n = c.value().name().to_ascii_lowercase();
                if let Some(id) = c.value().id() {
                    cx.ids.push((format!("{}#{}", cx.path, id), notelike(&c)));
                }
                if n == "img" {
                    if let Some(src) = image_src(&c, cx.path) {
                        cx.images.push(src);
                    }
                    continue;
                }
                if SKIP.contains(&n.as_str()) || has_class(&c, SKIP_CLASSES) || css::hidden(&c) {
                    continue;
                }
                // a table inside a cell is read as text, cell by cell
                if n == "td" || n == "th" {
                    b.push(" ", st);
                }
                let s = match n.as_str() {
                    "br" => {
                        b.newline();
                        continue;
                    }
                    "em" | "i" | "cite" | "dfn" | "var" => st ^ style::ITALIC,
                    "strong" | "b" => st | style::BOLD,
                    "sup" => st | style::SUP,
                    "sub" => st | style::SUB,
                    _ if c.value().classes().any(|k| {
                        let k = k.to_ascii_lowercase();
                        k == "smcap" || k == "smcaps" || k == "sc" || k.contains("smallcap") || k.contains("small-caps")
                    }) =>
                    {
                        st | style::SMALLCAPS
                    }
                    _ => st,
                };
                let s = css::apply(s, css::of(&c));
                // a link: "u|url" for the web, else "<1 if marked a note reference>|<target path#frag>|<own path#id>"
                let link = if n == "a" {
                    c.attr("href").map(|h| {
                        if h.contains("://") || h.starts_with("mailto:") {
                            format!("u|{h}")
                        } else {
                            let (f, frag) = split_href(h);
                            let file = if f.is_empty() { cx.path.to_string() } else { resolve(cx.path, f) };
                            let own = c.value().id().map(|i| format!("{}#{}", cx.path, i)).unwrap_or_default();
                            format!("{}|{}{}|{}", is_noteref(&c) as u8, file, frag.map(|f| format!("#{f}")).unwrap_or_default(), own)
                        }
                    })
                } else {
                    None
                };
                if let Some(l) = &link {
                    b.begin_link(l.clone());
                }
                if BLOCK.contains(&n.as_str()) {
                    b.newline();
                    inline(c, b, s, cx);
                    b.newline();
                } else {
                    inline(c, b, s, cx);
                }
                if link.is_some() {
                    b.end_link();
                }
            }
            _ => {}
        }
    }
}

/// Turns found sections into chapters: headings become labels and titles, title pages,
/// contents lists and part-only sections are folded away.
fn shape_sections(raw: Vec<RawSection>, meta: &Meta) -> Vec<Section> {
    let norm = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    let (nt, na) = (norm(&meta.title), norm(&meta.author));
    let mut out: Vec<Section> = Vec::new();
    let mut part = String::new();
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
        let prose_words: usize = blocks.iter().filter(|b| b.block.kind != Kind::H).map(|b| b.block.text.split_whitespace().count()).sum();
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
        if prose_words < 15 {
            // a part heading ("Book I. Miss Brooke") or a title page: carry the part on
            if !h.label.is_empty() && blocks.iter().all(|b| b.block.kind == Kind::H || b.block.text.split_whitespace().count() < 8) {
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
            if blocks.iter().map(|b| b.text.split_whitespace().count()).sum::<usize>() < 15 {
                continue;
            }
            let ded = blocks.first().is_some_and(|b| b.text.starts_with("To ") || b.text.starts_with("TO "));
            h = heads::Head { label: String::new(), num: String::new(), title: if ded { "Dedication".into() } else { "Front matter".into() } };
        }
        if let Some(i) = blocks.iter().position(|b| b.kind == Kind::P) {
            if !front {
                vol_model::apply_lead_in(&mut blocks[i]);
            }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apparatus_by_semantics() {
        let doc = Html::parse_document(r#"<body><section epub:type="colophon">a</section><section role="doc-endnotes">b</section><section epub:type="preface">c</section><section epub:type="chapter">d</section><section epub:type="bodymatter">e</section></body>"#);
        let got: Vec<bool> = elements(&doc, "section").map(|e| matter_of(&e)).collect();
        assert_eq!(got, [true, true, false, false, false]);
    }

    #[test]
    fn expands_self_closing() {
        assert_eq!(expand_self_closing(r#"<h2><a id="x"/>Hi<br/></h2><p a='/>'/>"#), r#"<h2><a id="x"></a>Hi<br/></h2><p a='/>'></p>"#);
    }

    #[test]
    fn resolves_paths() {
        assert_eq!(resolve("OEBPS/content.opf", "text/ch1.xhtml"), "OEBPS/text/ch1.xhtml");
        assert_eq!(resolve("OEBPS/text/nav.xhtml", "../ch%201.xhtml"), "OEBPS/ch 1.xhtml");
    }
}
