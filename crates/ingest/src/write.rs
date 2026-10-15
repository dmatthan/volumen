//! A book written out as an EPUB 3, from Volumen's own model: the text with its styles,
//! headings, quotations, verse, lists, tables, images and notes, in plain XHTML and a
//! small stylesheet. What it is for first: a sample of a few chapters, so an author puts
//! only those online (the kit, docs/PLAN.md N13); and it reads back as the same book.

use std::io::Write;
use vol_model::{Block, Book, Kind, SectionKind, Target, style};

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// A block's text as XHTML: styles as elements, notes as note references (`notes` gathers
/// the ones this chapter refers to), outside links as links; line breaks as `<br/>`.
fn inline(b: &Block, notes: &mut Vec<u32>) -> String {
    let t = &b.text;
    let mut cuts: Vec<usize> = vec![0, t.len()];
    for r in &b.runs {
        cuts.extend([r.start as usize, r.end as usize]);
    }
    for l in &b.links {
        cuts.extend([l.start as usize, l.end as usize]);
    }
    cuts.retain(|&c| c <= t.len() && t.is_char_boundary(c));
    cuts.sort();
    cuts.dedup();
    let mut out = String::new();
    for w in cuts.windows(2) {
        let (s, e) = (w[0], w[1]);
        if s == e {
            continue;
        }
        let st = b.runs.iter().find(|r| (r.start as usize) <= s && (r.end as usize) >= e).map_or(0, |r| r.style);
        let mut piece = esc(&t[s..e]).replace(['\n', '\u{2028}'], "<br/>");
        for (bit, open, close) in [(style::SMALLCAPS, "<span class=\"sc\">", "</span>"), (style::BOLD, "<b>", "</b>"), (style::ITALIC, "<i>", "</i>"), (style::SUP, "<sup>", "</sup>"), (style::SUB, "<sub>", "</sub>")] {
            if st & bit != 0 {
                piece = format!("{open}{piece}{close}");
            }
        }
        match b.links.iter().find(|l| (l.start as usize) <= s && (l.end as usize) >= e).map(|l| &l.to) {
            Some(Target::Note(n)) => {
                if !notes.contains(n) {
                    notes.push(*n);
                }
                piece = format!("<a epub:type=\"noteref\" href=\"#n{n}\">{piece}</a>");
            }
            Some(Target::Url(u)) if u.starts_with("http://") || u.starts_with("https://") || u.starts_with("mailto:") => {
                piece = format!("<a href=\"{}\">{piece}</a>", esc(u));
            }
            _ => {}
        }
        out.push_str(&piece);
    }
    out
}

/// A table block as a table: rows by '\n', cells by '\t', each cell's column span.
fn table(b: &Block, notes: &mut Vec<u32>) -> String {
    let shape = b.table.clone().unwrap_or_default();
    let mut out = String::from("<table>");
    let mut cell = 0usize;
    let mut row_start = 0usize;
    for (ri, row) in b.text.split('\n').enumerate() {
        out.push_str("<tr>");
        let mut at = row_start;
        for c in row.split('\t') {
            let span = shape.spans.get(cell).copied().unwrap_or(1);
            let tag = if (ri as u32) < shape.header_rows { "th" } else { "td" };
            let sub = Block { text: c.to_string(), runs: shift(b, at, at + c.len()), links: Vec::new(), ..Block::new(0, Kind::P, String::new(), Vec::new()) };
            let span_attr = if span > 1 { format!(" colspan=\"{span}\"") } else { String::new() };
            out.push_str(&format!("<{tag}{span_attr}>{}</{tag}>", inline(&sub, notes)));
            at += c.len() + 1;
            cell += 1;
        }
        out.push_str("</tr>");
        row_start += row.len() + 1;
    }
    out.push_str("</table>");
    out
}

/// The runs of a block inside [s, e), counted from s.
fn shift(b: &Block, s: usize, e: usize) -> Vec<vol_model::Run> {
    b.runs
        .iter()
        .filter(|r| (r.end as usize) > s && (r.start as usize) < e)
        .map(|r| vol_model::Run { start: (r.start as usize).max(s) as u32 - s as u32, end: (r.end as usize).min(e) as u32 - s as u32, style: r.style })
        .collect()
}

fn ext(mime: &str) -> &str {
    match mime {
        "image/png" => "png",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        _ => "jpg",
    }
}

const RICH: &str = "application/xhtml+xml";

