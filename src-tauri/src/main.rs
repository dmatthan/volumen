// The desktop shell: the native engine behind a webview. Layout tables cross the
// bridge as raw bytes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod store;

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use store::{LibEntry, Store};
use tauri::ipc::{Request, Response};
use tauri::{Manager, State};
use vol_engine::{Engine, Request as LayoutRequest};

static SAMPLE: &[u8] = include_bytes!("../../assets/sample.epub");

/// Hyphenation patterns for every language offered (the web build fetches only a book's).
static PATTERNS: &[(&str, &[u8])] = &[
    ("en", include_bytes!("../../assets/hyph/en.bin")), ("de", include_bytes!("../../assets/hyph/de.bin")), ("fr", include_bytes!("../../assets/hyph/fr.bin")),
    ("es", include_bytes!("../../assets/hyph/es.bin")), ("it", include_bytes!("../../assets/hyph/it.bin")), ("pt", include_bytes!("../../assets/hyph/pt.bin")),
    ("nl", include_bytes!("../../assets/hyph/nl.bin")), ("sv", include_bytes!("../../assets/hyph/sv.bin")), ("da", include_bytes!("../../assets/hyph/da.bin")),
    ("no", include_bytes!("../../assets/hyph/no.bin")), ("fi", include_bytes!("../../assets/hyph/fi.bin")), ("pl", include_bytes!("../../assets/hyph/pl.bin")),
    ("cs", include_bytes!("../../assets/hyph/cs.bin")), ("ru", include_bytes!("../../assets/hyph/ru.bin")), ("la", include_bytes!("../../assets/hyph/la.bin")),
];

