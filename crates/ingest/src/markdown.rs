//! Markdown (CommonMark, with footnotes): headings make the chapters, `*` and `_` italics,
//! `**` bold, `>` quotations, `---` scene breaks, code blocks preformatted text. Straight
//! quotes and dashes are made typographic. A front matter block (`---` … `---`) may give
//! `title`, `author` and `lang`.

use crate::doc::{Doc, Para, assemble};
use crate::Error;
use pulldown_cmark::{Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use vol_model::{Meta, TextBuilder, style};

pub fn parse(bytes: &[u8], name: &str) -> Result<crate::Book, Error> {
    let src = crate::text::decode(bytes).ok_or(Error::Unreadable("it is not text"))?.replace("\r\n", "\n");
    let mut meta = Meta::default();
    let body = front_matter(&src, &mut meta);
    let opts = Options::ENABLE_FOOTNOTES | Options::ENABLE_SMART_PUNCTUATION | Options::ENABLE_STRIKETHROUGH;
    let mut paras: Vec<Para> = Vec::new();
    let mut notes: Vec<(String, TextBuilder)> = Vec::new();
    let mut labels: Vec<String> = Vec::new();
    let note_of = |labels: &mut Vec<String>, l: &str| -> usize {
        match labels.iter().position(|x| x == l) {
            Some(i) => i,
            None => {
                labels.push(l.to_string());
                labels.len() - 1
            }
        }
    };
    // what is being built: a paragraph-like block, and where it goes
    let mut cur: Option<TextBuilder> = None;
    let mut st: u8 = 0;
    let mut quote = 0usize;
    let mut item = 0usize;
    let mut in_note: Option<usize> = None;
    let mut heading: Option<u8> = None;
    let mut code: Option<String> = None;
    for ev in Parser::new_ext(body, opts) {
        match ev {
            Event::Start(Tag::Heading { level, .. }) => {
                heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                });
                cur = Some(TextBuilder::new());
            }
            Event::End(TagEnd::Heading(_)) => {
                if let (Some(l), Some(b)) = (heading.take(), cur.take()) {
                    paras.push(Para::Heading(l, b));
                }
            }
            Event::Start(Tag::Paragraph) => cur = Some(TextBuilder::new()),
            Event::End(TagEnd::Paragraph) => {
                if let Some(b) = cur.take() {
                    if let Some(n) = in_note {
                        // a footnote of several paragraphs runs on, a line apart
                        let nb = &mut notes[n].1;
                        if !nb.is_empty() {
                            nb.newline();
                        }
                        let (t, r, l) = b.finish_with_links();
                        nb.append(&t, &r, &l);
                    } else if quote > 0 {
                        paras.push(Para::Quote(b));
                    } else if item > 0 {
                        paras.push(Para::Item(b));
                    } else {
                        paras.push(Para::P(b));
                    }
                }
            }
            Event::Start(Tag::BlockQuote(_)) => quote += 1,
            Event::End(TagEnd::BlockQuote(_)) => quote = quote.saturating_sub(1),
            Event::Start(Tag::Item) => {
                item += 1;
                cur = Some(TextBuilder::new());
            }
            Event::End(TagEnd::Item) => {
                item = item.saturating_sub(1);
                if let Some(b) = cur.take() {
                    if !b.is_empty() {
                        paras.push(Para::Item(b));
                    }
                }
            }
            Event::Start(Tag::CodeBlock(_)) => code = Some(String::new()),
            Event::End(TagEnd::CodeBlock) => {
                if let Some(c) = code.take() {
                    paras.push(Para::Pre(c.trim_end().to_string()));
                }
            }
            Event::Start(Tag::FootnoteDefinition(l)) => {
                let i = note_of(&mut labels, &l);
                while notes.len() <= i {
                    notes.push((String::new(), TextBuilder::new()));
                }
                notes[i].0 = (i + 1).to_string();
                in_note = Some(i);
            }
            Event::End(TagEnd::FootnoteDefinition) => in_note = None,
            Event::Start(Tag::Emphasis) => st |= style::ITALIC,
            Event::End(TagEnd::Emphasis) => st &= !style::ITALIC,
            Event::Start(Tag::Strong) => st |= style::BOLD,
            Event::End(TagEnd::Strong) => st &= !style::BOLD,
            Event::Rule => paras.push(Para::Break),
            Event::Text(t) => {
                if let Some(c) = code.as_mut() {
                    c.push_str(&t);
                } else if let Some(b) = cur.as_mut() {
                    b.push(&t, st);
                }
            }
            Event::Code(t) => {
                if let Some(b) = cur.as_mut() {
                    b.push(&t, st);
                }
            }
            Event::SoftBreak => {
                if let Some(b) = cur.as_mut() {
                    b.push(" ", st);
                }
            }
            Event::HardBreak => {
                if let Some(b) = cur.as_mut() {
                    b.newline();
                }
            }
            Event::FootnoteReference(l) => {
                let i = note_of(&mut labels, &l);
                if let Some(b) = cur.as_mut() {
                    b.begin_link(format!("n:{i}"));
                    b.push(&(i + 1).to_string(), st | style::SUP);
                    b.end_link();
                }
            }
            _ => {}
        }
    }
    // labels in the order the notes are first referred to; definitions never referred to
    // are kept, numbered after
    while notes.len() < labels.len() {
        let n = notes.len() + 1;
        notes.push((n.to_string(), TextBuilder::new()));
    }
    assemble(bytes, name, Doc { meta, paras, notes })
}

/// A YAML-like front matter block: `title:`, `author:`, `lang:`; the rest of the text.
fn front_matter<'a>(src: &'a str, meta: &mut Meta) -> &'a str {
    let Some(rest) = src.strip_prefix("---\n") else { return src };
    let Some(end) = rest.find("\n---") else { return src };
    for line in rest[..end].lines() {
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim().trim_matches(['"', '\'']).to_string();
            match k.trim().to_ascii_lowercase().as_str() {
                "title" => meta.title = v,
                "author" => meta.author = v,
                "lang" | "language" => meta.lang = v,
                _ => {}
            }
        }
    }
    rest[end + 4..].trim_start_matches(['-', '\n'])
}
