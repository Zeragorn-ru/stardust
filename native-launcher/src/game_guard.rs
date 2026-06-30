//! Cross-process game guard: PID tracking + session persistence.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

const PID_FILE: &str = "game.pid";
const SESSION_FILE: &str = "game_session.json";
const PENDING_SESSIONS_FILE: &str = "pending-sessions.json";

#[derive(Debug, Serialize, Deserialize)]
pub struct PendingSession {
    pub launched_at: String,
    pub pid: u32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct PendingSessionRecord {
    pub token: String,
    pub duration: i64,
    pub launched_at: String,
}

pub fn write_session(data_dir: &Path, pid: u32, launched_at: &str) {
    let s = PendingSession {
        launched_at: launched_at.to_owned(),
        pid,
    };
    if let Ok(json) = serde_json::to_string(&s) {
        let _ = std::fs::write(data_dir.join(SESSION_FILE), json);
    }
}

pub fn read_session(data_dir: &Path) -> Option<PendingSession> {
    let s = std::fs::read_to_string(data_dir.join(SESSION_FILE)).ok()?;
    serde_json::from_str(&s).ok()
}

pub fn clear_session(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join(SESSION_FILE));
}

fn pid_path(data_dir: &Path) -> PathBuf {
    data_dir.join(PID_FILE)
}

pub fn is_running(data_dir: &Path) -> bool {
    let path = pid_path(data_dir);
    let Some(pid) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
    else {
        let _ = std::fs::remove_file(&path);
        return false;
    };
    if process_alive(pid) {
        true
    } else {
        let _ = std::fs::remove_file(&path);
        false
    }
}

pub fn record(data_dir: &Path, pid: u32) {
    let _ = std::fs::write(pid_path(data_dir), pid.to_string());
}

pub fn clear(data_dir: &Path) {
    let _ = std::fs::remove_file(pid_path(data_dir));
}

/// Recover pending session: if game was running when launcher closed,
/// calculate duration and queue for recording.
pub fn recover_pending_session(data_dir: &Path) -> Option<(i64, String)> {
    let pending = read_session(data_dir)?;
    clear_session(data_dir);

    if !process_alive(pending.pid) {
        let launched_at = chrono::DateTime::parse_from_rfc3339(&pending.launched_at)
            .ok()?;
        let duration = chrono::Utc::now()
            .signed_duration_since(laid_to_chrono(&launched_at))
            .num_seconds();
        if duration > 0 {
            return Some((duration, pending.launched_at));
        }
    }
    None
}

fn laid_to_chrono(dt: &chrono::DateTime<chrono::FixedOffset>) -> chrono::DateTime<chrono::Utc> {
    dt.with_timezone(&chrono::Utc)
}

pub fn drain_pending_sessions(data_dir: &Path) -> Vec<PendingSessionRecord> {
    let path = data_dir.join(PENDING_SESSIONS_FILE);
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let sessions: Vec<PendingSessionRecord> =
        serde_json::from_str(&content).unwrap_or_default();
    let _ = std::fs::remove_file(&path);
    sessions
}

pub fn queue_pending_session(data_dir: &Path, record: PendingSessionRecord) {
    let path = data_dir.join(PENDING_SESSIONS_FILE);
    let mut sessions: Vec<PendingSessionRecord> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|c| serde_json::from_str(&c).ok())
        .unwrap_or_default();
    sessions.push(record);
    let _ = std::fs::write(
        &path,
        serde_json::to_string_pretty(&sessions).unwrap_or_default(),
    );
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    let ret = unsafe { libc::kill(pid as libc::pid_t, 0) };
    if ret == 0 {
        return true;
    }
    std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{
        OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE,
    };

    let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let wait = unsafe { WaitForSingleObject(handle, 0) };
    unsafe { CloseHandle(handle) };
    wait == WAIT_TIMEOUT
}

#[cfg(not(any(unix, windows)))]
fn process_alive(_pid: u32) -> bool {
    false
}