macro_rules! fonts {
    ($($fam:literal: $($file:literal),+;)+) => {
        /// The families the app ships, with their files (the webview loads the same files
        /// from /fonts).
        static BUNDLED: &[(&str, &[&[u8]])] = &[$(($fam, &[$(include_bytes!(concat!("../../assets/fonts/", $file))),+])),+];
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

struct App {
    engine: Mutex<Engine>,
    store: Mutex<Store>,
    /// Books for the full-text indexer (`start_indexer`).
    indexer: Mutex<std::sync::mpsc::Sender<String>>,
    /// Installed fonts, read on first use, and the files of system families loaded so
    /// far (the webview gets the same bytes the press measures).
    sysfonts: Mutex<Option<fontdb::Database>>,
    loaded: Mutex<std::collections::HashMap<String, Vec<SysFile>>>,
    /// A backup chosen in the picker, for the page to read once (`picked_bytes`).
    picked: Mutex<Option<Vec<u8>>>,
}

#[derive(serde::Serialize, Clone)]
struct SysFile {
    italic: bool,
    wmin: f32,
    wmax: f32,
    #[serde(skip)]
    bytes: std::sync::Arc<Vec<u8>>,
}

type Res<T> = Result<T, String>;

/// A lock that a panic while it was held does not leave unusable (the panic is reported
/// by `guarded`; what it was doing is lost, the rest stands).
trait Held<T> {
    fn held(&self) -> MutexGuard<'_, T>;
}

impl<T> Held<T> for Mutex<T> {
    fn held(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

thread_local! {
    /// The last panic on this thread, as `guarded` reports it.
    static PANIC: std::cell::RefCell<String> = const { std::cell::RefCell::new(String::new()) };
}

/// Keeps each panic's message for `guarded` (and prints it).
fn catch_panics() {
    std::panic::set_hook(Box::new(|info| {
        let m = info.to_string();
        eprintln!("{m}");
        PANIC.with(|p| *p.borrow_mut() = m);
    }));
}

/// Runs engine work so that a panic in it (a book the importer does not expect) is an
/// error the page shows, as the web build's are: "Volumen hit a bug of its own (…)".
fn guarded<T>(f: impl FnOnce() -> Res<T>) -> Res<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).unwrap_or_else(|_| {
        let p = PANIC.with(|p| std::mem::take(&mut *p.borrow_mut()));
        // "panicked at crates/ingest/src/epub.rs:394:32:\nmessage"
        let (at, msg) = p.strip_prefix("panicked at ").and_then(|r| r.split_once(":\n")).unwrap_or(("", &p));
        let file = at.rsplit(['/', '\\']).next().unwrap_or(at);
        let place = file.rsplit_once(':').map(|(f, _)| f).unwrap_or(file);
        Err(format!("Volumen hit a bug of its own ({}, {place}).", msg.trim()))
    })
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn add(app: &App, bytes: &[u8], name: &str, sample: bool) -> Res<LibEntry> {
    add_as(app, bytes, name, sample, None)
}

/// Imports a file; `again`: the entry of a book being read again (its date and its place
/// among the samples kept).
fn add_as(app: &App, bytes: &[u8], name: &str, sample: bool, again: Option<&LibEntry>) -> Res<LibEntry> {
    let mut eng = app.engine.held();
    let id = eng.import(bytes, name)?;
    let book = eng.book(&id).unwrap();
    let e = LibEntry {
        id: id.clone(),
        title: book.meta.title.clone(),
        author: book.meta.author.clone(),
        year: book.meta.year.clone(),
        words: book.words(),
        chapters: book.sections.iter().filter(|s| s.kind == vol_engine::SectionKind::Chapter).count(),
        added: again.map(|a| a.added).unwrap_or_else(now),
        sample: again.map(|a| a.sample).unwrap_or(sample),
        cover: book.cover.is_some(),
        importer: vol_engine::IMPORTER_VERSION,
        source: true,
    };
    let cover = book.cover.as_ref().map(|c| c.bytes.clone());
    let images: Vec<(String, Vec<u8>)> = book.images.iter().map(|i| (i.mime.clone(), i.bytes.clone())).collect();
    let model = eng.save(&id).ok_or("the book could not be saved")?;
    drop(eng);
    let store = app.store.held();
    if again.is_some() {
        store.renew(&e.id).map_err(|e| e.to_string())?;
    }
    store.put(&e, &model).map_err(|e| e.to_string())?;
    store.put_source(&e.id, name, bytes).map_err(|e| e.to_string())?;
    if let Some(c) = cover {
        store.put_cover(&e.id, &c).map_err(|e| e.to_string())?;
    }
    store.put_images(&e.id, &images).map_err(|e| e.to_string())?;
    drop(store);
    app.indexer.held().send(e.id.clone()).ok();
    Ok(e)
}

/// The library's full-text index is kept by a thread of its own, on its own connection, so
/// neither an import nor the interface waits for it: first the books not yet indexed (a
/// library from before the index, or one whose indexing was cut short), then each book as
/// it is added.
fn start_indexer(dir: std::path::PathBuf) -> std::sync::mpsc::Sender<String> {
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let Ok(mut store) = Store::open(&dir) else { return };
        let index = |store: &mut Store, id: &str| {
            let Ok(Some(model)) = store.model(id) else { return };
            let Ok(book) = vol_engine::Book::restore(&model) else { return };
            if let Err(e) = store.index(id, vol_engine::search::fts_rows(&book)) {
                eprintln!("indexing {id}: {e}");
            }
        };
        for id in store.unindexed().unwrap_or_default() {
            index(&mut store, &id);
        }
        for id in rx {
            index(&mut store, &id);
        }
    });
    tx
}

/// Search the whole library's text: the index finds the paragraphs that may match, and
/// find's own matching (the same as in a book) says where exactly, with the words around
/// each match. Books with the most matches first.
#[tauri::command]
async fn search_library(query: String, app: State<'_, App>) -> Res<String> {
    use vol_engine::search::{fts_queries, in_book};
    let Some((phrase, words)) = fts_queries(&query) else { return Ok("[]".into()) };
    let found = {
        let store = app.store.held();
        let p = store.search(&phrase, 20000).map_err(|e| e.to_string())?;
        if p.is_empty() { store.search(&words, 20000).map_err(|e| e.to_string())? } else { p }
    };
    let mut out = Vec::new();
    for (id, blocks) in found.into_iter().take(60) {
        // the book as the engine holds it, or straight from its saved model
        let loaded = app.engine.held().book(&id).map(|b| in_book(b, Some(&blocks), &query, 3));
        let hits = match loaded {
            Some(h) => h,
            None => {
                let model = app.store.held().model(&id).map_err(|e| e.to_string())?;
                model.and_then(|m| vol_engine::Book::restore(&m).ok()).and_then(|b| in_book(&b, Some(&blocks), &query, 3))
            }
        };
        out.extend(hits);
    }
    // a phrase found anywhere outranks every-word matches
    let phrase_found = out.iter().any(|h| h.phrase);
    out.retain(|h| h.phrase == phrase_found);
    out.sort_by_key(|h| std::cmp::Reverse(h.total));
    serde_json::to_string(&out).map_err(|e| e.to_string())
}

fn ensure(app: &App, id: &str) -> Res<()> {
    if app.engine.held().has(id) {
        return Ok(());
    }
    let model = app.store.held().model(id).map_err(|e| e.to_string())?.ok_or("This book is no longer in the library.")?;
    app.engine.held().restore(&model)?;
    Ok(())
}

#[tauri::command]
async fn import_bytes(request: Request<'_>, app: State<'_, App>) -> Res<LibEntry> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected file bytes".into()) };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    guarded(|| add(&app, bytes, &name, false))
}

