# Browsy for desktop

Browsy as a desktop app for macOS, Windows and Linux: [browsy-app](https://github.com/SheikhAminul/browsy-app) (the UI
and the server, around [`@browsy/core`](https://github.com/SheikhAminul/browsy-core)) in a native window, with its own
Node.js runtime. Nothing to install besides the app, and profiles run on Chrome for Testing, which Browsy downloads on
first start.

```
┌─ Browsy (Tauri, Rust) ───────────────────────────────┐
│  window ── shows ──► http://127.0.0.1:<port>          │
│    │                    ▲                             │
│    │ links, new windows │ UI, /v1 API, SSE, MCP, CDP  │
│    ▼ downloads          │                             │
│  default browser,    browsy --embedded (Node.js 26) ──┼──► @browsy/core ──► Chrome, disk, keychain
│  Downloads folder       ▲  stdout: JSON lines         │
│                         └─ stdin: closes to stop      │
└───────────────────────────────────────────────────────┘
```

The desktop app is a thin shell; everything Browsy does lives in browsy-app and browsy-core, unchanged:

- **The server** is browsy-app's own `browsy` command with `--embedded`, bundled into one file and run on the Node.js
  runtime that ships with the app. It tells the app where it listens and its one-time sign-in link, and how many
  profiles are open, as JSON lines on stdout. Closing its stdin stops it, saving open sessions first: when the app
  quits, and also if the app ends unexpectedly.
- **The window** shows the server's UI. The page gets no access to the app (no IPC): it stays on the server's address;
  links elsewhere and new windows (the cloud live view) open in the default browser; downloads (exports, cookies,
  recovery kits) go to the Downloads folder, with a button to show them. Choosing files uses the system's file picker.
- **Quitting** (closing the window, ⌘Q, Settings → Quit) asks first when profiles are open, then shows "Saving open
  profiles…" until the server has stopped. Browsers that keep running are picked up when Browsy starts again.
- **One Browsy at a time**: opening it again shows the running one. It uses browsy-app's data folder
  (`~/.local/share/browsy-web`, `~/Library/Application Support/browsy-web`, `%LOCALAPPDATA%\browsy-web`), so it has the
  same profiles as `npx browsy` (one of them at a time), and `BROWSY_DATA_DIR` and the other `BROWSY_*` settings apply.
- **Scripts and AI agents** reach it as they reach `npx browsy`: on port 7878, or another free port if that's taken
  (Automation shows it).
- **Updates** are signed releases from this repository: Browsy checks after starting and daily, asks, saves open
  profiles and restarts into the new version. Builds without the release key (development builds) don't update.
- **The log** (the app's and the server's output) is in the app's log folder: `~/.config/app.browsy.desktop/logs`,
  `~/Library/Logs/app.browsy.desktop`, `%LOCALAPPDATA%\app.browsy.desktop\logs`.

## Develop

Next to checkouts of browsy-app, browsy-core and browsy-extension (setup finds or downloads them):

```bash
pnpm bootstrap   # guided: checks Node.js 26+, pnpm, Rust and the system libraries, sets up browsy-app, assembles
pnpm dev         # run the app (rebuilds browsy-app first when it changed)
pnpm build       # installers in src-tauri/target/release/bundle
```

`pnpm assemble` (run by `dev` and `build`) brings browsy-app up to date with its own `pnpm bootstrap`, bundles its
server with esbuild into `src-tauri/resources/app` next to its UI and the extension, and puts the Node.js runtime named
in `.node-version` (from nodejs.org, checksum verified) in `src-tauri/binaries`. Settings: `BROWSY_APP_DIR` (where
browsy-app is), `BROWSY_NODE` (a local Node.js binary of that version, for offline builds),
`BROWSY_ASSEMBLE_SKIP_BOOTSTRAP=1`.

```bash
pnpm lint && pnpm typecheck && pnpm check && cargo test --manifest-path src-tauri/Cargo.toml
```

Code style: Biome for the scripts (tabs, single quotes, no semicolons), rustfmt and clippy for Rust. Releasing:
[RELEASING.md](RELEASING.md).
