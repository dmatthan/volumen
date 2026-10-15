//! Some chapters of a book as an EPUB of their own: a sample to put online.
//!
//!   cargo run -p vol-ingest --example sample -- book.epub 1-3 sample.epub
//!   cargo run -p vol-ingest --example sample -- manuscript.docx all manuscript.epub
fn main() {
    let a: Vec<String> = std::env::args().skip(1).collect();
    let [src, range, out] = &a[..] else {
        eprintln!("usage: sample <book> <from-to | n | all> <out.epub>");
        std::process::exit(2);
    };
    let (from, to) = match range.as_str() {
        "all" => (1, usize::MAX),
        r => match r.split_once('-') {
            Some((f, t)) => (f.parse().expect("a number"), t.parse().expect("a number")),
            None => { let n = r.parse().expect("a number"); (n, n) }
        },
    };
    let bytes = std::fs::read(src).expect("the book");
    match vol_ingest::write::sample(&bytes, src, from, to) {
        Ok(epub) => { std::fs::write(out, epub).expect("written"); eprintln!("{out}"); }
        Err(e) => { eprintln!("{e}"); std::process::exit(1); }
    }
}
