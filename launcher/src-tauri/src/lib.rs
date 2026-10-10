// Точка входа библиотеки Tauri-приложения.
// Бинарь (main.rs) лишь вызывает run().

mod backend;
mod commands;
mod game_guard;
mod java;
#[cfg(target_os = "macos")]
mod macos_permissions;
#[cfg(target_os = "macos")]
mod macos_titlebar;
mod minecraft;
mod modpack;
mod paths;
mod progress;
mod sha256;
mod update;

/// Запускает Tauri-приложение лаунчера.
pub fn run() {
    use tauri::Manager;

    // Логи пишутся рядом с бинарём: <exe_dir>/logs/launcher.log (ротация по дням).
    let log_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("logs");
    let file_appender = tracing_appender::rolling::daily(&log_dir, "launcher.log");
    let (non_blocking, guard) = tracing_appender::non_blocking(file_appender);
    // The worker must live for the entire process. Dropping the guard at the
    // end of setup can leave launcher logs buffered and the file empty.
    let _log_guard: &'static _ = Box::leak(Box::new(guard));

    let default_level = if cfg!(debug_assertions) {
        "launcher=debug"
    } else {
        "launcher=info"
    };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| default_level.into());

    use tracing_subscriber::prelude::*;

    tracing_subscriber::registry()
        .with(env_filter)
        .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
        .init();

    let builder = tauri::Builder::default()
        // single-instance обязан регистрироваться первым. При попытке открыть
        // второй экземпляр просто фокусируем уже открытое окно.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.webview_windows().values().next() {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        // The plugin is registered in every build. Stable and test channels use
        // signed Tauri updates; the legacy Rust updater remains available as an
        // emergency rollback and migration path for old installed clients.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            commands::bootstrap(app.handle())?;

            // macOS: нативная шапка. На macOS окно создаётся сразу с нативными
            // декорациями (tauri.macos.conf.json: decorations:true + Overlay),
            // поэтому рантайм-переключений масок нет — они и ломали раскладку
            // (tao применяет set_decorations через async main-queue и AppKit
            // пересобирает titlebar). Геометрию полосы 38pt настраивает
            // нативный хелпер ПОСЛЕ применения стилей. На Windows/Linux
            // по-прежнему decorations:false + кастомная шапка из конфига.
            // Дополнительно — стандартное меню приложения, чтобы Cmd+Q / About
            // работали как у остальных Mac-приложений.
            #[cfg(target_os = "macos")]
            {
                std::thread::spawn(|| {
                    crate::macos_permissions::ensure_microphone_permission();
                });

                use tauri::menu::{MenuBuilder, SubmenuBuilder};
                if app.get_webview_window("main").is_some() {
                    let handle = app.handle().clone();
                    let handle2 = app.handle().clone();
                    tauri::async_runtime::spawn(async move {
                        // Хелпер должен отработать после применения масок окна
                        // tao (async main-queue), поэтому вызываем его тоже
                        // через main-thread очередь — FIFO гарантирует порядок.
                        let _ = handle.run_on_main_thread(move || {
                            if let Some(w) = handle2.get_webview_window("main") {
                                crate::macos_titlebar::apply(&w);
                            }
                        });
                    });
                }
                if let Ok(app_menu) = SubmenuBuilder::new(app, "StarDust")
                    .about(None)
                    .separator()
                    .services()
                    .separator()
                    .hide()
                    .hide_others()
                    .show_all()
                    .separator()
                    .quit()
                    .build()
                {
                    if let Ok(window_menu) = SubmenuBuilder::new(app, "Окно")
                        .minimize()
                        .separator()
                        .close_window()
                        .build()
                    {
                        if let Ok(menu) = MenuBuilder::new(app)
                            .item(&app_menu)
                            .item(&window_menu)
                            .build()
                        {
                            let _ = app.set_menu(menu);
                        }
                    }
                }
            }

            Ok(())
        });
    commands::init(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
