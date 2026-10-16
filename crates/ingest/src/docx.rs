//! Word documents (`.docx`, as Word, Google Docs, Pages and LibreOffice write them).
//!
//! Headings are known by their styles' built-in names ("heading 1", "Title") or outline
//! levels, which Word keeps in English whatever language it runs in; quotations and list
//! paragraphs likewise. A run's italic, bold, small capitals and superscript come from its
//! paragraph's style, its own style and its direct formatting, in that order. Footnotes
//! and endnotes become the book's notes. Tracked deletions are left out and insertions
//! kept; comments and field codes are skipped.

use crate::doc::{Doc, Para, assemble};
use crate::Error;
use quick_xml::events::{BytesStart, Event};
use quick_xml::reader::Reader;
use std::collections::HashMap;
use std::io::Read;
use vol_model::{Meta, TextBuilder, style};

#[derive(Default, Clone)]
struct Style {
    name: String,
    based_on: Option<String>,
    outline: Option<u8>,
    list: bool,
    /// Run properties: italic, bold, small capitals, vertical alignment (1 sup, 2 sub).
    i: Option<bool>,
    b: Option<bool>,
    sc: Option<bool>,
    va: Option<u8>,
}

#[derive(Default, Clone, Copy)]
struct RunProps {
    i: Option<bool>,
    b: Option<bool>,
    sc: Option<bool>,
    va: Option<u8>,
}

impl RunProps {
    fn over(self, top: RunProps) -> RunProps {
        RunProps { i: top.i.or(self.i), b: top.b.or(self.b), sc: top.sc.or(self.sc), va: top.va.or(self.va) }
    }
    fn style(self) -> u8 {
        let mut s = 0;
        if self.i == Some(true) {
            s |= style::ITALIC;
        }
        if self.b == Some(true) {
            s |= style::BOLD;
        }
        if self.sc == Some(true) {
            s |= style::SMALLCAPS;
        }
        match self.va {
            Some(1) => s |= style::SUP,
            Some(2) => s |= style::SUB,
            _ => {}
        }
        s
    }
}

fn local(name: &[u8]) -> &[u8] {
    name.rsplit(|&c| c == b':').next().unwrap_or(name)
}

fn attr(e: &BytesStart, key: &[u8]) -> Option<String> {
    e.attributes().flatten().find(|a| local(a.key.as_ref()) == key).and_then(|a| a.unescape_value().ok()).map(|v| v.into_owned())
}

/// A toggle property (`<w:i/>`, `<w:i w:val="0"/>`).
fn toggle(e: &BytesStart) -> bool {
    !matches!(attr(e, b"val").as_deref(), Some("0") | Some("false") | Some("off") | Some("none"))
}

fn read(z: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, path: &str) -> Option<String> {
    let mut f = z.by_name(path).ok()?;
    let mut s = String::new();
    f.read_to_string(&mut s).ok()?;
    Some(s)
}

