//! Readers' notes put into the writer's own Word file, as Word comments by their readers on
//! the words they were made on. Word, Google Docs, LibreOffice, Pages and Scrivener all
//! read these, so the notes arrive where the writer works.
//!
//! The words are found in the file again (the quote, and the words either side to choose
//! between repeats), not looked up by position: the file may be a later draft than the
//! one the readers read. A note not found is said so, never guessed. Only the body is
//! annotated (`word/document.xml`); the file is otherwise copied as it was.

use quick_xml::events::Event;
use quick_xml::reader::Reader;
use std::io::{Read, Write};

/// A note to place: the words, a little either side, who made it, what it says.
#[derive(Debug, Clone, Default)]
pub struct Comment {
    pub quote: String,
    pub prefix: String,
    pub suffix: String,
    pub author: String,
    pub text: String,
    /// RFC 3339, as Word writes it ("2026-10-15T12:00:00Z")
    pub date: String,
}

#[derive(Debug)]
pub struct Annotated {
    pub bytes: Vec<u8>,
    /// how many were placed, and which were not (their indices)
    pub placed: usize,
    pub unplaced: Vec<usize>,
}

#[derive(Debug)]
pub enum Error {
    NotWord,
    Damaged(String),
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            Error::NotWord => write!(f, "this is not a Word document"),
            Error::Damaged(s) => write!(f, "the Word document is damaged ({s})"),
        }
    }
}

const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const REL_COMMENTS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments";
const CT_COMMENTS: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml";

/// A piece of a paragraph's text as it stands in the file: one `<w:t>`'s content.
struct Piece {
    /// characters of the paragraph's text it holds
    from: usize,
    to: usize,
    /// its content in the XML (escaped), and its opening tag
    content: (usize, usize),
    tag: (usize, usize),
    /// the run it is in: where it begins and ends, and its properties as written
    run: (usize, usize),
    rpr: String,
}

struct Para {
    text: Vec<char>,
    pieces: Vec<Piece>,
}

fn local(name: &[u8]) -> &[u8] {
    name.iter().rposition(|&c| c == b':').map_or(name, |i| &name[i + 1..])
}