/// A book's kept file: its name (which tells its kind), then its bytes.
#[tauri::command]
async fn source_name(id: String, app: State<'_, App>) -> Res<Option<String>> {
    Ok(app.store.held().source(&id).map_err(|e| e.to_string())?.map(|(n, _)| n))
}

#[tauri::command]
async fn source_bytes(id: String, app: State<'_, App>) -> Res<Response> {
    Ok(Response::new(app.store.held().source(&id).map_err(|e| e.to_string())?.map(|(_, b)| b).unwrap_or_default()))
}

/// Reads a book again from its kept file, with the importer as it is now.
#[tauri::command]
async fn reimport(id: String, app: State<'_, App>) -> Res<LibEntry> {
    let (name, bytes) = app.store.held().source(&id).map_err(|e| e.to_string())?.ok_or("its file was not kept")?;
    let old = app.store.held().library().map_err(|e| e.to_string())?.into_iter().find(|e| e.id == id).ok_or("no such book")?;
    guarded(|| add_as(&app, &bytes, &name, old.sample, Some(&old)))
}

/// The backup just chosen in the picker, once.
#[tauri::command]
async fn picked_bytes(app: State<'_, App>) -> Res<Response> {
    Ok(Response::new(app.picked.held().take().unwrap_or_default()))
}

/// What the library's picker brought: a book (added), or another reader's notes file
/// (its text, for the frontend to place).
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Picked {
    Book(LibEntry),
    Notes { text: String },
    /// A backup of a whole library (app/src/core/backup.ts): read by `picked_bytes`.
    Backup,
}

/// A notebook exported as Markdown (app/src/reader/notesmd.ts), rather than a manuscript:
/// its notes go back on their books.
/// Or notes as W3C Web Annotations (app/src/reader/webanno.ts), from here or another tool.
fn is_notes_markdown(bytes: &[u8]) -> bool {
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(4000)]);
    head.lines().any(|l| l.starts_with("<!-- volumen-notes/")) || head.contains("http://www.w3.org/ns/anno.jsonld")
}

#[tauri::command]
async fn pick_book(window: tauri::Window, app: State<'_, App>) -> Res<Option<Picked>> {
    use tauri_plugin_dialog::DialogExt;
    let picked = window.dialog().file().add_filter("Books, manuscripts, notes and backups", &["epub", "docx", "md", "markdown", "txt", "vnotes", "json", "jsonld", "vbackup"]).blocking_pick_file();
    let Some(path) = picked.and_then(|p| p.into_path().ok()) else { return Ok(None) };
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    if bytes.starts_with(b"VOLBK1") {
        // (kept for the page to read: only the file just chosen can be read this way)
        *app.picked.held() = Some(bytes);
        return Ok(Some(Picked::Backup));
    }
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("vnotes")) || is_notes_markdown(&bytes) {
        return Ok(Some(Picked::Notes { text: String::from_utf8_lossy(&bytes).into_owned() }));
    }
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    guarded(|| add(&app, &bytes, &name, false)).map(|e| Some(Picked::Book(e)))
}

