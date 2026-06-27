// Кросс-процессная защита от запуска второй копии игры.
//
// Внутрипроцессного `Mutex<Option<Child>>` в AppState недостаточно: плагин
// single-instance не даёт открыть второе окно лаунчера, но пользователь может
// закрыть лаунчер, пока игра ещё работает (при drop `Child` процесс игры НЕ
// убивается), а затем открыть лаунчер заново. Новый процесс получает свежий
// AppState с `game = None` и спокойно запускает второй Minecraft.
//
// Чтобы это закрыть, пишем PID запущенной игры в файл `game.pid` внутри
// data-dir (общий для всех запусков лаунчера в данном режиме). Перед стартом
// проверяем, жив ли записанный PID.
//
// Ограничение: проверка по «живости PID» подвержена редкому переиспользованию
// PID (ОС выдала тот же номер другому процессу) — тогда возможен ложный отказ.
// Для защиты от случайного двойного запуска этого достаточно; полная строгость
// потребовала бы хранить ещё и время старта процесса, что усложняет кросс-платформенность.

use std::path::{Path, PathBuf};

/// Имя PID-файла запущенной игры внутри data-dir.
const PID_FILE: &str = "game.pid";

/// Путь к PID-файлу для данного data-dir.
fn pid_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PID_FILE)
}

/// Проверяет, запущена ли уже игра (по PID-файлу в data-dir).
///
/// Возвращает `true`, только если PID-файл существует и записанный процесс ещё
/// жив. Если файл отсутствует, нечитаем или процесс мёртв — считаем, что игры
/// нет (а заодно подчищаем устаревший файл).
pub fn is_running(data_dir: &Path) -> bool {
    let path = pid_path(data_dir);
    let Some(pid) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
    else {
        // Файла нет или он повреждён — убираем мусор, игры нет.
        let _ = std::fs::remove_file(&path);
        return false;
    };
    if process_alive(pid) {
        true
    } else {
        // Процесс уже завершился — PID-файл устарел.
        let _ = std::fs::remove_file(&path);
        false
    }
}

/// Фиксирует PID запущенной игры в data-dir.
pub fn record(data_dir: &Path, pid: u32) {
    let _ = std::fs::write(pid_path(data_dir), pid.to_string());
}

/// Удаляет PID-файл (вызывается, когда известно, что игра завершилась).
pub fn clear(data_dir: &Path) {
    let _ = std::fs::remove_file(pid_path(data_dir));
}

/// Жив ли процесс с данным PID.
#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    // kill(pid, 0) ничего не шлёт, только проверяет существование процесса:
    //   0      — процесс существует и нам доступен;
    //   EPERM  — процесс существует, но принадлежит другому пользователю;
    //   ESRCH  — такого процесса нет.
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if ret == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Жив ли процесс с данным PID.
#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    // SYNCHRONIZE-доступа достаточно для WaitForSingleObject.
    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        // Не удалось открыть — процесса, вероятно, уже нет.
        return false;
    }
    // Таймаут 0: WAIT_TIMEOUT означает, что процесс ещё не сигнализирован, т.е. жив.
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    wait == WAIT_TIMEOUT
}

/// Заглушка для прочих платформ: считаем, что параллельной игры нет.
#[cfg(not(any(unix, windows)))]
fn process_alive(_pid: u32) -> bool {
    false
}
