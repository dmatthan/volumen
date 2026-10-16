// The desktop shell: the native engine behind a webview. Layout tables cross the
// bridge as raw bytes.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;
mod dev;
mod files;
mod fonts;
mod store;

use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use store::{LibEntry, Store};
use tauri::ipc::{Request, Response};
use fonts::{BUNDLED, SysFile};
use tauri::{Manager, State};
use vol_engine::{Engine, Request as LayoutRequest, percent_decode};

static SAMPLE: &[u8] = include_bytes!("../../assets/sample.epub");

/// Hyphenation patterns for every language offered (the web build fetches only a book's).
static PATTERNS: &[(&str, &[u8])] = &[
    ("en", include_bytes!("../../assets/hyph/en.bin")), ("de", include_bytes!("../../assets/hyph/de.bin")), ("fr", include_bytes!("../../assets/hyph/fr.bin")),
    ("es", include_bytes!("../../assets/hyph/es.bin")), ("it", include_bytes!("../../assets/hyph/it.bin")), ("pt", include_bytes!("../../assets/hyph/pt.bin")),
    ("nl", include_bytes!("../../assets/hyph/nl.bin")), ("sv", include_bytes!("../../assets/hyph/sv.bin")), ("da", include_bytes!("../../assets/hyph/da.bin")),
    ("no", include_bytes!("../../assets/hyph/no.bin")), ("fi", include_bytes!("../../assets/hyph/fi.bin")), ("pl", include_bytes!("../../assets/hyph/pl.bin")),
    ("cs", include_bytes!("../../assets/hyph/cs.bin")), ("ru", include_bytes!("../../assets/hyph/ru.bin")), ("la", include_bytes!("../../assets/hyph/la.bin")),
];

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

/// Replaces a book's cover with a smaller one (the library's thumbnail: `Library.svelte`).
#[tauri::command]
async fn set_cover(request: Request<'_>, app: State<'_, App>) -> Res<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected image bytes".into()) };
    let id = request.headers().get("x-id").and_then(|v| v.to_str().ok()).unwrap_or_default().to_string();
    app.store.held().put_cover(&id, bytes).map_err(|e| e.to_string())
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

/// The frontend has saved its state and released its GL context: now the app may exit.
/// (Exiting with a live WebGL context crashes WebKitGTK's web process inside the nvidia
/// EGL driver, 2.52.6 / 580.x.)
#[tauri::command]
fn quit_now(app: tauri::AppHandle) {
    #[cfg(target_os = "linux")]
    desktop::end_web_processes();
    app.exit(0);
}


fn main() {
    #[cfg(target_os = "linux")]
    desktop::webkit_workarounds();
    catch_panics();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let mut dir = app.path().app_data_dir()?;
            // the self-test never touches the reader's own library and state
            if dev::selftest_mode() {
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
            desktop::watch_desktop(app.handle().clone());
            // the sample book on first run
            if state.store.held().library().unwrap_or_default().is_empty() {
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
        .invoke_handler(tauri::generate_handler![
            import_bytes, open_book, layout, find, search_library, place_notes, font_needs, probe, library, remove_book, reimport, source_name, source_bytes,
            state_load, state_put, cover, set_cover, set_image_sizes, image_bytes, quit_now,
            files::pick_book, files::picked_bytes, files::save_text, files::save_bytes, files::epub_of, files::annotate_docx,
            fonts::system_families, fonts::load_family, fonts::font_file, desktop::desktop_palette,
            dev::selftest_mode, dev::selftest_arg, dev::dev_corpus, dev::dev_zoom, dev::dev_log,
        ])
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
