//! cargo run --release -p vol-press --example setbook -- book.epub [size] [measure] [rows]
use std::time::Instant;
use vol_press::{Params, Press, Typeface, Typo};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let font = |n: &str| std::fs::read(format!("{}/../../assets/fonts/{n}", env!("CARGO_MANIFEST_DIR"))).unwrap();
    let book = vol_ingest::any(&std::fs::read(&a[1]).unwrap(), &a[1]).unwrap();
    let size: f32 = a.get(2).map(|s| s.parse().unwrap()).unwrap_or(19.0);
    let measure: f32 = a.get(3).map(|s| s.parse().unwrap()).unwrap_or(580.0);
    let rows: u32 = a.get(4).map(|s| s.parse().unwrap()).unwrap_or(24);
    let p = Params { typo: Typo::plain(size, false), measure, rows, head_rows: 7, lh: size * 1.5, link_runs: false, justify: true, hyphenate: true };
    eprintln!("{p:?}");
    let t = Instant::now();
    let mut press = Press::new(Typeface::single(vec![font("Literata.ttf"), font("Literata-Italic.ttf")]).unwrap());
    let t_fonts = t.elapsed();
    let t = Instant::now();
    let hyph = vol_press::hyph::Patterns::new(std::fs::read(concat!(env!("CARGO_MANIFEST_DIR"), "/../../assets/hyph/en.bin")).unwrap());
    let first = press.section(&book, 1, &p, hyph.as_ref());
    let t_first = t.elapsed();
    let t = Instant::now();
    let all = press.book(&book, &p, hyph.as_ref());
    let t_all = t.elapsed();
    let t = Instant::now();
    let all2 = press.book(&book, &p, hyph.as_ref());
    let t_warm = t.elapsed();
    assert_eq!(all.len(), all2.len());
    let lines: usize = all.iter().map(|l| l.lines.len()).sum();
    let cols: u32 = all.iter().map(|l| l.cols).sum();
    let hyph = all.iter().flat_map(|l| &l.lines).filter(|l| l.flags & vol_press::flag::HYPH != 0).count();
    // word-space stretch on justified lines: how far spaces grew beyond their natural width
    let space = size * 0.2;
    let mut stretch: Vec<f32> = all.iter().flat_map(|l| &l.lines).filter(|l| l.flags & vol_press::flag::JUSTIFY != 0 && l.spaces > 0)
        .map(|l| (l.avail - l.natural) / l.spaces as f32 / space).collect();
    stretch.sort_by(|a, b| a.total_cmp(b));
    let pct = |q: f32| stretch[((stretch.len() - 1) as f32 * q) as usize];
    println!("hyphenated {:.1}% | space stretch ×natural: median {:.2} p90 {:.2} p99 {:.2} max {:.2}", 100.0 * hyph as f32 / lines as f32, pct(0.5), pct(0.9), pct(0.99), pct(1.0));
    let enc = vol_press::encode(&all.iter().enumerate().map(|(i, l)| (i as u32, l)).collect::<Vec<_>>());
    println!(
        "{}: {} words, {} sections, {} lines ({} hyphenated), {} columns | fonts {:?}, first section {:?} ({} lines), whole book cold {:?}, warm {:?} | encoded {} KB",
        book.meta.title, book.words(), all.len(), lines, hyph, cols, t_fonts, t_first, first.lines.len(), t_all, t_warm, enc.len() / 1024
    );
}
