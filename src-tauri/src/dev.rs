//! For the self-tests (VOLUMEN_SELFTEST, debug builds only): which test, the test books,
//! display scaling, and a log the test runner reads.
use crate::Res;
use tauri::ipc::Response;

#[tauri::command]
pub fn selftest_mode() -> bool {
    cfg!(debug_assertions) && std::env::var_os("VOLUMEN_SELFTEST").is_some()
}

/// Which self-test to run (`VOLUMEN_SELFTEST=wheel` records wheel input; anything else
/// runs the full test).
#[tauri::command]
pub fn selftest_arg() -> String {
    if !selftest_mode() {
        return String::new();
    }
    std::env::var("VOLUMEN_SELFTEST").unwrap_or_default()
}

/// A corpus book for the self-test (debug builds only).
#[tauri::command]
pub fn dev_corpus(name: String) -> Res<Response> {
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
pub fn dev_zoom(window: tauri::WebviewWindow, scale: f64) -> Res<()> {
    if !cfg!(debug_assertions) {
        return Err("not available".into());
    }
    window.set_zoom(scale).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn dev_log(msg: String) {
    if cfg!(debug_assertions) {
        println!("SELFTEST {msg}");
    }
}

