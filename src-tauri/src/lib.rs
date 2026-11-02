//! Browsy's desktop app: a native window around browsy-app, which does everything else. The app starts the Browsy
//! server on its own Node.js runtime (`server`), shows its UI (`window`), and keeps itself up to date (`update`).

mod server;
mod update;
mod window;

use tauri::{Manager, RunEvent};
use tauri_plugin_log::{RotationStrategy, Target, TargetKind};

pub fn run() {
    tauri::Builder::default()
        // First: a second Browsy would fight over the same profiles; opening it again shows this one.
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            window::focus(app)
        }))
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets([
                    Target::new(TargetKind::Stdout),
                    Target::new(TargetKind::LogDir {
                        file_name: Some("browsy".into()),
                    }),
                ])
                .max_file_size(5_000_000)
                .rotation_strategy(RotationStrategy::KeepOne)
                .build(),
        )
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(server::Server::default())
        .setup(|app| {
            window::create(app.handle())?;
            server::start(app.handle());
            update::schedule(app.handle());
            Ok(())
        })
        .on_window_event(window::on_event)
        .build(tauri::generate_context!())
        .expect("Browsy couldn't start")
        .run(|app, event| {
            // Quitting from the menu (⌘Q) or the system: save open profiles first, as when the window closes.
            if let RunEvent::ExitRequested { api, .. } = event
                && !app.state::<server::Server>().exited()
            {
                api.prevent_exit();
                window::request_quit(app);
            }
        });
}
