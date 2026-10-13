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

    println!("log_dir: {}", log_dir.display());

    let default_level = if cfg!(debug_assertions) {
        "launcher=debug"
    } else {
        "launcher=info"
    };
    let env_filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| default_level.into());

    use tracing_subscriber::prelude::*;

    // Тот же подход, что в lib.rs: builder вместо rolling::daily — build()
    // возвращает Err (а не паникует), если каталог read-only. Тестовый файл
    // .write-test не используем: открытие УЖЕ существующего файла
    // create+append не требует права записи на каталог, и оставшийся с
    // прошлого запуска файл давал ложный «writable».
    match tracing_appender::rolling::RollingFileAppender::builder()
        .rotation(tracing_appender::rolling::Rotation::DAILY)
        .filename_prefix("launcher.log")
        .build(&log_dir)
    {
        Ok(appender) => {
            println!("log dir writable: true");
            let (non_blocking, guard) = tracing_appender::non_blocking(appender);
            // Guard живёт до конца main: событие ниже должно успеть уйти
            // в файл (worker флешит при drop).
            tracing_subscriber::registry()
                .with(env_filter)
                .with(tracing_subscriber::fmt::layer().with_writer(non_blocking))
                .init();
            tracing::info!("sandbox probe initialized");
            drop(guard);
        }
        Err(_) => {
            println!("log dir writable: false");
            // Read-only: stdout, без ротации — главный сценарий пробы.
            tracing_subscriber::registry()
                .with(env_filter)
                .with(tracing_subscriber::fmt::layer())
                .init();
            tracing::info!("sandbox probe initialized");
        }
    }

    println!("probe ok");
}
