// Кросс-процессная защита от запуска второй копии игры.
//
// Внутрипроцессного PID в AppState недостаточно: плагин
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

use serde::{Deserialize, Serialize};

/// Имя PID-файла запущенной игры внутри data-dir.
const PID_FILE: &str = "game.pid";

/// Имя файла незавершённой игровой сессии (для восстановления после краша/закрытия лаунчера).
const SESSION_FILE: &str = "game_session.json";

/// Данные сессии, сохраняемые на диск перед запуском игры.
#[derive(Debug, Serialize, Deserialize)]
pub struct PendingSession {
    /// RFC 3339, время старта игры.
    pub launched_at: String,
    pub pid: u32,
}

/// Записывает PID и `launched_at` на диск.
pub fn write_session(data_dir: &Path, pid: u32, launched_at: &str) {
    let s = PendingSession {
        launched_at: launched_at.to_owned(),
        pid,
    };
    if let Ok(json) = serde_json::to_string(&s) {
        let _ = std::fs::write(data_dir.join(SESSION_FILE), json);
    }
}

/// Читает незавершённую сессию. Возвращает `None` если файла нет или он повреждён.
pub fn read_session(data_dir: &Path) -> Option<PendingSession> {
    let s = std::fs::read_to_string(data_dir.join(SESSION_FILE)).ok()?;
    serde_json::from_str(&s).ok()
}

/// Удаляет файл незавершённой сессии.
pub fn clear_session(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(SESSION_FILE));
}

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

/// Список известных чит-программ и инжекторов.
const BANNED_PROCESSES: &[&str] = &[
    "Extreme-Injector.exe",
    "xenos.exe",
    "vea.exe", // Vape
    "koid.exe", // Koid
               // добавьте другие .exe по желанию
];

/// Сканирует запущенные в системе процессы (Windows) на предмет известных читов.
/// Возвращает `Err(название_чита)`, если найден запрещённый процесс.
#[cfg(windows)]
pub fn scan_for_cheats() -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32First, Process32Next, PROCESSENTRY32, TH32CS_SNAPPROCESS,
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Ok(()); // Не удалось получить список процессов
    }

    let mut entry = PROCESSENTRY32 {
        dwSize: std::mem::size_of::<PROCESSENTRY32>() as u32,
        cntUsage: 0,
        th32ProcessID: 0,
        th32DefaultHeapID: 0,
        th32ModuleID: 0,
        cntThreads: 0,
        th32ParentProcessID: 0,
        pcPriClassBase: 0,
        dwFlags: 0,
        szExeFile: [0; 260],
    };

    let mut success = unsafe { Process32First(snapshot, &mut entry) };
    while success != 0 {
        let exe_bytes: Vec<u8> = entry
            .szExeFile
            .iter()
            .take_while(|&&c| c != 0)
            .map(|&c| c as u8)
            .collect();

        if let Ok(exe_name) = String::from_utf8(exe_bytes) {
            let exe_lower = exe_name.to_lowercase();
            for banned in BANNED_PROCESSES {
                if exe_lower == banned.to_lowercase() {
                    unsafe { CloseHandle(snapshot) };
                    return Err(exe_name);
                }
            }
        }
        success = unsafe { Process32Next(snapshot, &mut entry) };
    }

    unsafe { CloseHandle(snapshot) };
    Ok(())
}

/// Базовый сканер для Linux. Ищет запущенные процессы в /proc.
#[cfg(unix)]
pub fn scan_for_cheats() -> Result<(), String> {
    if let Ok(entries) = std::fs::read_dir("/proc") {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_dir() {
                    // /proc/[pid]/comm содержит имя процесса
                    let comm_path = entry.path().join("comm");
                    if let Ok(comm) = std::fs::read_to_string(comm_path) {
                        let comm_lower = comm.trim().to_lowercase();
                        for banned in BANNED_PROCESSES {
                            let banned_lower = banned.to_lowercase();
                            // В Linux имена процессов часто обрезаются, либо идут без .exe
                            let banned_no_ext =
                                banned_lower.strip_suffix(".exe").unwrap_or(&banned_lower);
                            if comm_lower == banned_no_ext {
                                return Err(comm.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[cfg(not(any(unix, windows)))]
pub fn scan_for_cheats() -> Result<(), String> {
    Ok(())
}
