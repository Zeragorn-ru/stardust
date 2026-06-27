// Точка входа библиотеки Tauri-приложения.
// Бинарь (main.rs) лишь вызывает run().

mod backend;
mod commands;
mod game_guard;
mod minecraft;
mod modpack;
mod paths;
mod progress;
mod update;

/// Запускает Tauri-приложение лаунчера.
pub fn run() {
    use tauri::Manager;

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