#[tauri::command]
async fn open_book(id: String, app: State<'_, App>) -> Res<String> {
    guarded(|| {
        ensure(&app, &id)?;
        app.engine.held().book_json(&id).ok_or_else(|| "missing book".into())
    })
}

#[tauri::command]
async fn layout(id: String, sections: Vec<u32>, p: LayoutRequest, app: State<'_, App>) -> Res<Response> {
    guarded(|| {
        ensure(&app, &id)?;
        Ok(Response::new(app.engine.held().layout(&id, &sections, &p)?))
    })
}

/// Find in book: little-endian u32s, see `Engine::find`.
#[tauri::command]
async fn find(id: String, query: String, limit: usize, app: State<'_, App>) -> Res<Response> {
    guarded(|| {
        ensure(&app, &id)?;
        let v = app.engine.held().find(&id, &query, limit).ok_or("missing book")?;
        Ok(Response::new(v.iter().flat_map(|x| x.to_le_bytes()).collect::<Vec<u8>>()))
    })
}

/// What a book needs beyond its theme's face (see `Engine::font_needs`).
#[tauri::command]
async fn font_needs(id: String, family: String, app: State<'_, App>) -> Res<String> {
    guarded(|| {
        ensure(&app, &id)?;
        app.engine.held().font_needs(&id, &family).ok_or_else(|| "missing book".into())
    })
}

/// Places notes on a book (see `vol_engine::anchor`).
#[tauri::command]
async fn place_notes(id: String, anchors: Vec<vol_engine::anchor::Anchor>, app: State<'_, App>) -> Res<Vec<vol_engine::anchor::Placed>> {
    guarded(|| {
        ensure(&app, &id)?;
        app.engine.held().place(&id, &anchors).ok_or_else(|| "missing book".into())
    })
}

