//! The walk through each XHTML document: blocks, their styled text, notes, pictures.
use super::*;

/// A section as found, before headings are interpreted.
pub(super) struct RawSection {
    pub(super) toc_label: Option<String>,
    pub(super) blocks: Vec<RawBlock>,
    /// The book says this is apparatus, not reading (an imprint, a colophon, a copyright
    /// page, endnotes: `matter_of`): unnumbered, without a chapter head.
    pub(super) matter: bool,
}

/// Whether an element's semantics (EPUB 3 `epub:type`, DPUB-ARIA `role`) make it
/// apparatus rather than something to read as a chapter. Prefaces, introductions,
/// appendices and the like stay chapters: they are read.
pub(super) fn matter_of(e: &ElementRef) -> bool {
    const APPARATUS: &[&str] = &[
        "imprint", "colophon", "copyright-page", "titlepage", "halftitlepage", "seriespage", "dedication", "epigraph",
        "endnotes", "footnotes", "rearnotes", "loi", "lot", "index", "credits", "contributors", "other-credits", "errata", "acknowledgments", "toc",
    ];
    let t = e.attr("epub:type").unwrap_or("");
    let r = e.attr("role").unwrap_or("");
    t.split_whitespace().any(|w| APPARATUS.contains(&w)) || r.split_whitespace().any(|w| w.strip_prefix("doc-").is_some_and(|w| APPARATUS.contains(&w)))
}

pub(super) struct RawBlock {
    pub(super) block: Block,
}

#[derive(Clone, Copy, Default)]
pub(super) struct Ctx {
    pub(super) quote: bool,
    pub(super) li: bool,
}

#[derive(Default)]
pub(super) struct Extractor {
    pub(super) sections: Vec<RawSection>,
    /// The document being read is apparatus (`matter_of` its body or first section).
    pub(super) doc_matter: bool,
    pub(super) targets: HashMap<String, String>,
    pub(super) file: u64,
    pub(super) ordinal: u64,
    pub(super) para: Option<TextBuilder>,
    /// The document being read (zip path), against which links resolve.
    pub(super) path: String,
    /// Ids seen since the last block, and every id as `path#id` → the block it opens.
    pub(super) pending_ids: Vec<String>,
    pub(super) ids: HashMap<String, IdInfo>,
    pub(super) first_of_file: HashMap<String, u64>,
    /// Links as found, per block key: range and payload (see `Inl::link`).
    pub(super) raw_links: HashMap<u64, Vec<(u32, u32, String)>>,
    /// Footnotes printed nowhere in the flow (EPUB 3 asides): `path#id` → text.
    pub(super) asides: HashMap<String, (String, Vec<vol_model::Run>, Vec<(u32, u32, String)>)>,
    /// Images to read once the walk is done: path, description, pixel density.
    pub(super) images: Vec<(String, String, f32)>,
    /// Images met inside a paragraph, set after it.
    pub(super) after_para: Vec<(String, String, f32)>,
    /// Rich blocks' XHTML (`rich:<n>` among the images), and the rules of the document
    /// being read, as written, for them.
    pub(super) rich: Vec<String>,
    pub(super) rules: Vec<(String, String)>,
}

#[derive(Clone, Copy)]
pub(super) struct IdInfo {
    pub(super) key: Option<u64>,
    /// The element says it is a note (epub:type, role or class).
    pub(super) notelike: bool,
}

/// What inline text collection notices besides the text.
pub(super) struct Inl<'a> {
    pub(super) path: &'a str,
    pub(super) ids: Vec<(String, bool)>,
    pub(super) images: Vec<(String, String, f32)>,
}