const CSS: &str = "body { font-family: serif; line-height: 1.5; margin: 0 5%; }
h1 { font-size: 1.5em; margin: 2em 0 1.5em; text-align: center; font-weight: normal; }
h1 .label { display: block; font-size: .7em; letter-spacing: .1em; text-transform: uppercase; margin-bottom: .5em; }
h2 { font-size: 1.1em; margin: 1.5em 0 .75em; }
p { margin: 0; text-indent: 1.4em; }
h1 + p, h2 + p, hr + p, blockquote + p, figure + p, table + p, .center, .attrib, .sign, .verse { text-indent: 0; }
.sc { font-variant: small-caps; }
blockquote { margin: 1em 2em; }
.verse { margin: .5em 0 .5em 2em; }
.attrib, .sign { text-align: right; }
.attrib { font-style: italic; }
.sign { font-variant: small-caps; }
.center { text-align: center; }
hr { border: 0; margin: 1.5em 0; text-align: center; }
hr::after { content: '⁂'; }
figure { margin: 1em 0; text-align: center; }
figure img { max-width: 100%; }
table { border-collapse: collapse; margin: 1em auto; }
td, th { border-bottom: 1px solid #ccc; padding: .2em .6em; text-align: left; vertical-align: top; }
aside { font-size: .9em; margin-top: 1em; }
";

/// The book as an EPUB 3 file.
pub fn epub(book: &Book) -> Result<Vec<u8>, String> {
    let lang = if book.meta.lang.is_empty() { "en" } else { book.meta.lang.as_str() };
    let mut files: Vec<(String, Vec<u8>)> = Vec::new();
    let mut nav = String::new();
    let mut spine = String::new();
    let mut manifest = String::new();
    let mut images_used: Vec<u32> = Vec::new();
    for (si, sec) in book.sections.iter().enumerate() {
        let name = format!("s{:03}.xhtml", si + 1);
        let heading = match (sec.label.is_empty(), sec.title.is_empty()) {
            (false, false) => format!("<span class=\"label\">{}</span>{}", esc(&sec.label), esc(&sec.title)),
            (false, true) => esc(&sec.label),
            (true, false) => esc(&sec.title),
            _ => String::new(),
        };
        let toc = [sec.label.as_str(), sec.title.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(": ");
        let toc = if toc.is_empty() { format!("{} {}", if sec.kind == SectionKind::Chapter { "Chapter" } else { "Part" }, si + 1) } else { toc };
        let mut body = String::new();
        if !heading.is_empty() && sec.kind == SectionKind::Chapter {
            body.push_str(&format!("<h1>{heading}</h1>\n"));
        }
        let mut notes: Vec<u32> = Vec::new();
        let mut in_list = false;
        for b in &sec.blocks {
            if in_list && b.kind != Kind::Li {
                body.push_str("</ul>\n");
                in_list = false;
            }
            let html = match b.kind {
                Kind::P => format!("<p>{}</p>", inline(b, &mut notes)),
                Kind::H => format!("<h2>{}</h2>", inline(b, &mut notes)),
                Kind::Q => format!("<blockquote><p>{}</p></blockquote>", inline(b, &mut notes)),
                Kind::Li => {
                    let open = if in_list { "" } else { "<ul>" };
                    in_list = true;
                    format!("{open}<li>{}</li>", inline(b, &mut notes))
                }
                Kind::Verse => format!("<p class=\"verse\">{}</p>", inline(b, &mut notes)),
                Kind::Attrib => format!("<p class=\"attrib\">{}</p>", inline(b, &mut notes)),
                Kind::Sign => format!("<p class=\"sign\">{}</p>", inline(b, &mut notes)),
                Kind::Center => format!("<p class=\"center\">{}</p>", inline(b, &mut notes)),
                Kind::Break => "<hr/>".to_string(),
                Kind::Table => table(b, &mut notes),
                Kind::Pre => format!("<pre>{}</pre>", esc(&b.text)),
                Kind::Image => match b.image.and_then(|i| book.images.get(i as usize).map(|im| (i, im))) {
                    Some((_, im)) if im.mime == RICH => format!("<div>{}</div>", String::from_utf8_lossy(&im.bytes)),
                    Some((i, im)) if !im.bytes.is_empty() => {
                        if !images_used.contains(&i) {
                            images_used.push(i);
                        }
                        format!("<figure><img src=\"img{i}.{}\" alt=\"{}\"/></figure>", ext(&im.mime), esc(&im.alt))
                    }
                    _ => String::new(),
                },
            };
            body.push_str(&html);
            body.push('\n');
        }
        if in_list {
            body.push_str("</ul>\n");
        }
        // the notes this chapter refers to, at its end
        for n in &notes {
            if let Some(note) = book.notes.get(*n as usize) {
                let nb = Block { text: note.text.clone(), runs: note.runs.clone(), ..Block::new(0, Kind::P, String::new(), Vec::new()) };
                body.push_str(&format!("<aside epub:type=\"footnote\" id=\"n{n}\"><p>{}. {}</p></aside>\n", esc(&note.label), inline(&nb, &mut Vec::new())));
            }
        }
        let epub_type = if sec.kind == SectionKind::Chapter { "chapter" } else { "frontmatter" };
        let doc = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"{lang}\" lang=\"{lang}\">\n<head><title>{}</title><link rel=\"stylesheet\" href=\"style.css\"/></head>\n<body><section epub:type=\"{epub_type}\">\n{body}</section></body>\n</html>\n",
            esc(&toc)
        );
        files.push((name.clone(), doc.into_bytes()));
        manifest.push_str(&format!("<item id=\"s{si}\" href=\"{name}\" media-type=\"application/xhtml+xml\"/>\n"));
        spine.push_str(&format!("<itemref idref=\"s{si}\"/>\n"));
        nav.push_str(&format!("<li><a href=\"{name}\">{}</a></li>\n", esc(&toc)));
    }
    for i in &images_used {
        let im = &book.images[*i as usize];
        let name = format!("img{i}.{}", ext(&im.mime));
        manifest.push_str(&format!("<item id=\"img{i}\" href=\"{name}\" media-type=\"{}\"/>\n", esc(&im.mime)));
        files.push((name, im.bytes.clone()));
    }
    let title = esc(&book.meta.title);
    let nav_doc = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE html>\n<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"{lang}\" lang=\"{lang}\">\n<head><title>{title}</title></head>\n<body><nav epub:type=\"toc\" id=\"toc\"><h1>Contents</h1><ol>\n{nav}</ol></nav></body>\n</html>\n"
    );
    let author = if book.meta.author.is_empty() { String::new() } else { format!("<dc:creator>{}</dc:creator>\n", esc(&book.meta.author)) };
    let opf = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"id\" xml:lang=\"{lang}\">\n<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n<dc:identifier id=\"id\">urn:volumen:{}</dc:identifier>\n<dc:title>{title}</dc:title>\n{author}<dc:language>{lang}</dc:language>\n<meta property=\"dcterms:modified\">2026-01-01T00:00:00Z</meta>\n</metadata>\n<manifest>\n<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>\n{manifest}</manifest>\n<spine>\n{spine}</spine>\n</package>\n",
        esc(&book.id)
    );

    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let stored = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let deflated = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut put = |name: &str, bytes: &[u8], opts| -> Result<(), String> {
        w.start_file(name, opts).map_err(|e| e.to_string())?;
        w.write_all(bytes).map_err(|e| e.to_string())
    };
    // (the mimetype first and unpacked, as the format asks)
    put("mimetype", b"application/epub+zip", stored)?;
    put("META-INF/container.xml", b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\"><rootfiles><rootfile full-path=\"OEBPS/content.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles></container>\n", deflated)?;
    put("OEBPS/content.opf", opf.as_bytes(), deflated)?;
    put("OEBPS/nav.xhtml", nav_doc.as_bytes(), deflated)?;
    put("OEBPS/style.css", CSS.as_bytes(), deflated)?;
    for (name, bytes) in &files {
        put(&format!("OEBPS/{name}"), bytes, deflated)?;
    }
    Ok(w.finish().map_err(|e| e.to_string())?.into_inner())
}

/// Chapters `from` to `to` (counted from 1) of a file, as an EPUB of their own: a sample.
pub fn sample(bytes: &[u8], name: &str, from: usize, to: usize) -> Result<Vec<u8>, String> {
    let mut book = crate::any(bytes, name).map_err(|e| e.to_string())?;
    let mut n = 0;
    book.sections.retain(|s| {
        if s.kind != SectionKind::Chapter {
            return false;
        }
        n += 1;
        n >= from && n <= to
    });
    if book.sections.is_empty() {
        return Err(format!("the book has no chapter {from}"));
    }
    book.id = format!("{}-sample-{from}-{to}", book.id);
    epub(&book)
}
