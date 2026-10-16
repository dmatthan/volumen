//! Typefaces: the families the app ships (the press and the webview read the same
//! files), and those installed on this computer, loaded into the press on demand and
//! handed to the webview as FontFaces.
use crate::{App, Held, Res};
use tauri::State;
use tauri::ipc::Response;
use vol_engine::Engine;

macro_rules! fonts {
    ($($fam:literal: $($file:literal),+;)+) => {
        /// The families the app ships, with their files (the webview loads the same files
        /// from /fonts).
        pub static BUNDLED: &[(&str, &[&[u8]])] = &[$(($fam, &[$(include_bytes!(concat!("../../assets/fonts/", $file))),+])),+];
    };
}
// each bundled face is a core file and its extension (scripts/subset-fonts.py); the
// engine chains "Name~ext" after "Name", as the webview picks by unicode-range (fonts.css)
fonts! {
    "Literata": "Literata.ttf", "Literata-Italic.ttf";
    "Literata~ext": "Literata.ext.ttf", "Literata-Italic.ext.ttf";
    "Inter": "Inter.ttf", "Inter-Italic.ttf";
    "Inter~ext": "Inter.ext.ttf", "Inter-Italic.ext.ttf";
    "Newsreader": "Newsreader.ttf", "Newsreader-Italic.ttf";
    "Newsreader~ext": "Newsreader.ext.ttf", "Newsreader-Italic.ext.ttf";
    "Charis": "Charis-Regular.ttf", "Charis-Italic.ttf", "Charis-Medium.ttf", "Charis-MediumItalic.ttf", "Charis-SemiBold.ttf", "Charis-SemiBoldItalic.ttf", "Charis-Bold.ttf", "Charis-BoldItalic.ttf";
    "Charis~ext": "Charis-Regular.ext.ttf", "Charis-Italic.ext.ttf", "Charis-Medium.ext.ttf", "Charis-MediumItalic.ext.ttf", "Charis-SemiBold.ext.ttf", "Charis-SemiBoldItalic.ext.ttf", "Charis-Bold.ext.ttf", "Charis-BoldItalic.ext.ttf";
    "Fraunces": "Fraunces.ttf", "Fraunces-Italic.ttf";
    "Fraunces~ext": "Fraunces.ext.ttf", "Fraunces-Italic.ext.ttf";
    "Nunito Sans": "NunitoSans.ttf", "NunitoSans-Italic.ttf";
    "Nunito Sans~ext": "NunitoSans.ext.ttf", "NunitoSans-Italic.ext.ttf";
    "JetBrains Mono": "JetBrainsMono.ttf";
    "JetBrains Mono~ext": "JetBrainsMono.ext.ttf";
}

#[derive(serde::Serialize, Clone)]
pub struct SysFile {
    italic: bool,
    wmin: f32,
    wmax: f32,
    #[serde(skip)]
    bytes: std::sync::Arc<Vec<u8>>,
}

fn with_fonts<T>(app: &App, f: impl FnOnce(&fontdb::Database) -> T) -> T {
    let mut db = app.sysfonts.held();
    let db = db.get_or_insert_with(|| {
        let mut d = fontdb::Database::new();
        d.load_system_fonts();
        d
    });
    f(db)
}

/// Families installed on this computer that the reader can use: plain TrueType or
/// OpenType files (collections are left out: a webview cannot load one face of them).
#[tauri::command]
pub async fn system_families(app: State<'_, App>) -> Res<Vec<String>> {
    let mut names: Vec<String> = with_fonts(&app, |db| {
        db.faces()
            .filter(|f| f.index == 0 && matches!(&f.source, fontdb::Source::File(p) if p.extension().and_then(|e| e.to_str()).is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "ttf" | "otf"))))
            .filter_map(|f| f.families.first().map(|(n, _)| n.clone()))
            .collect()
    });
    names.sort_by_key(|n| n.to_lowercase());
    names.dedup();
    names.retain(|n| !BUNDLED.iter().any(|(b, _)| b == n));
    Ok(names)
}

/// Loads a family into the engine (bundled ones are already there) and describes its
/// files, which the webview then fetches with `font_file`.
#[tauri::command]
pub async fn load_family(name: String, app: State<'_, App>) -> Res<serde_json::Value> {
    let bundled = BUNDLED.iter().any(|(b, _)| *b == name);
    if !bundled && !app.loaded.held().contains_key(&name) {
        let paths: Vec<std::path::PathBuf> = with_fonts(&app, |db| {
            let mut v: Vec<std::path::PathBuf> = db
                .faces()
                .filter(|f| f.index == 0 && f.families.first().is_some_and(|(n, _)| *n == name))
                .filter_map(|f| if let fontdb::Source::File(p) = &f.source { Some(p.clone()) } else { None })
                .collect();
            v.sort();
            v.dedup();
            v
        });
        if paths.is_empty() {
            return Err(format!("{name} is not installed"));
        }
        let mut files = Vec::new();
        let mut eng = app.engine.held();
        for p in paths {
            let Ok(bytes) = std::fs::read(&p) else { continue };
            if eng.add_font(&name, bytes.clone()).is_ok() {
                files.push(SysFile { italic: false, wmin: 0.0, wmax: 0.0, bytes: std::sync::Arc::new(bytes) });
            }
        }
        // describe each file as the engine read it
        if let Some(info) = eng.family_info(&name) {
            let italics = info_italics(&eng, &name);
            for (i, f) in files.iter_mut().enumerate() {
                (f.wmin, f.wmax) = info.weights[i];
                f.italic = italics[i];
            }
        }
        app.loaded.held().insert(name.clone(), files);
    }
    let eng = app.engine.held();
    let info = eng.family_info(&name).ok_or_else(|| format!("{name} could not be loaded"))?;
    let files = if bundled { vec![] } else { app.loaded.held().get(&name).cloned().unwrap_or_default() };
    Ok(serde_json::json!({ "bundled": bundled, "smcp": info.smcp, "italic": info.italic, "files": files }))
}

fn info_italics(eng: &Engine, name: &str) -> Vec<bool> {
    eng.family_files(name).iter().map(|f| f.italic).collect()
}

/// One file of a loaded system family, for the webview's FontFace.
#[tauri::command]
pub async fn font_file(name: String, index: usize, app: State<'_, App>) -> Res<Response> {
    let files = app.loaded.held();
    let f = files.get(&name).and_then(|v| v.get(index)).ok_or("no such font file")?;
    Ok(Response::new(f.bytes.as_ref().clone()))
}

