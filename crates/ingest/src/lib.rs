//! Turns EPUB, Word (DOCX), Markdown and plain-text files into the book model.

pub mod annotate;
pub mod write;
mod css;
mod doc;
mod docx;
mod epub;
mod heads;
mod markdown;
mod rich;
mod text;

pub use vol_model::Book;

/// What this importer makes of a file, as a number: raised whenever a book read again
/// would come out differently, so books read by an earlier one are read again from their
/// file (the app keeps it). Keep `IMPORTER_VERSION` in app/src/core/types.ts the same.
/// 1: before the version was kept. 2: the publisher's styles (hidden text, styles,
/// alignment), rich blocks (diagram tables, SVG, MathML). 3: apparatus by its semantics.
/// 4: writing without spaces (Chinese, Japanese) counted fairly, so its short chapters
/// are not taken for title pages; a book of pictures keeps its pages.
pub const VERSION: u32 = 4;
use vol_model::{Meta, Section};

#[derive(Debug)]
pub enum Error {
    /// The file is not one Volumen reads, or is damaged; the message finishes "Couldn't
    /// open it: …".
    Unreadable(&'static str),
    /// No readable text was found.
    Empty,
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Error::Unreadable(m) => write!(f, "{m}."),
            Error::Empty => write!(f, "no readable text was found in it."),
        }
    }
}

impl std::error::Error for Error {}

/// Reads an EPUB file.
pub fn epub(bytes: &[u8]) -> Result<Book, Error> {
    epub::parse(bytes)
}

/// Reads a plain-text file (Project Gutenberg conventions understood).
pub fn text(bytes: &[u8], file_name: &str) -> Result<Book, Error> {
    text::parse(bytes, file_name)
}

/// Reads a Word document (DOCX).
pub fn docx(bytes: &[u8], file_name: &str) -> Result<Book, Error> {
    docx::parse(bytes, file_name)
}

/// Reads Markdown (CommonMark with footnotes).
pub fn markdown(bytes: &[u8], file_name: &str) -> Result<Book, Error> {
    markdown::parse(bytes, file_name)
}

/// Picks the reader by file name, falling back to sniffing: a zip with a Word body is a
/// DOCX, any other zip an EPUB.
pub fn any(bytes: &[u8], file_name: &str) -> Result<Book, Error> {
    let lower = file_name.to_ascii_lowercase();
    if let Some(what) = foreign(bytes) {
        return Err(Error::Unreadable(what));
    }
    let zip = bytes.starts_with(b"PK\x03\x04");
    if lower.ends_with(".docx") || (zip && !lower.ends_with(".epub") && is_docx(bytes)) {
        docx::parse(bytes, file_name)
    } else if lower.ends_with(".epub") || zip {
        epub(bytes)
    } else if lower.ends_with(".md") || lower.ends_with(".markdown") {
        markdown::parse(bytes, file_name)
    } else {
        text(bytes, file_name)
    }
}

/// A kind of file Volumen does not read, told by its first bytes (or a zip's contents),
/// as the end of "Couldn't open it: …".
fn foreign(b: &[u8]) -> Option<&'static str> {
    let at = |o: usize, sig: &[u8]| b.len() >= o + sig.len() && &b[o..o + sig.len()] == sig;
    if at(0, b"%PDF") {
        return Some("it is a PDF, which fixes its text on pages; Volumen needs text it can set itself (EPUB, Word, Markdown or plain text)");
    }
    if at(60, b"BOOKMOBI") || at(60, b"TEXtREAd") || at(0, b"\xeaDRMION\xee") {
        return Some("it is a Kindle book; Volumen reads EPUB (Calibre converts Kindle books that have no copy protection)");
    }
    if at(0, b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
        return Some("it is an older Word document (.doc); save it as .docx from Word, Pages or Google Docs");
    }
    if at(0, b"{\\rtf") {
        return Some("it is in Rich Text Format; save it as .docx from the program that made it");
    }
    if at(0, b"\xff\xd8\xff") || at(0, b"\x89PNG") || at(0, b"GIF8") || (at(0, b"RIFF") && at(8, b"WEBP")) || (at(4, b"ftyp") && (at(8, b"heic") || at(8, b"heix") || at(8, b"mif1") || at(8, b"avif"))) {
        return Some("it is an image, not a book");
    }
    if b.starts_with(b"PK\x03\x04") {
        let mut z = zip::ZipArchive::new(std::io::Cursor::new(b)).ok()?;
        if z.by_name("Index/Document.iwa").is_ok() || z.by_name("index.xml").is_ok() {
            return Some("it is a Pages document; in Pages, export it as Word or EPUB");
        }
        let mime = z.by_name("mimetype").ok().and_then(|mut f| {
            let mut s = String::new();
            std::io::Read::read_to_string(&mut f, &mut s).ok()?;
            Some(s)
        });
        if mime.as_deref().is_some_and(|m| m.starts_with("application/vnd.oasis.opendocument")) {
            return Some("it is an OpenDocument file; save it as Word (.docx)");
        }
    }
    None
}

fn is_docx(bytes: &[u8]) -> bool {
    zip::ZipArchive::new(std::io::Cursor::new(bytes)).is_ok_and(|mut z| z.by_name("word/document.xml").is_ok())
}

pub(crate) fn finish_book(source: &[u8], meta: Meta, sections: Vec<Section>) -> Book {
    Book { id: format!("{:016x}", vol_model::fnv64(source)), meta, sections, notes: vec![], images: vec![], cover: None }
}
