// Точка входа библиотеки Tauri-приложения.
// Бинарь (main.rs) лишь вызывает run().

mod backend;
mod commands;
mod game_guard;
mod java;
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
    let (non_blocking, _guard) = tracing_appender::non_blocking(file_appender);

    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "launcher=info".into());

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
        .setup(|app| {
            commands::bootstrap(app.handle())?;
            Ok(())
        });
    commands::init(builder)
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
