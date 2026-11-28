//! The saved forms of earlier releases, read into this one. Form 3 was written by every
//! release from the first (0.1.0) to 0.3.0, and is read; form 5 is this one (0.4.0 on).
//! Forms 1, 2 and 4 were never written by a release, and are refused. What an earlier
//! form lacks (heads as the book wrote them, the book's leading) comes with the next
//! import of the book's file.
use serde::Deserialize;

// Form 3, as it was written: its own shapes, frozen (written by the test below).
#[derive(Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
pub struct V3 {
    id: String,
    meta: super::Meta,
    sections: Vec<V3Section>,
    notes: Vec<super::Note>,
    images: Vec<super::Image>,
}
#[derive(Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
struct V3Section {
    kind: super::SectionKind,
    part: String,
    label: String,
    num: String,
    title: String,
    blocks: Vec<V3Block>,
}
#[derive(Deserialize)]
#[cfg_attr(test, derive(serde::Serialize))]
struct V3Block {
    key: u64,
    kind: super::Kind,
    text: String,
    runs: Vec<super::Run>,
    links: Vec<super::Link>,
    image: Option<u32>,
    table: Option<super::TableShape>,
}
impl From<V3Block> for super::Block {
    fn from(b: V3Block) -> Self {
        super::Block { links: b.links, image: b.image, table: b.table, ..super::Block::new(b.key, b.kind, b.text, b.runs) }
    }
}
impl From<V3Section> for super::Section {
    fn from(s: V3Section) -> Self {
        super::Section { kind: s.kind, part: s.part, label: s.label, num: s.num, title: s.title, blocks: s.blocks.into_iter().map(Into::into).collect(), head: None }
    }
}
impl From<V3> for super::Book {
    fn from(b: V3) -> Self {
        super::Book { id: b.id, meta: b.meta, sections: b.sections.into_iter().map(Into::into).collect(), notes: b.notes, images: b.images, leading: None, cover: None }
    }
}

#[test]
fn a_book_saved_by_an_earlier_release_is_read_and_this_form_keeps_what_it_adds() {
    let v3 = V3 {
        id: "c".into(),
        meta: super::Meta { title: "Old".into(), ..Default::default() },
        sections: vec![V3Section { kind: super::SectionKind::Chapter, part: String::new(), label: "I".into(), num: "1".into(), title: "One".into(), blocks: vec![V3Block { key: 3, kind: super::Kind::P, text: "Third.".into(), runs: vec![], links: vec![], image: None, table: None }] }],
        notes: vec![],
        images: vec![],
    };
    let mut bytes = super::SAVE_MAGIC_V3.to_vec();
    bytes.extend(postcard::to_allocvec(&v3).unwrap());
    let b = super::Book::restore(&bytes).unwrap();
    assert_eq!((b.id.as_str(), b.sections[0].title.as_str(), b.sections[0].blocks[0].text.as_str(), b.sections[0].head.is_none()), ("c", "One", "Third.", true));
    // and this form keeps the book's leading
    let b = super::Book { leading: Some(1.5), ..b };
    assert_eq!(super::Book::restore(&b.save().unwrap()).unwrap().leading, Some(1.5));
}

#[test]
fn a_form_no_release_wrote_is_refused_with_a_reason() {
    // (forms 1, 2 and 4: before the repository, and never released)
    for bytes in [b"VOL\x04\x00".as_slice(), b"VOL\x02\x00", b"\x01a\x00"] {
        let err = super::Book::restore(bytes).unwrap_err();
        assert!(err.contains("import"), "{err}");
    }
}
