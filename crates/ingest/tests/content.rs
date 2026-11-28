//! Notes, links and images on real books (skipped when the corpus is absent).
use typeset_model::Target;

fn book(name: &str) -> Option<typeset_model::Book> {
    let p = format!("{}/../../corpus/{name}", env!("CARGO_MANIFEST_DIR"));
    let bytes = std::fs::read(&p).ok()?;
    Some(typeset_ingest::any(&bytes, &p).unwrap())
}

fn refs(b: &typeset_model::Book) -> usize {
    b.sections.iter().flat_map(|s| &s.blocks).flat_map(|b| &b.links).filter(|l| matches!(l.to, Target::Note(_))).count()
}

#[test]
fn epub3_endnotes() {
    let Some(b) = book("artofwar.epub") else { return };
    assert!(b.notes.len() > 780, "{}", b.notes.len());
    assert!(refs(&b) > 800);
    assert_eq!(b.notes[0].text, "Published at Paris in 1782.");
    assert!(b.notes.iter().all(|n| !n.text.ends_with('↩') && !n.text.contains("↩︎")));
}

#[test]
fn gutenberg_footnotes_with_return_links() {
    let Some(b) = book("gibbon1.epub") else { return };
    assert!(b.notes.len() > 1600, "{}", b.notes.len());
    let n = &b.notes[0];
    assert_eq!(n.label, "101");
    assert!(n.text.starts_with("A considerable portion"), "{}", n.text);
    assert!(!n.text.contains("return") && !n.text.starts_with('['));
    // a marker is set as a superscript
    let blk = b.sections.iter().flat_map(|s| &s.blocks).find(|b| b.links.iter().any(|l| matches!(l.to, Target::Note(0)))).unwrap();
    let l = blk.links.iter().find(|l| matches!(l.to, Target::Note(0))).unwrap();
    assert!(blk.spans().any(|(s, e, st)| s <= l.start as usize && e >= l.end as usize && st & typeset_model::style::SUP != 0));
}

#[test]
fn images_and_figures() {
    let Some(b) = book("beagle.epub") else { return };
    assert!(b.images.len() >= 20, "{}", b.images.len());
    // Gutenberg's "enlarge" buttons and numeric descriptions are gone
    assert!(b.images.iter().all(|i| i.w >= 24 && (i.alt.is_empty() || !i.alt.chars().all(|c| c.is_ascii_digit()))));
    let blocks = b.sections.iter().flat_map(|s| &s.blocks).filter(|b| b.image.is_some()).count();
    assert_eq!(blocks, b.images.len());
}

#[test]
fn saved_books_round_trip_with_their_notes_and_links() {
    // (earlier releases' saved forms: typeset_model's own tests, `earlier`)
    let Some(b) = book("artofwar.epub") else { return };
    let saved = b.save().unwrap();
    let back = typeset_model::Book::restore(&saved).unwrap();
    assert_eq!(back.notes.len(), b.notes.len());
    assert_eq!(back.sections[3].blocks[2].links, b.sections[3].blocks[2].links);
}

#[test]
fn tables_keep_rows_cells_and_breaks_within_cells() {
    let Some(b) = book("artofwar.epub") else { return };
    let t = b.sections.iter().flat_map(|s| &s.blocks).find(|b| b.kind == typeset_model::Kind::Table).expect("the chronology table");
    let shape = t.table.as_ref().unwrap();
    assert_eq!(shape.cols, 2);
    // the first row is <th>BC</th><td></td>: not all header cells, but its th is bold
    assert_eq!(shape.header_rows, 0);
    assert!(t.runs.iter().any(|r| r.start == 0 && r.end == 2 && r.style & typeset_model::style::BOLD != 0));
    let rows: Vec<&str> = t.text.split('\n').collect();
    assert!(rows.len() >= 17, "{}", rows.len());
    assert!(rows.iter().all(|r| r.split('\t').count() == 2));
    // "509<br>or<br>508" stays one cell, its breaks forced line breaks
    assert!(rows.iter().any(|r| r.starts_with("509\u{2028}or\u{2028}508\t")), "{rows:?}");
}

#[test]
fn preformatted_text_keeps_its_lines_and_columns() {
    let Some(b) = book("beagle.epub") else { return };
    let pre: Vec<&typeset_model::Block> = b.sections.iter().flat_map(|s| &s.blocks).filter(|b| b.kind == typeset_model::Kind::Pre).collect();
    assert_eq!(pre.len(), 3);
    for p in &pre {
        assert!(p.text.lines().count() > 1 && !p.text.starts_with('\n') && !p.text.contains('\t'), "{:?}", p.text);
    }
    // the temperature table's columns stay aligned: runs of spaces survive
    assert!(pre.iter().any(|p| p.text.contains("Summer   Winter")), "{:?}", pre[0].text);
    // and indentation the whole block shared is gone, so it sits on the text's margin
    assert!(pre.iter().all(|p| p.text.lines().any(|l| !l.is_empty() && !l.starts_with(' '))));
}
