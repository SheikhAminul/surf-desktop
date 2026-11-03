//! Updates: signed releases, checked after starting and once a day, installed when the person agrees.
//!
//! The updater installs a release only if its minisign signature verifies against the public key built into the app.
//! Release builds carry the key (see RELEASING.md); development builds have none, and don't update themselves.
//! Installing stops the server first, so open sessions are saved, and the window says what's happening.

use crate::{server, window};
use std::time::Duration;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

const FIRST: Duration = Duration::from_secs(30);
const EVERY: Duration = Duration::from_secs(24 * 60 * 60);

/// Whether this build can update itself: release builds carry the public key that signs updates.
fn configured(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(|key| key.as_str())
        .is_some_and(|key| !key.trim().is_empty())
}

pub fn schedule(app: &AppHandle) {
    if !configured(app) {
        log::info!("updates are off in this build (no update signing key)");
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST).await;
        loop {
            if let Err(e) = check(&app).await {
                log::warn!("update check: {e}");
            }
            tokio::time::sleep(EVERY).await;
        }
    });
}

/// Ask a question with two buttons; true for the first.
async fn ask(app: &AppHandle, title: &str, message: String, yes: &str, no: &str) -> bool {
    let (answer, answered) = tokio::sync::oneshot::channel();
    app.dialog()
        .message(message)
        .title(title)
        .buttons(MessageDialogButtons::OkCancelCustom(yes.into(), no.into()))
        .show(move |yes| {
            let _ = answer.send(yes);
        });
    answered.await.unwrap_or(false)
}

async fn check(app: &AppHandle) -> Result<(), tauri_plugin_updater::Error> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(());
    };
    let notes = update
        .body
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty());
    let notes = notes
        .map(|n| format!("\n\n{}", n.chars().take(600).collect::<String>()))
        .unwrap_or_default();
    let message = format!(
        "Surf Engine {} is available (you have {}).{notes}\n\nInstall it now? Surf Engine saves open profiles and restarts.",
        update.version, update.current_version
    );
    if !ask(
        app,
        "Update available",
        message,
        "Install and Restart",
        "Later",
    )
    .await
    {
        return Ok(());
    }
    let bytes = update.download(|_, _| {}, || {}).await?;
    window::notice(app, "updating");
    server::stop(app).await;
    // On Windows the installer takes over from here and ends this process.
    if let Err(e) = update.install(bytes) {
        log::error!("update install: {e}");
        app.dialog()
            .message(format!(
                "The update couldn't be installed: {e}\n\nSurf Engine restarts as it was."
            ))
            .title("Update failed")
            .kind(MessageDialogKind::Error)
            .blocking_show();
    }
    app.restart()
}
