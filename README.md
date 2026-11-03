# Surf Engine for desktop

Surf as a desktop app for macOS, Windows and Linux: [surf-app](https://github.com/SheikhAminul/surf-app) (the UI
and the server, around [`@surf/core`](https://github.com/SheikhAminul/surf-core)) in a native window, with its own
Node.js runtime. Nothing to install besides the app, and profiles run on Chrome for Testing, which Surf downloads on
first start.

```
┌─ Surf (Tauri, Rust) ───────────────────────────────┐
│  window ── shows ──► http://127.0.0.1:<port>          │
│    │                    ▲                             │
│    │ links, new windows │ UI, /v1 API, SSE, MCP, CDP  │
│    ▼ downloads          │                             │
│  default browser,    surf --embedded (Node.js 26) ──┼──► @surf/core ──► Chrome, disk, keychain
│  Downloads folder       ▲  stdout: JSON lines         │
│                         └─ stdin: closes to stop      │
└───────────────────────────────────────────────────────┘
```

The desktop app is a thin shell; everything Surf does lives in surf-app and surf-core, unchanged:

- **The server** is surf-app's own `surf` command with `--embedded`, bundled into one file and run on the Node.js
  runtime that ships with the app. It tells the app where it listens and its one-time sign-in link, and how many
  profiles are open, as JSON lines on stdout. Closing its stdin stops it, saving open sessions first: when the app
  quits, and also if the app ends unexpectedly.
- **The window** shows the server's UI. The page gets no access to the app (no IPC): it stays on the server's address;
  links elsewhere and new windows (the cloud live view) open in the default browser; downloads (exports, cookies,
  recovery kits) go to the Downloads folder, with a button to show them. Choosing files uses the system's file picker.
- **Quitting** (closing the window, ⌘Q, Settings → Quit) asks first when profiles are open, then shows "Saving open
  profiles…" until the server has stopped. Browsers that keep running are picked up when Surf starts again.
- **One Surf at a time**: opening it again shows the running one. It uses surf-app's data folder
  (`~/.local/share/surf-web`, `~/Library/Application Support/surf-web`, `%LOCALAPPDATA%\surf-web`), so it has the
  same profiles as `npx surf` (one of them at a time), and `SURF_DATA_DIR` and the other `SURF_*` settings apply.
- **Scripts and AI agents** reach it as they reach `npx surf`: on port 7878, or another free port if that's taken
  (Automation shows it).
- **Updates** are signed releases from this repository: Surf checks after starting and daily, asks, saves open
  profiles and restarts into the new version. Builds without the release key (development builds) don't update.
- **The log** (the app's and the server's output) is in the app's log folder: `~/.config/app.surf.desktop/logs`,
  `~/Library/Logs/app.surf.desktop`, `%LOCALAPPDATA%\app.surf.desktop\logs`.

## Develop

Next to checkouts of surf-app, surf-core and surf-extension (setup finds or downloads them):

```bash
pnpm bootstrap   # guided: checks Node.js 26+, pnpm, Rust and the system libraries, sets up surf-app, assembles
pnpm dev         # run the app (rebuilds surf-app first when it changed)
pnpm build       # installers in src-tauri/target/release/bundle
```

`pnpm assemble` (run by `dev` and `build`) brings surf-app up to date with its own `pnpm bootstrap`, bundles its
server with esbuild into `src-tauri/resources/app` next to its UI and the extension, and puts the Node.js runtime named
in `.node-version` (from nodejs.org, checksum verified) in `src-tauri/binaries`. Settings: `SURF_APP_DIR` (where
surf-app is), `SURF_NODE` (a local Node.js binary of that version, for offline builds),
`SURF_ASSEMBLE_SKIP_BOOTSTRAP=1`.

```bash
pnpm lint && pnpm typecheck && pnpm check && cargo test --manifest-path src-tauri/Cargo.toml
```

Code style: Biome for the scripts (tabs, single quotes, no semicolons), rustfmt and clippy for Rust. Releasing:
[RELEASING.md](RELEASING.md).