pub(super) fn notelike(e: &ElementRef) -> bool {
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
pub(super) fn image_src(e: &ElementRef, path: &str) -> Option<(String, String, f32)> {
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

pub(super) const SKIP: &[&str] = &[
    "script", "style", "head", "title", "svg", "math", "video", "audio", "iframe", "object", "picture", "canvas", "nav",
];
pub(super) const BLOCK: &[&str] = &[
    "p", "div", "section", "article", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "figcaption",
    "header", "footer", "main", "dl", "dt", "dd", "hr", "center", "address", "body", "hgroup", "table",
];
pub(super) const SKIP_CLASSES: &[&str] = &["pg-boilerplate", "pagenum", "pageno", "page-number", "footnotes", "x-ebookmaker-cover"];

pub(super) fn has_class(e: &ElementRef, list: &[&str]) -> bool {
    e.value().classes().any(|c| list.iter().any(|l| c.eq_ignore_ascii_case(l)))
}

pub(super) fn is_verse(e: &ElementRef) -> bool {
    e.value().classes().any(|c| {
        let c = c.to_ascii_lowercase();
        c.contains("poem") || c.contains("stanza") || c.contains("verse") || c.contains("poetry") || c == "lg"
    })
}

pub(super) fn is_noteref(e: &ElementRef) -> bool {
    e.attr("epub:type").is_some_and(|t| t.contains("noteref")) || e.attr("role") == Some("doc-noteref")
}

impl Extractor {
    pub(super) fn start_section(&mut self, label: Option<String>, matter: bool) {
        self.flush_para(Ctx::default());
        self.sections.push(RawSection { toc_label: label, blocks: Vec::new(), matter });
    }

    pub(super) fn push(&mut self, kind: Kind, b: TextBuilder) -> Option<u64> {
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
    pub(super) fn rich(&mut self, e: ElementRef) {
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

    pub(super) fn push_image(&mut self, img: (String, String, f32)) {
        let mut b = TextBuilder::new();
        b.push(&img.1, 0);
        let idx = self.images.len() as u32;
        self.images.push(img);
        if self.push(Kind::Image, b).is_some() {
            self.sections.last_mut().unwrap().blocks.last_mut().unwrap().block.image = Some(idx);
        }
    }

    /// Takes what inline collection noticed: ids for the next block, images for after it.
    pub(super) fn absorb(&mut self, cx: Inl) {
        for (id, nl) in cx.ids {
            self.see_id(id, nl);
        }
        self.after_para.extend(cx.images);
    }

    pub(super) fn see_id(&mut self, full: String, notelike: bool) {
        self.ids.entry(full.clone()).or_insert(IdInfo { key: None, notelike });
        self.pending_ids.push(full);
    }

    pub(super) fn flush_para(&mut self, ctx: Ctx) {
        if let Some(b) = self.para.take() {
            self.push(if ctx.quote { Kind::Q } else { Kind::P }, b);
        }
        for img in std::mem::take(&mut self.after_para) {
            self.push_image(img);
        }
    }

    pub(super) fn check_target(&mut self, e: &ElementRef) {
        if let Some(id) = e.value().id()
            && let Some(label) = self.targets.remove(id) {
                self.start_section(Some(label), matter_of(e));
            }
    }

    pub(super) fn walk(&mut self, el: ElementRef, ctx: Ctx) {
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
    pub(super) fn figure(&mut self, e: ElementRef) {
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
    pub(super) fn table(&mut self, e: ElementRef) {
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
    pub(super) fn pre(&mut self, e: ElementRef) {
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
    pub(super) fn collect(&mut self, e: ElementRef, b: &mut TextBuilder, st: u8) {
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

    pub(super) fn block(&mut self, e: ElementRef, name: &str, ctx: Ctx) {
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

pub(super) fn contains_target(e: &ElementRef, targets: &HashMap<String, String>) -> bool {
    if targets.is_empty() {
        return false;
    }
    e.value().id().is_some_and(|id| targets.contains_key(id)) || e.descendent_elements().any(|d| d.value().id().is_some_and(|id| targets.contains_key(id)))
}

pub(super) fn push_slice(b: &mut TextBuilder, text: &str, runs: &[vol_model::Run], from: usize, to: usize) {
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

pub(super) fn push_lines(b: &mut TextBuilder, s: &str, st: u8) {
    for (i, l) in s.split('\n').enumerate() {
        if i > 0 {
            b.newline();
        }
        b.push(l, st);
    }
}

pub(super) fn inline(e: ElementRef, b: &mut TextBuilder, st: u8, cx: &mut Inl) {
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
