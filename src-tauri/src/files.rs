//! Files in and out: the library's picker (books, notes, backups), saving where the reader
//! chooses, and the conversions that go from a file to a file (an extract as an EPUB,
//! readers' notes as Word comments).
use crate::{App, Held, Res, add, guarded, percent_decode};
use crate::store::LibEntry;
use tauri::State;
use tauri::ipc::{Request, Response};

/// The backup just chosen in the picker, once.
#[tauri::command]
pub async fn picked_bytes(app: State<'_, App>) -> Res<Response> {
    Ok(Response::new(app.picked.held().take().unwrap_or_default()))
}

/// What the library's picker brought: a book (added), or another reader's notes file
/// (its text, for the frontend to place).
#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Picked {
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
pub async fn pick_book(window: tauri::Window, app: State<'_, App>) -> Res<Option<Picked>> {
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

/// Chapters of a file as an EPUB of their own (`vol_engine::epub_of`): the file in the
/// body, its name and the chapters in headers.
#[tauri::command]
pub async fn epub_of(request: Request<'_>) -> Res<Response> {
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
pub async fn annotate_docx(request: Request<'_>) -> Res<Response> {
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

/// Saves text (a notebook export, a theme) where the reader chooses. Returns false if
/// cancelled.
#[tauri::command]
pub async fn save_text(window: tauri::Window, name: String, text: String, ext: Option<String>) -> Res<bool> {
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
pub async fn save_bytes(window: tauri::Window, request: Request<'_>) -> Res<bool> {
    use tauri_plugin_dialog::DialogExt;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else { return Err("expected bytes".into()) };
    let name = request.headers().get("x-name").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let Some(path) = window.dialog().file().set_file_name(&name).add_filter("Sealed book", &["vbook"]).blocking_save_file() else { return Ok(false) };
    let path = path.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(true)
}

