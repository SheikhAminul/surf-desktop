//! The main window: Browsy's own UI, served by the local server, in a native window.
//!
//! The page gets no access to the app (no IPC): native behaviour comes from how the window treats it. It stays on the
//! server's address; links elsewhere and new windows open in the default browser; downloads go to the Downloads
//! folder; closing it quits Browsy, after asking when profiles are open.

use crate::server::{self, Server};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::{DownloadEvent, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";

/// A quit confirmation is on screen.
static ASKING: AtomicBool = AtomicBool::new(false);

/// The window, on the start page until the server is ready.
pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let (navigation, popups, downloads) = (app.clone(), app.clone(), app.clone());
    WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Browsy")
        .inner_size(1240.0, 800.0)
        .min_inner_size(980.0, 640.0)
        .center()
        .on_navigation(move |url| allowed(&navigation, url))
        .on_new_window(move |url, _| {
            external(&popups, &url);
            NewWindowResponse::Deny
        })
        .on_download(move |_, event| download(&downloads, event))
        .build()?;
    Ok(())
}

/// The app's own pages (the start page), and the server's.
fn allowed(app: &AppHandle, url: &Url) -> bool {
    let own = url.scheme() == "tauri"
        || url.host_str() == Some("tauri.localhost")
        || url.scheme() == "about";
    if own
        || app
            .state::<Server>()
            .origin()
            .is_some_and(|origin| url.origin() == origin)
    {
        return true;
    }
    external(app, url);
    false
}

/// Open a web or mail address in the default browser or mail app (nothing else).
fn external(app: &AppHandle, url: &Url) {
    if matches!(url.scheme(), "http" | "https" | "mailto")
        && let Err(e) = app.opener().open_url(url.as_str(), None::<&str>)
    {
        log::warn!("couldn't open {url}: {e}");
    }
}

/// Show Browsy: sign in to the server that just started.
pub fn show(app: &AppHandle, sign_in: Url) {
    if let Some(window) = app.get_webview_window(MAIN)
        && let Err(e) = window.navigate(sign_in)
    {
        log::error!("couldn't show Browsy: {e}");
    }
}

/// Back to the start page, saying what's going on (`stopping`, `updating`).
pub fn notice(app: &AppHandle, state: &str) {
    // Tauri serves the app's own pages here (http://tauri.localhost on Windows).
    let base = if cfg!(windows) {
        "http://tauri.localhost"
    } else {
        "tauri://localhost"
    };
    if let (Some(window), Ok(url)) = (
        app.get_webview_window(MAIN),
        Url::parse(&format!("{base}/index.html#{state}")),
    ) {
        let _ = window.navigate(url);
    }
}

/// Bring the window forward (Browsy was opened again).
pub fn focus(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn on_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        request_quit(window.app_handle());
    }
}

/// Quit, asking first when profiles are open.
pub fn request_quit(app: &AppHandle) {
    let server = app.state::<Server>();
    if server.stopping() {
        // Already on its way out (or it never started): nothing to save.
        if server.exited() {
            app.exit(0);
        }
        return;
    }
    let open = server.open_profiles();
    if open == 0 {
        return quit(app);
    }
    if ASKING.swap(true, Ordering::SeqCst) {
        return;
    }
    let profiles = if open == 1 {
        "A profile is".to_string()
    } else {
        format!("{open} profiles are")
    };
    let app = app.clone();
    app.dialog()
        .message(format!(
            "{profiles} open. Browsy saves what's in progress before it closes, and picks up the browsers that keep running when it starts again."
        ))
        .title("Quit Browsy?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
        .show(move |yes| {
            ASKING.store(false, Ordering::SeqCst);
            if yes {
                quit(&app);
            }
        });
}

/// Stop the server (it saves open sessions) and exit.
fn quit(app: &AppHandle) {
    notice(app, "stopping");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        server::stop(&app).await;
        app.exit(0);
    });
}

