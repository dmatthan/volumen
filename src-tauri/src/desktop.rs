//! The computer the app runs on: the desktop's colours (Omarchy publishes them), and what
//! WebKitGTK on Linux needs to draw and to exit cleanly.
use tauri::Emitter;

/// The desktop's colours, where the desktop publishes them (Omarchy).
fn omarchy_dir() -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME")?;
    let d = std::path::PathBuf::from(home).join(".local/state/omarchy/current");
    d.join("theme/colors.toml").exists().then_some(d)
}

#[tauri::command]
pub fn desktop_palette() -> Option<serde_json::Value> {
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
pub fn watch_desktop(app: tauri::AppHandle) {
    let Some(d) = omarchy_dir() else { return };
    std::thread::spawn(move || {
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

/// On the proprietary nvidia driver WebKitGTK's DMA-BUF renderer paints nothing. With it
/// off, GPU compositing works (WebKitGTK 2.52, tested 2026-10-13): smoother, vsynced.
/// `VOLUMEN_SAFE_GPU=1` also turns compositing off, the older workaround.
#[cfg(target_os = "linux")]
pub fn webkit_workarounds() {
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

/// WebKitGTK 2.52 with GPU compositing on the nvidia driver crashes (SIGSEGV in
/// libnvidia-eglcore) while its web process tears down its EGL context at exit. The
/// frontend has already saved, so the app ends its own web processes before exiting:
/// they run no teardown, and nothing crashes. Only direct children are touched.
#[cfg(target_os = "linux")]
pub fn end_web_processes() {
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