fn styles(xml: &str) -> (HashMap<String, Style>, String) {
    let mut out: HashMap<String, Style> = HashMap::new();
    let mut lang = String::new();
    let mut r = Reader::from_str(xml);
    let mut cur: Option<(String, Style)> = None;
    let mut in_defaults = false;
    loop {
        match r.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                let n = local(e.name().as_ref()).to_vec();
                match n.as_slice() {
                    b"docDefaults" => in_defaults = true,
                    b"style" => cur = Some((attr(&e, b"styleId").unwrap_or_default(), Style::default())),
                    b"lang" if in_defaults && lang.is_empty() => lang = attr(&e, b"val").unwrap_or_default(),
                    _ => {
                        if let Some((_, s)) = cur.as_mut() {
                            match n.as_slice() {
                                b"name" => s.name = attr(&e, b"val").unwrap_or_default().to_lowercase(),
                                b"basedOn" => s.based_on = attr(&e, b"val"),
                                b"outlineLvl" => s.outline = attr(&e, b"val").and_then(|v| v.parse().ok()),
                                b"numPr" => s.list = true,
                                b"i" => s.i = Some(toggle(&e)),
                                b"b" => s.b = Some(toggle(&e)),
                                b"smallCaps" => s.sc = Some(toggle(&e)),
                                b"vertAlign" => s.va = attr(&e, b"val").map(|v| if v == "superscript" { 1 } else if v == "subscript" { 2 } else { 0 }),
                                _ => {}
                            }
                        }
                    }
                }
            }
            Ok(Event::End(e)) => match local(e.name().as_ref()) {
                b"docDefaults" => in_defaults = false,
                b"style" => {
                    if let Some((id, s)) = cur.take() {
                        out.insert(id, s);
                    }
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    (out, lang)
}

/// A style with what it inherits filled in.
fn resolved(styles: &HashMap<String, Style>, id: &str) -> Style {
    let mut chain = Vec::new();
    let mut at = Some(id.to_string());
    while let Some(i) = at {
        if chain.len() > 16 {
            break;
        }
        let Some(s) = styles.get(&i) else { break };
        chain.push(s.clone());
        at = s.based_on.clone();
    }
    let mut out = Style { name: chain.first().map(|s| s.name.clone()).unwrap_or_default(), ..Style::default() };
    for s in chain.iter().rev() {
        out.outline = s.outline.or(out.outline);
        out.list |= s.list;
        out.i = s.i.or(out.i);
        out.b = s.b.or(out.b);
        out.sc = s.sc.or(out.sc);
        out.va = s.va.or(out.va);
    }
    // a style's own name decides the heading level over an inherited outline
    out
}

fn props(s: &Style) -> RunProps {
    RunProps { i: s.i, b: s.b, sc: s.sc, va: s.va }
}

/// What a paragraph's style makes it: (heading level, quotation, list).
fn kind_of(s: &Style, direct_outline: Option<u8>) -> (Option<u8>, bool, bool) {
    let n = s.name.as_str();
    let level = if n == "title" {
        Some(0)
    } else if let Some(d) = n.strip_prefix("heading ").and_then(|d| d.trim().parse::<u8>().ok()) {
        Some(d)
    } else {
        direct_outline.or(s.outline).filter(|&o| o < 9).map(|o| o + 1)
    };
    // "Quote", "Intense Quote" (Word), "Block Quotation" (LibreOffice), "Block Text"
    (level, n.contains("quot") || n == "block text", s.list || n.starts_with("list"))
}

/// Paragraphs of a part of the document (the body, the footnotes): each with its style
/// and text; footnote references become linked markers.
struct Walk<'s> {
    styles: &'s HashMap<String, Style>,
    /// footnote and endnote ids to note indices, in order of first reference
    refs: &'s mut Vec<(bool, String)>,
}

impl Walk<'_> {
    fn note_index(&mut self, endnote: bool, id: String) -> usize {
        match self.refs.iter().position(|(e, i)| *e == endnote && *i == id) {
            Some(i) => i,
            None => {
                self.refs.push((endnote, id));
                self.refs.len() - 1
            }
        }
    }

    /// Paragraphs inside `xml`; in a notes part, grouped by note id.
    fn paragraphs(&mut self, xml: &str, notes_part: bool) -> Vec<(Option<String>, Para)> {
        let mut out = Vec::new();
        let mut r = Reader::from_str(xml);
        let mut note_id: Option<String> = None;
        let mut skip_note = false;
        // the paragraph being read
        let mut b: Option<TextBuilder> = None;
        let mut pstyle: Option<String> = None;
        let mut outline: Option<u8> = None;
        let mut list = false;
        let mut in_ppr = false;
        // the run being read
        let mut rstyle: Option<String> = None;
        let mut direct = RunProps::default();
        let mut in_rpr = false;
        // deletions and field codes are skipped
        let mut deleted = 0usize;
        let mut field_code = false;
        let mut in_text = false;
        loop {
            let ev = r.read_event();
            let (start, empty) = match &ev {
                Ok(Event::Start(_)) => (true, false),
                Ok(Event::Empty(_)) => (true, true),
                _ => (false, false),
            };
            match &ev {
                Ok(Event::Start(e)) | Ok(Event::Empty(e)) if start => {
                    let n = local(e.name().as_ref()).to_vec();
                    match n.as_slice() {
                        b"footnote" | b"endnote" if notes_part => {
                            note_id = attr(e, b"id");
                            skip_note = attr(e, b"type").is_some_and(|t| t != "normal");
                        }
                        b"p" if !empty => {
                            b = Some(TextBuilder::new());
                            pstyle = None;
                            outline = None;
                            list = false;
                        }
                        b"pPr" if !empty => in_ppr = true,
                        b"pStyle" if in_ppr => pstyle = attr(e, b"val"),
                        b"outlineLvl" if in_ppr => outline = attr(e, b"val").and_then(|v| v.parse().ok()),
                        b"numPr" if in_ppr => list = true,
                        b"r" if !empty => {
                            rstyle = None;
                            direct = RunProps::default();
                        }
                        b"rPr" if !empty && !in_ppr => in_rpr = true,
                        b"rStyle" if in_rpr => rstyle = attr(e, b"val"),
                        b"i" | b"iCs" if in_rpr && n == b"i" => direct.i = Some(toggle(e)),
                        b"b" if in_rpr => direct.b = Some(toggle(e)),
                        b"smallCaps" if in_rpr => direct.sc = Some(toggle(e)),
                        b"vertAlign" if in_rpr => direct.va = attr(e, b"val").map(|v| if v == "superscript" { 1 } else if v == "subscript" { 2 } else { 0 }),
                        b"del" | b"moveFrom" if !empty => deleted += 1,
                        b"fldChar" => match attr(e, b"fldCharType").as_deref() {
                            Some("begin") => field_code = true,
                            Some("separate") | Some("end") => field_code = false,
                            _ => {}
                        },
                        b"t" if !empty => in_text = true,
                        b"tab" if !in_ppr => self.push(&mut b, " ", &pstyle, &rstyle, direct, deleted, field_code),
                        b"br" | b"cr" => {
                            if !matches!(attr(e, b"type").as_deref(), Some("page") | Some("column")) && deleted == 0
                                && let Some(b) = b.as_mut() {
                                    b.newline();
                                }
                        }
                        b"noBreakHyphen" => self.push(&mut b, "\u{2011}", &pstyle, &rstyle, direct, deleted, field_code),
                        b"footnoteReference" | b"endnoteReference" if deleted == 0 => {
                            if let Some(id) = attr(e, b"id") {
                                let i = self.note_index(n == b"endnoteReference", id);
                                if let Some(b) = b.as_mut() {
                                    b.begin_link(format!("n:{i}"));
                                    b.push(&(i + 1).to_string(), style::SUP);
                                    b.end_link();
                                }
                            }
                        }
                        _ => {}
                    }
                }
                Ok(Event::Text(t)) if in_text && deleted == 0 && !field_code => {
                    let s = t.xml_content().map(|c| c.into_owned()).unwrap_or_default();
                    self.push(&mut b, &s, &pstyle, &rstyle, direct, deleted, field_code);
                }
                Ok(Event::GeneralRef(g)) if in_text && deleted == 0 && !field_code => {
                    // an entity in the text (&amp; and friends)
                    let name: &[u8] = g;
                    let s = match name {
                        b"amp" => "&",
                        b"lt" => "<",
                        b"gt" => ">",
                        b"quot" => "\"",
                        b"apos" => "'",
                        _ => "",
                    };
                    self.push(&mut b, s, &pstyle, &rstyle, direct, deleted, field_code);
                }
                Ok(Event::End(e)) => match local(e.name().as_ref()) {
                    b"t" => in_text = false,
                    b"pPr" => in_ppr = false,
                    b"rPr" => in_rpr = false,
                    b"del" | b"moveFrom" => deleted = deleted.saturating_sub(1),
                    b"p" => {
                        if let Some(tb) = b.take() {
                            if notes_part && skip_note {
                                continue;
                            }
                            let st = pstyle.as_deref().map(|s| resolved(self.styles, s)).unwrap_or_default();
                            let (level, quote, item) = kind_of(&st, outline);
                            let para = match level {
                                Some(l) if !tb.is_empty() && !notes_part => Para::Heading(l, tb),
                                _ if quote => Para::Quote(tb),
                                _ if item || list => Para::Item(tb),
                                _ => Para::P(tb),
                            };
                            out.push((note_id.clone(), para));
                        }
                    }
                    _ => {}
                },
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn push(&self, b: &mut Option<TextBuilder>, s: &str, pstyle: &Option<String>, rstyle: &Option<String>, direct: RunProps, deleted: usize, field_code: bool) {
        if deleted > 0 || field_code || s.is_empty() {
            return;
        }
        let Some(b) = b.as_mut() else { return };
        let p = pstyle.as_deref().map(|s| props(&resolved(self.styles, s))).unwrap_or_default();
        let r = rstyle.as_deref().map(|s| props(&resolved(self.styles, s))).unwrap_or_default();
        b.push(s, p.over(r).over(direct).style());
    }
}

pub fn parse(bytes: &[u8], name: &str) -> Result<crate::Book, Error> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| Error::Unreadable("it is not a Word document"))?;
    let body = read(&mut z, "word/document.xml").ok_or(Error::Unreadable("it is not a Word document"))?;
    let (styles, lang) = read(&mut z, "word/styles.xml").map(|x| styles(&x)).unwrap_or_default();
    let mut refs: Vec<(bool, String)> = Vec::new();
    let paras = Walk { styles: &styles, refs: &mut refs }.paragraphs(&body, false).into_iter().map(|(_, p)| p).collect::<Vec<_>>();
    // the notes, in the order the text refers to them
    let mut notes: Vec<(String, TextBuilder)> = (0..refs.len()).map(|i| ((i + 1).to_string(), TextBuilder::new())).collect();
    for (endnote, part) in [(false, "word/footnotes.xml"), (true, "word/endnotes.xml")] {
        let Some(xml) = read(&mut z, part) else { continue };
        let mut sink = Vec::new();
        let ps = Walk { styles: &styles, refs: &mut sink }.paragraphs(&xml, true);
        for (id, p) in ps {
            let Some(id) = id else { continue };
            let Some(i) = refs.iter().position(|(e, x)| *e == endnote && *x == id) else { continue };
            let tb = match p {
                Para::P(b) | Para::Quote(b) | Para::Item(b) | Para::Heading(_, b) => b,
                _ => continue,
            };
            let nb = &mut notes[i].1;
            if !nb.is_empty() {
                nb.newline();
            }
            let (t, r, _) = tb.finish_with_links();
            // the note's own marker (the footnoteRef's superscript number) is not part of it
            nb.append(t.trim_start(), &r.iter().map(|x| vol_model::Run { start: x.start.saturating_sub((t.len() - t.trim_start().len()) as u32), end: x.end.saturating_sub((t.len() - t.trim_start().len()) as u32), style: x.style }).collect::<Vec<_>>(), &[]);
        }
    }
    let mut meta = Meta { lang: lang.split('-').next().unwrap_or("").to_string(), ..Meta::default() };
    if let Some(core) = read(&mut z, "docProps/core.xml") {
        let mut r = Reader::from_str(&core);
        let mut at = Vec::new();
        loop {
            match r.read_event() {
                Ok(Event::Start(e)) => at = local(e.name().as_ref()).to_vec(),
                Ok(Event::Text(t)) => {
                    let v = t.xml_content().map(|c| c.trim().to_string()).unwrap_or_default();
                    match at.as_slice() {
                        b"title" if !v.is_empty() => meta.title = v,
                        b"creator" if !v.is_empty() => meta.author = v,
                        _ => {}
                    }
                }
                Ok(Event::End(_)) => at.clear(),
                Ok(Event::Eof) | Err(_) => break,
                _ => {}
            }
        }
    }
    assemble(bytes, name, Doc { meta, paras, notes })
}