#[tauri::command]
async fn probe(p: LayoutRequest, texts: Vec<String>, app: State<'_, App>) -> Res<Vec<f32>> {
    let t: Vec<&str> = texts.iter().map(String::as_str).collect();
    guarded(|| Ok(app.engine.held().probe(&p, &t)?.into_iter().flat_map(|(a, b, c)| [a, b, c]).collect()))
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
async fn system_families(app: State<'_, App>) -> Res<Vec<String>> {
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
async fn load_family(name: String, app: State<'_, App>) -> Res<serde_json::Value> {
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
async fn font_file(name: String, index: usize, app: State<'_, App>) -> Res<Response> {
    let files = app.loaded.held();
    let f = files.get(&name).and_then(|v| v.get(index)).ok_or("no such font file")?;
    Ok(Response::new(f.bytes.as_ref().clone()))
}

/// The desktop's colours, where the desktop publishes them (Omarchy).
fn omarchy_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let d = std::path::PathBuf::from(home).join(".local/state/omarchy/current");
    d.join("theme/colors.toml").exists().then_some(d)
}

#[tauri::command]
fn desktop_palette() -> Option<serde_json::Value> {
    let d = omarchy_dir()?;
    let text = std::fs::read_to_string(d.join("theme/colors.toml")).ok()?;
    let mut m = serde_json::Map::new();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim().trim_matches('"');
        m.insert(k.trim().to_string(), serde_json::Value::String(v.to_string()));
    }
    let name = std::fs::read_to_string(d.join("theme.name")).unwrap_or_default();
    m.insert("name".into(), serde_json::Value::String(name.trim().to_string()));
    Some(serde_json::Value::Object(m))
}

/// Tells the frontend when the desktop's theme changes.
fn watch_desktop(app: tauri::AppHandle) {
    let Some(d) = omarchy_dir() else { return };
    std::thread::spawn(move || {
        use tauri::Emitter;
        let stamp = || {
            let a = std::fs::read_to_string(d.join("theme.name")).unwrap_or_default();
            let b = std::fs::metadata(d.join("theme/colors.toml")).and_then(|m| m.modified()).ok();
            (a, b)
        };
        let mut last = stamp();
        loop {
            std::thread::sleep(std::time::Duration::from_millis(1200));
            let now = stamp();
            if now != last {
                last = now;
                let _ = app.emit("volumen://desktop", ());
            }
        }
    });
}

#[tauri::command]
async fn state_load(app: State<'_, App>) -> Res<Vec<(String, String)>> {
    app.store.held().state().map_err(|e| e.to_string())
}

#[tauri::command]
async fn state_put(changes: Vec<(String, Option<String>)>, app: State<'_, App>) -> Res<()> {
    app.store.held().put_state(&changes).map_err(|e| e.to_string())
}

#[tauri::command]
async fn cover(id: String, app: State<'_, App>) -> Res<Response> {
    let bytes = app.store.held().cover(&id).map_err(|e| e.to_string())?.unwrap_or_default();
    Ok(Response::new(bytes))
}

/// Sizes the reader measured for rich blocks, `(index, w, h)`, kept with the book.
#[tauri::command]
async fn set_image_sizes(id: String, sizes: Vec<(u32, u32, u32)>, app: State<'_, App>) -> Res<()> {
    guarded(|| {
        ensure(&app, &id)?;
        let model = {
            let mut eng = app.engine.held();
            eng.set_image_sizes(&id, &sizes);
            eng.save(&id).ok_or("the book could not be saved")?
        };
        app.store.held().put_model(&id, &model).map_err(|e| e.to_string())
    })
}

/// An image's bytes (a rich block's XHTML, which the page reads as text: a page cannot
/// fetch from the volimg: scheme, only show images from it).
#[tauri::command]
async fn image_bytes(id: String, idx: u32, app: State<'_, App>) -> Res<Response> {
    let found = app.store.held().image(&id, idx).map_err(|e| e.to_string())?;
    Ok(Response::new(found.map(|(_, b)| b).unwrap_or_default()))
}

/// Chapters of a file as an EPUB of their own (`vol_engine::epub_of`): the file in the
/// body, its name and the chapters in headers.
#[tauri::command]
async fn epub_of(request: Request<'_>) -> Res<Response> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected a file".into()) };
    let h = |k: &str| request.headers().get(k).and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let (from, to) = (h("x-from").parse().unwrap_or(1), h("x-to").parse().unwrap_or(usize::MAX));
    let name = h("x-name");
    Ok(Response::new(guarded(|| vol_engine::epub_of(bytes, &name, from, to))?))
}

/// Readers' notes put into a Word file as Word comments (`vol_engine::annotate_docx`).
/// Both ways one body: a u32 length (big-endian), that much JSON (the notes; the
/// report), then the Word file.
#[tauri::command]
async fn annotate_docx(request: Request<'_>) -> Res<Response> {
    let tauri::ipc::InvokeBody::Raw(body) = request.body() else { return Err("expected the notes and a Word file".into()) };
    let n = body.get(..4).map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize).ok_or("damaged request")?;
    let notes = std::str::from_utf8(body.get(4..4 + n).ok_or("damaged request")?).map_err(|e| e.to_string())?;
    let docx = &body[4 + n..];
    let (out, report) = guarded(|| vol_engine::annotate_docx(docx, notes))?;
    let mut answer = (report.len() as u32).to_be_bytes().to_vec();
    answer.extend_from_slice(report.as_bytes());
    answer.extend_from_slice(&out);
    Ok(Response::new(answer))
}

/// Replaces a book's cover with a smaller one (the library's thumbnail: `Library.svelte`).
#[tauri::command]
async fn set_cover(request: Request<'_>, app: State<'_, App>) -> Res<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected image bytes".into()) };
    let id = request.headers().get("x-id").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    app.store.held().put_cover(&id, bytes).map_err(|e| e.to_string())
}

