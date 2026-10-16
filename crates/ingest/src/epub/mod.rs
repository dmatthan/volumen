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
use vol_model::{Block, Kind, Meta, Section, SectionKind, TextBuilder, fnv64, percent_decode, style};

mod images;
mod links;
mod sections;
mod xhtml;

use images::*;
use links::*;
use sections::*;
use xhtml::*;

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

/// Whether a shop's DRM locks the book: its encryption.xml enciphers more than fonts
/// (the IDPF's and Adobe's obfuscation of a font, for its licence, is not a lock), or it
/// carries Apple's (sinf.xml).
fn locked(z: &mut Zip) -> bool {
    if z.text("META-INF/sinf.xml").is_some() {
        return true;
    }
    let Some(enc) = z.text("META-INF/encryption.xml") else { return false };
    let d = Html::parse_document(&enc);
    let named = |e: &ElementRef, n: &str| e.value().name().rsplit(':').next().is_some_and(|l| l.eq_ignore_ascii_case(n));
    d.root_element().descendent_elements().filter(|e| named(e, "encrypteddata")).any(|e| {
        let alg = e.descendent_elements().find(|m| named(m, "encryptionmethod")).and_then(|m| m.attr("algorithm")).unwrap_or("");
        !(alg.contains("idpf.org/2008/embedding") || alg.contains("ns.adobe.com/pdf/enc#RC"))
    })
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
    if locked(&mut z) {
        return Err(Error::Unreadable("it is locked by the shop that sold it (DRM), and Volumen reads only books without DRM"));
    }
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
    if let Some((t, sub)) = meta.title.split_once(" / ").or_else(|| meta.title.split_once(": ")).or_else(|| meta.title.split_once("; "))
        && !t.is_empty() && sub.len() < 80 {
            let (t, sub) = (t.to_string(), sub.to_string());
            meta.title = t;
            meta.subtitle = sub;
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
    if let Some(nav) = manifest.values().find(|m| m.props.split_whitespace().any(|p| p == "nav"))
        && let Some(src) = z.text(&nav.href) {
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
    if toc.is_empty() {
        let ncx = elements(&opf, "spine").find_map(|e| e.attr("toc")).and_then(|id| manifest.get(id)).map(|m| m.href.clone()).or_else(|| {
            manifest.values().find(|m| m.media == "application/x-dtbncx+xml").map(|m| m.href.clone())
        });
        if let Some(p) = ncx
            && let Some(src) = z.text(&p) {
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
            if l.attr("rel").is_some_and(|r| r.to_ascii_lowercase().contains("stylesheet"))
                && let Some(h) = l.attr("href") {
                    let p = resolve(path, split_href(h).0);
                    if !sheets.contains_key(&p) {
                        let parsed = z.text(&p).map(|t| css::parse_sheet(&t)).unwrap_or_default();
                        sheets.insert(p.clone(), parsed);
                    }
                    linked.push(p);
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

fn split_href(h: &str) -> (&str, Option<String>) {
    match h.split_once('#') {
        Some((f, frag)) => (f, if frag.is_empty() { None } else { Some(percent_decode(frag)) }),
        None => (h, None),
    }
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
