//! A book's structure as imported: cargo run -p vol-ingest --example dump -- file
fn main() {
    let a: Vec<String> = std::env::args().collect();
    let b = vol_ingest::any(&std::fs::read(&a[1]).unwrap(), &a[1]).unwrap();
    println!("{} — {} [{}] id {}", b.meta.title, b.meta.author, b.meta.lang, b.id);
    for (si, s) in b.sections.iter().enumerate() {
        println!("§{si} {:?} label={:?} num={:?} title={:?}", s.kind, s.label, s.num, s.title);
        for blk in &s.blocks {
            let styled: Vec<String> = blk.runs.iter().map(|r| format!("{}:{:?}", r.style, &blk.text[r.start as usize..r.end as usize])).collect();
            println!("   {:?} {:?} {}{}", blk.kind, blk.text.chars().take(90).collect::<String>(), styled.join(" "), if blk.links.is_empty() { String::new() } else { format!(" links {:?}", blk.links.iter().map(|l| &l.to).collect::<Vec<_>>()) });
        }
    }
    for n in &b.notes {
        println!("note {}: {}", n.label, n.text);
    }
}
