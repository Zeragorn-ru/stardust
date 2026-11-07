//! Отмена конкретной подготовки игры, в том числе до начала обработки play_game.
use std::sync::{atomic::{AtomicBool, Ordering}, Mutex};

static CANCELLED: AtomicBool = AtomicBool::new(false);
static IDS: Mutex<(Option<String>, Vec<String>)> = Mutex::new((None, Vec::new()));

pub fn begin(id: &str) {
    let mut ids = IDS.lock().unwrap();
    let cancelled = ids.1.iter().any(|pending| pending == id);
    ids.1.retain(|pending| pending != id);
    ids.0 = Some(id.to_owned());
    CANCELLED.store(cancelled, Ordering::SeqCst);
}

pub fn request(id: &str) {
    let mut ids = IDS.lock().unwrap();
    if ids.0.as_deref() == Some(id) {
        CANCELLED.store(true, Ordering::SeqCst);
    } else {
        // Вызов stop_game может прийти раньше play_game.
        if ids.1.len() >= 32 { ids.1.remove(0); }
        ids.1.push(id.to_owned());
    }
}

pub fn check() -> Result<(), String> {
    if CANCELLED.load(Ordering::SeqCst) { Err("Запуск отменён".into()) } else { Ok(()) }
}
