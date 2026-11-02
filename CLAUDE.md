# Working on Browsy for desktop

## Principles

- A thin shell: Browsy's UI and logic live in browsy-app and browsy-core. Never re-implement them here; when the
  desktop needs something from them, add it there (as `browsy --embedded` was) and keep it usable without the desktop.
- The page gets no IPC. Native behaviour comes from the window (`on_navigation`, `on_new_window`, `on_download`) and
  from the server's stdout messages; anything new follows that pattern before exposing commands to the page.
- The server stops by closing its stdin (it saves sessions first). Never kill it while it may be saving.
- Chrome for Testing is the default browser, downloaded by the engine; the app never asks people to install it.

## Conventions

- Scripts: modern TypeScript run by Node.js 26 (`scripts/assemble.ts`); setup scripts that must run on any Node.js are
  plain JavaScript (`scripts/bootstrap.mjs`). Tabs, single quotes, no unnecessary semicolons (Biome).
- Rust: edition 2024, rustfmt, clippy with `-D warnings`. Small modules: `server` (the process), `window` (the window
  and what it lets through), `update` (signed updates).

## Checks

`pnpm assemble && pnpm lint && pnpm typecheck && pnpm check && cargo test --manifest-path src-tauri/Cargo.toml`