/// The body's paragraphs: their text (as the importer reads it: deletions and field codes
/// left out) and where each piece of it stands in the XML.
fn paragraphs(xml: &str) -> Vec<Para> {
    let mut out = Vec::new();
    let mut r = Reader::from_str(xml);
    let mut para: Option<Para> = None;
    let mut run_start = 0usize;
    let mut rpr = String::new();
    let mut rpr_start: Option<usize> = None;
    let mut t_tag = (0usize, 0usize);
    let mut in_t = false;
    let mut deleted = 0usize;
    let mut field_code = false;
    let mut open_pieces: Vec<usize> = Vec::new();
    let mut in_ppr = false;
    loop {
        let before = r.buffer_position() as usize;
        let ev = r.read_event();
        let after = r.buffer_position() as usize;
        match ev {
            Ok(Event::Start(e)) => match local(e.name().as_ref()) {
                b"p" => para = Some(Para { text: Vec::new(), pieces: Vec::new() }),
                b"r" => {
                    run_start = before;
                    rpr.clear();
                    open_pieces.clear();
                }
                b"pPr" => in_ppr = true,
                b"rPr" if !in_ppr => rpr_start = Some(before),
                b"t" => {
                    in_t = true;
                    t_tag = (before, after);
                }
                b"del" | b"moveFrom" => deleted += 1,
                _ => {}
            },
            Ok(Event::Empty(e)) => match local(e.name().as_ref()) {
                b"fldChar" => {
                    let kind = e.attributes().flatten().find(|a| local(a.key.as_ref()) == b"fldCharType").map(|a| a.value.into_owned());
                    match kind.as_deref() {
                        Some(b"begin") => field_code = true,
                        Some(b"separate") | Some(b"end") => field_code = false,
                        _ => {}
                    }
                }
                // (as the importer reads them: a tab or a line break is a space)
                b"tab" | b"br" | b"cr" if deleted == 0 && !field_code && !in_ppr => {
                    if let Some(p) = para.as_mut() {
                        p.text.push(' ');
                    }
                }
                b"noBreakHyphen" if deleted == 0 && !field_code => {
                    if let Some(p) = para.as_mut() {
                        p.text.push('-');
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => match local(e.name().as_ref()) {
                b"pPr" => in_ppr = false,
                b"rPr" => {
                    if let Some(s) = rpr_start.take() {
                        rpr = xml[s..after].to_string();
                    }
                }
                b"t" => in_t = false,
                b"r" => {
                    if let Some(p) = para.as_mut() {
                        for &i in &open_pieces {
                            p.pieces[i].run.1 = after;
                        }
                    }
                    open_pieces.clear();
                }
                b"del" | b"moveFrom" => deleted = deleted.saturating_sub(1),
                b"p" => {
                    if let Some(p) = para.take() {
                        out.push(p);
                    }
                }
                _ => {}
            },
            Ok(Event::Text(t)) if in_t && deleted == 0 && !field_code => {
                if let Some(p) = para.as_mut() {
                    let s = t.xml_content().map(|c| c.into_owned()).unwrap_or_default();
                    let from = p.text.len();
                    p.text.extend(s.chars());
                    open_pieces.push(p.pieces.len());
                    p.pieces.push(Piece { from, to: p.text.len(), content: (before, after), tag: t_tag, run: (run_start, after), rpr: rpr.clone() });
                }
            }
            Ok(Event::GeneralRef(g)) if in_t && deleted == 0 && !field_code => {
                // an entity inside the text: part of the piece before it (or its own)
                if let Some(p) = para.as_mut() {
                    let name: &[u8] = &g;
                    let c = match name {
                        b"amp" => '&',
                        b"lt" => '<',
                        b"gt" => '>',
                        b"quot" => '"',
                        b"apos" => '\'',
                        _ => '\u{FFFD}',
                    };
                    let from = p.text.len();
                    p.text.push(c);
                    match p.pieces.last_mut() {
                        Some(last) if last.content.1 == before && last.tag == t_tag => {
                            last.to = p.text.len();
                            last.content.1 = after;
                        }
                        _ => {
                            open_pieces.push(p.pieces.len());
                            p.pieces.push(Piece { from, to: p.text.len(), content: (before, after), tag: t_tag, run: (run_start, after), rpr: rpr.clone() });
                        }
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    out
}

/// A character's form for finding words again: quotes, dashes and spaces as plain ones.
fn plain(c: char) -> char {
    match c {
        '\u{2018}' | '\u{2019}' | '\u{201B}' | '\u{2032}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201F}' | '\u{2033}' => '"',
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2212}' => '-',
        '\u{00A0}' | '\u{2007}' | '\u{202F}' | '\t' | '\n' => ' ',
        _ => c,
    }
}

/// Text in a findable form, with each kept character's place in the original; digits are
/// left out when `digits` is false (the importer puts footnote numbers into the text).
fn folded(chars: &[char], digits: bool) -> (Vec<char>, Vec<usize>) {
    let mut out = Vec::new();
    let mut at = Vec::new();
    for (i, &c) in chars.iter().enumerate() {
        if !digits && c.is_ascii_digit() {
            continue;
        }
        let c = plain(c);
        if c == ' ' && out.last() == Some(&' ') {
            continue;
        }
        out.push(c);
        at.push(i);
    }
    (out, at)
}

fn find_all(hay: &[char], needle: &[char]) -> Vec<usize> {
    if needle.is_empty() || needle.len() > hay.len() {
        return Vec::new();
    }
    (0..=hay.len() - needle.len()).filter(|&i| hay[i..i + needle.len()] == *needle).collect()
}

/// How far two strings agree from their ends (the words before) or starts (after).
fn agree_back(a: &[char], b: &[char]) -> usize {
    a.iter().rev().zip(b.iter().rev()).take_while(|(x, y)| x == y).count()
}
fn agree_fwd(a: &[char], b: &[char]) -> usize {
    a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count()
}

/// Where a note's words are: (paragraph, first character, end), the best agreeing with
/// the words either side; or none.
fn locate(paras: &[Para], c: &Comment) -> Option<(usize, usize, usize)> {
    let q: Vec<char> = c.quote.trim().chars().collect();
    if q.is_empty() {
        return None;
    }
    for digits in [true, false] {
        let (qf, _) = folded(&q, digits);
        let (pf, _) = folded(&c.prefix.chars().collect::<Vec<_>>(), digits);
        let (sf, _) = folded(&c.suffix.chars().collect::<Vec<_>>(), digits);
        if qf.iter().filter(|c| !c.is_whitespace()).count() < 2 {
            continue;
        }
        let mut best: Option<(usize, usize, usize, usize)> = None;
        for (pi, p) in paras.iter().enumerate() {
            let (hay, at) = folded(&p.text, digits);
            for i in find_all(&hay, &qf) {
                let score = agree_back(&hay[..i], &pf) + agree_fwd(&hay[i + qf.len()..], &sf);
                let start = at[i];
                let end = at[i + qf.len() - 1] + 1;
                if best.is_none_or(|b| score > b.0) {
                    best = Some((score, pi, start, end));
                }
            }
        }
        if let Some((_, pi, s, e)) = best {
            return Some((pi, s, e));
        }
    }
    None
}

/// A character offset inside a piece's escaped content, as a byte offset into the XML.
fn byte_at(xml: &str, piece: &Piece, ch: usize) -> usize {
    let mut n = piece.from;
    let mut i = piece.content.0;
    let end = piece.content.1;
    let b = xml.as_bytes();
    while i < end && n < ch {
        if b[i] == b'&' {
            i = xml[i..end].find(';').map_or(end, |k| i + k + 1);
        } else {
            i += xml[i..].chars().next().map_or(1, |c| c.len_utf8());
        }
        n += 1;
    }
    i
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// The readers' notes, as Word comments in the writer's file.
pub fn annotate(docx: &[u8], comments: &[Comment]) -> Result<Annotated, Error> {
    let mut z = zip::ZipArchive::new(std::io::Cursor::new(docx)).map_err(|_| Error::NotWord)?;
    let read = |z: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, path: &str| -> Option<String> {
        let mut f = z.by_name(path).ok()?;
        let mut s = String::new();
        f.read_to_string(&mut s).ok()?;
        Some(s)
    };
    let doc = read(&mut z, "word/document.xml").ok_or(Error::NotWord)?;
    let rels = read(&mut z, "word/_rels/document.xml.rels").ok_or(Error::Damaged("no relationships".into()))?;
    let types = read(&mut z, "[Content_Types].xml").ok_or(Error::Damaged("no content types".into()))?;
    let existing = read(&mut z, "word/comments.xml");
    // ids after any comments the file has already
    let first_id = existing.as_deref().map_or(0, |x| {
        x.match_indices("w:id=\"").filter_map(|(i, m)| x[i + m.len()..].split('"').next()?.parse::<i64>().ok()).max().map_or(0, |m| m + 1)
    });

    let paras = paragraphs(&doc);
    // every place a mark goes: (byte, order, text); a mark inside a piece's text splits
    // its run there (the same properties on both sides)
    let mut edits: Vec<(usize, u8, String)> = Vec::new();
    let mut preserve: Vec<(usize, usize)> = Vec::new();
    let mut placed = Vec::new();
    let mut unplaced = Vec::new();
    for (i, c) in comments.iter().enumerate() {
        let Some((pi, s, e)) = locate(&paras, c) else {
            unplaced.push(i);
            continue;
        };
        let id = first_id + placed.len() as i64;
        let p = &paras[pi];
        let start = format!("<w:commentRangeStart w:id=\"{id}\"/>");
        let end = format!("<w:commentRangeEnd w:id=\"{id}\"/><w:r><w:commentReference w:id=\"{id}\"/></w:r>");
        for (ch, mark, is_start) in [(s, start, true), (e, end, false)] {
            // the piece the mark falls in, or at the edge of
            let k = if is_start { p.pieces.iter().position(|x| x.to > ch) } else { p.pieces.iter().rposition(|x| x.from < ch) };
            let Some(k) = k else { continue };
            let x = &p.pieces[k];
            let order = if is_start { 1 } else { 0 };
            if (is_start && ch <= x.from) || (!is_start && ch >= x.to) {
                // at a run's edge: before its run, or after it
                edits.push((if is_start { x.run.0 } else { x.run.1 }, order, mark));
            } else {
                let at = byte_at(&doc, x, ch);
                edits.push((at, order, format!("</w:t></w:r>{mark}<w:r>{}<w:t xml:space=\"preserve\">", x.rpr)));
                preserve.push(x.tag);
            }
        }
        placed.push(i);
    }

    // the document with its marks (from the end, so earlier offsets hold)
    let mut out = doc.clone();
    preserve.sort();
    preserve.dedup();
    let mut all: Vec<(usize, usize, u8, String)> = edits.into_iter().map(|(at, o, s)| (at, at, o, s)).collect();
    for (a, b) in preserve {
        all.push((a, b, 2, "<w:t xml:space=\"preserve\">".into()));
    }
    // (at one place: ends before starts, as written; a tag's rewrite is its own range)
    all.sort_by(|x, y| y.0.cmp(&x.0).then(y.2.cmp(&x.2)));
    for (a, b, _, s) in all {
        out.replace_range(a..b, &s);
    }

    // the comments
    let mut body = String::new();
    for (n, &i) in placed.iter().enumerate() {
        let c = &comments[i];
        let initials: String = c.author.split_whitespace().filter_map(|w| w.chars().next()).take(3).collect();
        let date = if c.date.is_empty() { String::new() } else { format!(" w:date=\"{}\"", esc(&c.date)) };
        body.push_str(&format!("<w:comment w:id=\"{}\" w:author=\"{}\" w:initials=\"{}\"{date}>", first_id + n as i64, esc(&c.author), esc(&initials)));
        for line in c.text.split('\n') {
            body.push_str(&format!("<w:p><w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>", esc(line)));
        }
        body.push_str("</w:comment>");
    }
    let comments_xml = match &existing {
        Some(x) if x.contains("</w:comments>") => x.replacen("</w:comments>", &format!("{body}</w:comments>"), 1),
        _ => format!("<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<w:comments xmlns:w=\"{W}\">{body}</w:comments>"),
    };
    let rels = if rels.contains(REL_COMMENTS) {
        rels
    } else {
        rels.replacen("</Relationships>", &format!("<Relationship Id=\"rIdVolumenComments\" Type=\"{REL_COMMENTS}\" Target=\"comments.xml\"/></Relationships>"), 1)
    };
    let types = if types.contains("/word/comments.xml") {
        types
    } else {
        types.replacen("</Types>", &format!("<Override PartName=\"/word/comments.xml\" ContentType=\"{CT_COMMENTS}\"/></Types>"), 1)
    };

    // the file again: every part as it was, these four as they are now
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let mut wrote_comments = false;
    for i in 0..z.len() {
        let name = z.by_index(i).map_err(|e| Error::Damaged(e.to_string()))?.name().map_err(|e| Error::Damaged(e.to_string()))?.to_string();
        let replacement = match name.as_str() {
            "word/document.xml" => Some(out.as_str()),
            "word/_rels/document.xml.rels" => Some(rels.as_str()),
            "[Content_Types].xml" => Some(types.as_str()),
            "word/comments.xml" => {
                wrote_comments = true;
                Some(comments_xml.as_str())
            }
            _ => None,
        };
        match replacement {
            Some(s) => {
                w.start_file(name, opts).map_err(|e| Error::Damaged(e.to_string()))?;
                w.write_all(s.as_bytes()).map_err(|e| Error::Damaged(e.to_string()))?;
            }
            None => {
                let f = z.by_index_raw(i).map_err(|e| Error::Damaged(e.to_string()))?;
                w.raw_copy_file(f).map_err(|e| Error::Damaged(e.to_string()))?;
            }
        }
    }
    if !wrote_comments {
        w.start_file("word/comments.xml", opts).map_err(|e| Error::Damaged(e.to_string()))?;
        w.write_all(comments_xml.as_bytes()).map_err(|e| Error::Damaged(e.to_string()))?;
    }
    let bytes = w.finish().map_err(|e| Error::Damaged(e.to_string()))?.into_inner();
    Ok(Annotated { bytes, placed: placed.len(), unplaced })
}