/// Saves text (a notebook export, a theme) where the reader chooses. Returns false if
/// cancelled.
#[tauri::command]
async fn save_text(window: tauri::Window, name: String, text: String, ext: Option<String>) -> Res<bool> {
    use tauri_plugin_dialog::DialogExt;
    let (label, ext) = match ext.as_deref() {
        Some("json") => ("Theme", "json"),
        Some("vnotes") => ("Notes", "vnotes"),
        _ => ("Markdown", "md"),
    };
    let Some(path) = window.dialog().file().set_file_name(&name).add_filter(label, &[ext]).blocking_save_file() else { return Ok(false) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(true)
}

/// Offers bytes as a file to save (a sealed book: app/src/core/share.ts). Returns false
/// if cancelled.
#[tauri::command]
async fn save_bytes(window: tauri::Window, request: Request<'_>) -> Res<bool> {
    use tauri_plugin_dialog::DialogExt;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected bytes".into()) };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let Some(path) = window.dialog().file().set_file_name(&name).add_filter("Sealed book", &["vbook"]).blocking_save_file() else { return Ok(false) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
async fn library(app: State<'_, App>) -> Res<Vec<LibEntry>> {
    app.store.held().library().map_err(|e| e.to_string())
}

#[tauri::command]
async fn remove_book(id: String, app: State<'_, App>) -> Res<()> {
    app.engine.held().forget(&id);
    app.store.held().remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn selftest_mode() -> bool {
    cfg!(debug_assertions) && std::env::var_os("VOLUMEN_SELFTEST").is_some()
}

/// Which self-test to run (`VOLUMEN_SELFTEST=wheel` records wheel input; anything else
/// runs the full test).
#[tauri::command]
fn selftest_arg() -> String {
    if !selftest_mode() {
        return String::new();
    }
    std::env::var("VOLUMEN_SELFTEST").unwrap_or_default()
}

/// A corpus book for the self-test (debug builds only).
#[tauri::command]
fn dev_corpus(name: String) -> Res<Response> {
    if !cfg!(debug_assertions) || name.contains('/') {
        return Err("not available".into());
    }
    // the corpus, then the generated fixtures (bench/fixtures)
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
    let p = [root.join("corpus").join(&name), root.join("bench/fixtures").join(&name)].into_iter().find(|p| p.exists()).ok_or("no such book")?;
    Ok(Response::new(std::fs::read(p).map_err(|e| e.to_string())?))
}

/// Zooms the webview (debug builds only): the self-test's stand-in for display scaling.
#[tauri::command]
fn dev_zoom(window: tauri::WebviewWindow, scale: f64) -> Res<()> {
    if !cfg!(debug_assertions) {
        return Err("not available".into());
    }
    window.set_zoom(scale).map_err(|e| e.to_string())
}

#[tauri::command]
fn dev_log(msg: String) {
    if cfg!(debug_assertions) {
        println!("SELFTEST {msg}");
    }
}

#[tauri::command]
fn dev_quit(app: tauri::AppHandle) {
    if cfg!(debug_assertions) && std::env::var_os("VOLUMEN_SELFTEST").is_some() {
        app.exit(0);
    }
}

/// The frontend has saved its state and released its GL context: now the app may exit.
/// (Exiting with a live WebGL context crashes WebKitGTK's web process inside the nvidia
/// EGL driver, 2.52.6 / 580.x.)
#[tauri::command]
fn quit_now(app: tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    end_web_processes();
    app.exit(0);
}

/// WebKitGTK 2.52 with GPU compositing on the nvidia driver crashes (SIGSEGV in
/// libnvidia-eglcore) while its web process tears down its EGL context at exit. The
/// frontend has already saved, so the app ends its own web processes before exiting:
/// they run no teardown, and nothing crashes. Only direct children are touched.
#[cfg(target_os = "linux")]
fn end_web_processes() {
    // give the last storage writes a moment to reach WebKit's storage process
    std::thread::sleep(std::time::Duration::from_millis(150));
    let me = std::process::id().to_string();
    let Ok(dir) = std::fs::read_dir("/proc") else { return };
    for e in dir.flatten() {
        let name = e.file_name();
        let Some(pid) = name.to_str().filter(|p| p.bytes().all(|b| b.is_ascii_digit())) else { continue };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else { continue };
        // stat: pid (comm) state ppid ...
        let (Some(open), Some(close)) = (stat.find('('), stat.rfind(')')) else { continue };
        let comm = &stat[open + 1..close];
        let ppid = stat[close + 2..].split(' ').nth(1).unwrap_or("");
        if ppid == me && comm.starts_with("WebKitWebProces") {
            let _ = std::process::Command::new("kill").args(["-KILL", pid]).status();
        }
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// On the proprietary nvidia driver WebKitGTK's DMA-BUF renderer paints nothing. With it
/// off, GPU compositing works (WebKitGTK 2.52, tested 2026-10-13): smoother, vsynced.
/// `VOLUMEN_SAFE_GPU=1` also turns compositing off, the older workaround.
#[cfg(target_os = "linux")]
fn webkit_workarounds() {
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists();
    if !nvidia || std::env::var_os("VOLUMEN_KEEP_GPU").is_some() {
        return;
    }
    let mut vars = vec!["WEBKIT_DISABLE_DMABUF_RENDERER"];
    if std::env::var_os("VOLUMEN_SAFE_GPU").is_some() {
        vars.push("WEBKIT_DISABLE_COMPOSITING_MODE");
    }
    for k in vars {
        if std::env::var_os(k).is_none() {
            // SAFETY: called before any other thread starts
            unsafe { std::env::set_var(k, "1") };
        }
    }
}

fn main() {
    #[cfg(target_os = "linux")]
    webkit_workarounds();
    catch_panics();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let mut dir = app.path().app_data_dir()?;
            // the self-test never touches the reader's own library and state
            if selftest_mode() {
                dir.push("selftest");
            }
            let store = Store::open(&dir)?;
            let mut engine = Engine::new();
            for (code, bytes) in PATTERNS {
                engine.add_patterns(code, bytes.to_vec())?;
            }
            for (fam, files) in BUNDLED {
                for f in *files {
                    engine.add_font(fam, f.to_vec())?;
                }
            }
            let indexer = Mutex::new(start_indexer(dir.clone()));
            let state = App { engine: Mutex::new(engine), store: Mutex::new(store), indexer, sysfonts: Mutex::new(None), loaded: Mutex::new(Default::default()), picked: Mutex::new(None) };
            watch_desktop(app.handle().clone());
            // the sample book on first run; and again if it predates covers
            let lib = state.store.held().library().unwrap_or_default();
            if lib.is_empty() || lib.iter().any(|e| e.sample && !e.cover) {
                add(&state, SAMPLE, "sample.epub", true).ok();
            }
            app.manage(state);
            Ok(())
        })
        // a book's images, at volimg://localhost/<book>/<index>: the webview loads and
        // caches them like any file
        .register_asynchronous_uri_scheme_protocol("volimg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().trim_start_matches('/').to_string();
            std::thread::spawn(move || {
                let state = app.state::<App>();
                let (book, idx) = path.split_once('/').unwrap_or(("", ""));
                let found = idx.parse::<u32>().ok().and_then(|i| state.store.held().image(book, i).ok().flatten());
                let res = match found {
                    Some((mime, bytes)) => tauri::http::Response::builder().header("Content-Type", mime).header("Cache-Control", "max-age=31536000, immutable").body(bytes),
                    None => tauri::http::Response::builder().status(404).body(Vec::new()),
                };
                responder.respond(res.unwrap());
            });
        })
        .invoke_handler(tauri::generate_handler![import_bytes, pick_book, open_book, layout, find, search_library, place_notes, font_needs, probe, library, remove_book, state_load, state_put, cover, set_cover, set_image_sizes, image_bytes, annotate_docx, epub_of, reimport, source_name, source_bytes, picked_bytes, save_text, save_bytes, system_families, load_family, font_file, desktop_palette, selftest_mode, selftest_arg, dev_corpus, dev_zoom, dev_log, dev_quit, quit_now])
        .on_window_event(|window, event| {
            // closing goes through the frontend, which saves and releases its GL context
            // first; if it does not answer within two seconds the app exits anyway
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                use tauri::Emitter;
                api.prevent_close();
                let _ = window.emit("volumen://closing", ());
                let app = window.app_handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    quit_now(app);
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running the app");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_panic_in_engine_work_is_an_error_and_the_lock_still_works() {
        catch_panics();
        let m = Mutex::new(1);
        let r: Res<()> = guarded(|| {
            let _g = m.held();
            panic!("a fault made on purpose")
        });
        let e = r.unwrap_err();
        assert!(e.starts_with("Volumen hit a bug of its own (a fault made on purpose, main.rs:") && e.ends_with(")."), "{e}");
        assert_eq!(*m.held(), 1);
        assert_eq!(guarded(|| Ok(2)), Ok(2));
    }
}
