mod commands;
mod logging;
mod mcp;
mod menu;
mod state;
mod store;
mod watch;

use commands::{
    ai, boardcfg, build, devices, examples, files, libraries, lsp, package, project, recents,
    search, secrets, toolchain, updater, web,
};
use tauri::{Emitter, Manager};

/// Die stdio-Brücke für Claude Code. Läuft ohne Fenster.
pub fn mcp_bridge(info: Option<std::path::PathBuf>) {
    mcp::bridge(info);
}

pub fn run() {
    tauri::Builder::default()
        // Muss das erste Plugin sein: Ein zweiter Start reicht seine Pfade an die laufende App weiter.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let paths: Vec<std::path::PathBuf> = args
                .iter()
                .skip(1)
                .map(std::path::PathBuf::from)
                .filter(|p| p.exists())
                .collect();
            log::info!("Zweiter Start, {} Pfad(e) übergeben", paths.len());
            if let Some(path) = paths.into_iter().next() {
                *app.state::<state::AppState>().pending_open.lock().unwrap() = Some(path.clone());
                let _ = app.emit("open-path", path);
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(logging::plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        // Die Vorschau von Webseiten läuft unter einer eigenen Adresse mit eigener Sicherheitsrichtlinie.
        .register_uri_scheme_protocol(web::PREVIEW_SCHEME, web::serve)
        .manage(state::AppState::default())
        .setup(|app| {
            logging::install_panic_hook();
            log::info!("Forge {} startet", env!("CARGO_PKG_VERSION"));
            {
                let state = app.state::<state::AppState>();
                if let Ok(dir) = app.path().app_cache_dir() {
                    *state.toolchain.cache_base.lock().unwrap() = Some(dir);
                }
                devices::start_device_watch(app.handle(), &state);
                mcp::start_if_enabled(app.handle());
                package::register_quicklook(app.handle());
            }
            // Pfad aus der Kommandozeile: `forge-desktop /pfad/zum/projekt`.
            if let Some(arg) = std::env::args()
                .nth(1)
                .map(std::path::PathBuf::from)
                .filter(|p| p.exists())
            {
                *app.state::<state::AppState>().pending_open.lock().unwrap() = Some(arg);
            }
            Ok(())
        })
        .menu(menu::build)
        .on_menu_event(menu::on_event)
        .invoke_handler(tauri::generate_handler![
            project::default_projects_dir,
            project::project_open,
            project::project_create,
            project::sketch_create,
            project::project_convert,
            project::project_rename,
            project::menu_set_enabled,
            project::project_tree,
            project::project_validate_name,
            project::project_close,
            project::take_pending_open,
            files::file_read,
            files::file_write,
            files::file_create,
            files::file_rename,
            files::file_trash,
            boardcfg::project_set_board,
            toolchain::toolchain_status,
            toolchain::toolchain_setup,
            toolchain::toolchain_setup_nrf,
            toolchain::boards_list,
            toolchain::fbuild_status,
            toolchain::fbuild_install,
            toolchain::fbuild_set_enabled,
            toolchain::board_options,
            build::syntax_run,
            build::check_run,
            build::analysis_run,
            build::build_run,
            build::build_cancel,
            build::flash_run,
            devices::devices_list,
            devices::device_probe,
            devices::monitor_start,
            devices::monitor_stop,
            devices::monitor_write,
            ai::ai_state,
            ai::ai_configure,
            ai::ai_set_project_enabled,
            ai::ai_models,
            ai::ai_check,
            ai::ai_threads,
            ai::ai_thread_reply,
            ai::ai_thread_close,
            ai::ai_thread_reopen,
            ai::ai_fix,
            ai::ai_task,
            mcp::mcp_status,
            mcp::mcp_set_enabled,
            mcp::mcp_connect,
            mcp::mcp_open_in_claude,
            search::search_run,
            lsp::lsp_sync,
            lsp::lsp_complete,
            lsp::lsp_hover,
            lsp::lsp_definition,
            lsp::lsp_signature,
            lsp::lsp_tokens,
            lsp::file_read_external,
            secrets::secrets_list,
            secrets::secret_set,
            secrets::secret_remove,
            libraries::libraries_installed,
            libraries::libraries_search,
            libraries::library_install,
            libraries::library_uninstall,
            libraries::library_upgrade,
            package::package_needs,
            package::package_install_needs,
            package::package_save_as,
            package::package_export_folder,
            recents::recent_list,
            recents::recent_push,
            recents::recent_remove,
            lsp::format_available,
            lsp::format_document,
            lsp::lsp_symbols,
            lsp::lsp_references,
            lsp::lsp_prepare_rename,
            lsp::lsp_rename,
            examples::examples_list,
            examples::example_open,
            toolchain::core_upgrade,
            toolchain::toolchain_refresh_index,
            libraries::libraries_outdated,
            libraries::library_install_zip,
            build::build_memory_detail,
            devices::ota_password_status,
            devices::ota_password_set,
            devices::export_write,
            devices::monitor_reset,
            devices::monitor_set_baud,
            devices::backtrace_decode,
            updater::update_check,
            updater::update_install,
            updater::update_restart,
            web::web_preview_set,
        ])
        .build(tauri::generate_context!())
        .expect("Forge konnte nicht gestartet werden")
        .run(|app, event| {
            // Finder, `open -a Forge Ordner` und Drag & Drop auf das Dock-Symbol.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { urls } = &event {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        let state = app.state::<state::AppState>();
                        *state.pending_open.lock().unwrap() = Some(path.clone());
                        let _ = app.emit("open-path", path);
                    }
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (&app, &event);
            // Offene Änderungen gehören in die Projektdatei, bevor die App endet.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                tauri::async_runtime::block_on(package::flush(app));
            }
        });
}
