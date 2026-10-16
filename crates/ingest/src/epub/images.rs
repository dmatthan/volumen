//! The images an EPUB's text met: read, measured, and those too small to show left out.
use super::*;

/// Reads and measures the images the walk met. Ones that cannot be shown, or are mere
/// icons (Gutenberg's "enlarge" buttons, ornaments under 24 px), lose their blocks.
pub(super) fn load_images(z: &mut Zip, found: &[(String, String, f32)], rich: &[String], sections: &mut [Section]) -> Vec<vol_model::Image> {
    // only images whose blocks survived shaping (a dropped title page takes its art along)
    let used: HashSet<u32> = sections.iter().flat_map(|s| &s.blocks).filter_map(|b| b.image).collect();
    let mut out: Vec<vol_model::Image> = Vec::new();
    let mut remap: Vec<Option<u32>> = Vec::with_capacity(found.len());
    for (i, (path, alt, density)) in found.iter().enumerate() {
        let img = (|| {
            if !used.contains(&(i as u32)) {
                return None;
            }
            // a rich block: its XHTML, its size not known until a browser draws it
            if let Some(n) = path.strip_prefix("rich:").and_then(|n| n.parse::<usize>().ok()) {
                return Some(vol_model::Image { mime: vol_model::RICH.into(), w: 0, h: 0, alt: alt.clone(), bytes: rich.get(n)?.clone().into_bytes() });
            }
            if path.to_ascii_lowercase().contains("enlarge") {
                return None;
            }
            let bytes = z.bytes(path)?;
            if bytes.len() > 20_000_000 {
                return None;
            }
            let mime = match imagesize::image_type(&bytes).ok()? {
                imagesize::ImageType::Png => "image/png",
                imagesize::ImageType::Jpeg => "image/jpeg",
                imagesize::ImageType::Gif => "image/gif",
                imagesize::ImageType::Webp => "image/webp",
                _ => return None,
            };
            let d = imagesize::blob_size(&bytes).ok()?;
            let (w, h) = ((d.width as f32 / density).round() as u32, (d.height as f32 / density).round() as u32);
            if w < 24 || h < 24 {
                return None;
            }
            // Gutenberg names images by number and repeats it as their description
            let alt = if alt.chars().all(|c| c.is_ascii_digit() || c.is_whitespace() || c == '_') { String::new() } else { alt.clone() };
            Some(vol_model::Image { mime: mime.into(), w, h, alt, bytes })
        })();
        remap.push(img.map(|i| {
            out.push(i);
            out.len() as u32 - 1
        }));
    }
    for sec in sections.iter_mut() {
        sec.blocks.retain_mut(|b| match b.image {
            Some(i) => match remap.get(i as usize).copied().flatten() {
                Some(j) => {
                    b.image = Some(j);
                    true
                }
                None => false,
            },
            None => b.kind != Kind::Image,
        });
    }
    out
}
