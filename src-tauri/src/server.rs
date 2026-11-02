//! The Browsy server: browsy-app's `browsy` command with `--embedded`, on the bundled Node.js runtime. It starts with
//! the app and tells it, one JSON object per stdout line, where to sign in and how many profiles are open. It stops
//! when its stdin closes, saving open sessions first: when the app quits, and also if the app ends unexpectedly.

use serde::Deserialize;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::{ChildStdin, Command};
use tokio::sync::watch;
use url::{Origin, Url};

/// How many of its last stderr lines are kept, to explain a failure.
const RECENT: usize = 40;

/// What the server says on stdout.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Message {
    #[serde(rename_all = "camelCase")]
    Ready {
        url: Url,
        sign_in: Url,
    },
    Sessions {
        open: u32,
    },
    #[serde(other)]
    Other,
}

pub struct Server {
    state: Mutex<State>,
    /// Becomes true when the server process has ended (or couldn't start).
    exited: watch::Sender<bool>,
}

#[derive(Default)]
struct State {
    /// Dropping it closes the server's stdin, which stops it.
    stdin: Option<ChildStdin>,
    /// Where the server answers, once it's ready.
    origin: Option<Origin>,
    open: u32,
    stopping: bool,
    recent: VecDeque<String>,
}

impl Default for Server {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            exited: watch::channel(false).0,
        }
    }
}

impl Server {
    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The server's origin (`http://127.0.0.1:<port>`), once it's ready: the only one the window shows.
    pub fn origin(&self) -> Option<Origin> {
        self.state().origin.clone()
    }

    /// Profiles open in Browsy (queued, starting, running or being saved).
    pub fn open_profiles(&self) -> u32 {
        self.state().open
    }

    /// Asked to stop (quitting or updating), or already ended.
    pub fn stopping(&self) -> bool {
        self.state().stopping || self.exited()
    }

    pub fn exited(&self) -> bool {
        *self.exited.borrow()
    }

    /// Why it failed, from what it said last: its own error line (`browsy: …`) when there is one.
    fn failure(&self) -> String {
        let state = self.state();
        match state
            .recent
            .iter()
            .rev()
            .find_map(|line| line.strip_prefix("browsy: "))
        {
            Some(error) => error.to_string(),
            None => state
                .recent
                .iter()
                .rev()
                .take(8)
                .rev()
                .cloned()
                .collect::<Vec<_>>()
                .join("\n"),
        }
    }
}

/// Where Tauri puts a bundled program (`externalBin`): next to the app's executable.
fn sidecar(name: &str) -> std::io::Result<PathBuf> {
    let exe = tauri::utils::platform::current_exe()?;
    let dir = exe
        .parent()
        .ok_or_else(|| std::io::Error::other("the app's folder is unknown"))?;
    Ok(dir.join(if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }))
}

/// Start the server and follow it; the window shows Browsy as soon as it's ready.
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run(&app).await {
            let server = app.state::<Server>();
            server.state().recent.push_back(format!("browsy: {e}"));
            server.exited.send_replace(true);
            crate::window::failed(&app, &server.failure());
        }
    });
}

async fn run(app: &AppHandle) -> std::io::Result<()> {
    // Its own name: Linux packages install it in /usr/bin, next to any other Node.js.
    let node = sidecar("browsy-node")?;
    let script = app
        .path()
        .resource_dir()
        .map_err(std::io::Error::other)?
        .join("app")
        .join("server")
        .join("browsy.mjs");
    let mut command = Command::new(&node);
    command
        .arg(&script)
        .arg("--embedded")
        // The runtime is Browsy's own: options meant for another Node.js don't apply.
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console window next to the app.
    let mut child = command
        .spawn()
        .map_err(|e| std::io::Error::other(format!("{} couldn't start: {e}", node.display())))?;
    log::info!("server started (pid {})", child.id().unwrap_or_default());
    let server = app.state::<Server>();
    {
        // Quitting already (right after starting): its stdin closes here, and it stops at once.
        let stdin = child.stdin.take();
        let mut state = server.state();
        if !state.stopping {
            state.stdin = stdin;
        }
    }
    if let Some(stdout) = child.stdout.take() {
        tauri::async_runtime::spawn(messages(app.clone(), stdout));
    }
    if let Some(stderr) = child.stderr.take() {
        tauri::async_runtime::spawn(output(app.clone(), stderr));
    }
    let status = child.wait().await?;
    log::info!("server ended ({status})");
    let stopping = {
        let mut state = server.state();
        state.stdin = None;
        state.origin = None;
        state.stopping
    };
    server.exited.send_replace(true);
    if stopping {
        // Whoever stopped it (quitting, updating) goes on from here.
    } else if status.success() {
        // Stopped on request from the page (Settings → Quit).
        app.exit(0);
    } else {
        crate::window::failed(app, &server.failure());
    }
    Ok(())
}

async fn messages(app: AppHandle, stdout: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        match serde_json::from_str::<Message>(&line) {
            Ok(Message::Ready { url, sign_in }) => {
                log::info!("server ready at {url}");
                app.state::<Server>().state().origin = Some(url.origin());
                crate::window::show(&app, sign_in);
            }
            Ok(Message::Sessions { open }) => app.state::<Server>().state().open = open,
            Ok(Message::Other) => {}
            Err(_) => log::info!(target: "server", "{line}"),
        }
    }
}

async fn output(app: AppHandle, stderr: impl AsyncRead + Unpin) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        log::info!(target: "server", "{line}");
        let server = app.state::<Server>();
        let mut state = server.state();
        if state.recent.len() == RECENT {
            state.recent.pop_front();
        }
        state.recent.push_back(line);
    }
}

/// Stop the server (it saves the sessions in progress first) and wait until it has ended.
pub async fn stop(app: &AppHandle) {
    let server = app.state::<Server>();
    {
        let mut state = server.state();
        state.stopping = true;
        state.stdin = None;
    }
    let mut exited = server.exited.subscribe();
    let _ = exited.wait_for(|ended| *ended).await;
}