/// The server failed to start or stopped unexpectedly: say why, and where the log is, then exit.
pub fn failed(app: &AppHandle, why: &str) {
    let log = app
        .path()
        .app_log_dir()
        .map(|dir| dir.display().to_string())
        .unwrap_or_default();
    log::error!("server failed: {why}");
    let app = app.clone();
    app.dialog()
        .message(format!("Browsy stopped: {why}\n\nThe log is in {log}."))
        .title("Browsy")
        .kind(MessageDialogKind::Error)
        .show(move |_| app.exit(1));
}

// ── Downloads ────────────────────────────────────────────────────────────────────────────────────────────────────

/// Downloads from Browsy (exports, cookies, recovery kits) go to the Downloads folder, under a name not taken yet.
fn download(app: &AppHandle, event: DownloadEvent<'_>) -> bool {
    match event {
        DownloadEvent::Requested { url, destination } => {
            // Only Browsy's own files (from the server, or made by its page: blob:http://127.0.0.1:…/…).
            if !app
                .state::<Server>()
                .origin()
                .is_some_and(|origin| url.origin() == origin)
            {
                log::warn!("download refused: {url}");
                return false;
            }
            let Ok(folder) = app.path().download_dir() else {
                return false;
            };
            *destination = available(&folder, &file_name(destination, &url));
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            finished(app, path, success);
            true
        }
        _ => true,
    }
}

/// The suggested name, or the address's last part, made safe for a file name.
fn file_name(suggested: &Path, url: &Url) -> String {
    let raw = suggested
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .or_else(|| {
            url.path_segments()
                .and_then(|mut segments| segments.next_back().map(str::to_string))
        })
        .unwrap_or_default();
    let name: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .take(150)
        .collect();
    let name = name.trim().trim_matches('.').to_string();
    if name.is_empty() {
        "download".into()
    } else {
        name
    }
}

/// `name` in `folder`, or `name (2)`, `name (3)`… when it's taken.
fn available(folder: &Path, name: &str) -> PathBuf {
    let path = folder.join(name);
    if !path.exists() {
        return path;
    }
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (name, String::new()),
    };
    (2..10_000)
        .map(|n| folder.join(format!("{stem} ({n}){extension}")))
        .find(|p| !p.exists())
        .unwrap_or(path)
}

fn finished(app: &AppHandle, path: Option<PathBuf>, success: bool) {
    let dialog = app.dialog();
    match path.filter(|_| success) {
        Some(path) => {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_default();
            let folder = path
                .parent()
                .map(|p| p.display().to_string())
                .unwrap_or_default();
            let app = app.clone();
            dialog
                .message(format!("“{name}” is saved in {folder}."))
                .title("Download complete")
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "Show in Folder".into(),
                    "OK".into(),
                ))
                .show(move |show| {
                    if show && let Err(e) = app.opener().reveal_item_in_dir(&path) {
                        log::warn!("couldn't show {}: {e}", path.display());
                    }
                });
        }
        None => dialog
            .message("The download didn't finish.")
            .title("Download failed")
            .kind(MessageDialogKind::Error)
            .show(|_| {}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_names_are_safe_and_free() {
        let url = Url::parse("http://127.0.0.1:7878/v1/downloads/abc").unwrap();
        assert_eq!(
            file_name(Path::new("/tmp/Profiles.browsy"), &url),
            "Profiles.browsy"
        );
        assert_eq!(file_name(Path::new(""), &url), "abc");
        assert_eq!(file_name(Path::new("/tmp/a:b?.json"), &url), "a_b_.json");
        assert_eq!(
            file_name(
                Path::new("/tmp/.."),
                &Url::parse("blob:http://127.0.0.1:7878/").unwrap()
            ),
            "download"
        );

        let folder = std::env::temp_dir().join(format!("browsy-downloads-{}", std::process::id()));
        std::fs::create_dir_all(&folder).unwrap();
        assert_eq!(available(&folder, "kit.txt"), folder.join("kit.txt"));
        std::fs::write(folder.join("kit.txt"), "").unwrap();
        std::fs::write(folder.join("kit (2).txt"), "").unwrap();
        assert_eq!(available(&folder, "kit.txt"), folder.join("kit (3).txt"));
        std::fs::write(folder.join("README"), "").unwrap();
        assert_eq!(available(&folder, "README"), folder.join("README (2)"));
        std::fs::remove_dir_all(&folder).unwrap();
    }
}
