// Проба инициализации логов в песочнице с read-only каталогом.
//
// Дублирует логику run() из lib.rs (файловый аппендер с фоллбэком на
// stdout), но без Tauri — чтобы workflow launcher-sandbox-check мог
// быстро собрать и запустить её в Arch-контейнере. Если лог-каталог
// рядом с бинарём read-only (Gear Lever/Flatpak-сценарий), проба не
// паникует, а пишет в stdout и выходит кодом 0.
//
// Запуск: launcher-sandbox-probe [--probe-logs]

fn main() {
    let log_dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|p| p.to_path_buf()))
        .unwrap_or_else(|| std::path::PathBuf::from("."))
        .join("logs");

    // Тот же критерий записываемости, что в lib.rs: каталог создаётся
    // И тестовая запись в него проходит.
    let writable = std::fs::create_dir_all(&log_dir).is_ok()
        && std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join(".write-test"))
            .map(|f| {
                drop(f);
                let _ = std::fs::remove_file(log_dir.join(".write-test"));
                true
            })
            .unwrap_or(false);

    println!("log_dir: {}", log_dir.display());
    println!("log dir writable: {writable}");

    let default_level = if cfg!(debug_assertions) {
        "launcher=debug"
    } else {
        "launcher=info"
    };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| default_level.into());

    use tracing_subscriber::prelude::*;

    if writable {
        // Файловый путь — тоже не должен паниковать.
        let appender = tracing_appender::rolling::daily(&log_dir, "launcher.log");
        let (non_blocking, _guard) = tracing_appender::non_blocking(appender);
        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
            .init();
    } else {
        // Read-only: stdout, без ротации — главный сценарий пробы.
        tracing_subscriber::registry()
            .with(env_filter)
            .with(tracing_subscriber::fmt::layer())
            .init();
    }

    tracing::info!("sandbox probe initialized");
    println!("probe ok");
}
