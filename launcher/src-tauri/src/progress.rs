//! Единый расчёт общего прогресса подготовки игры.
//!
//! Подготовка состоит из нескольких этапов (Java, клиент, библиотеки, ассеты,
//! NeoForge, моды…). Каждому этапу назначен относительный вес; сумма весов
//! равна 100. Общий прогресс = (вес уже завершённых этапов + вес текущего ×
//! его доля) / 100. Так пользователь видит один честный процент 0..100 вместо
//! «дёргающихся» отдельных полосок на каждый файл.
//!
//! Этапы должны начинаться строго по порядку: при старте этапа N все
//! предыдущие считаются завершёнными — это держит общий прогресс монотонным
//! даже если часть этапов пропущена (например, Java уже скачана).

use std::sync::Mutex;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Этап подготовки игры. Порядок в [`Stage::ORDER`] задаёт последовательность.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    Java,
    Version,
    Client,
    VanillaLibraries,
    Assets,
    NeoForgeInstall,
    NeoForgeLibraries,
    Natives,
    Modpack,
    Launch,
}

impl Stage {
    /// Все этапы по порядку. Сумма весов специально равна 100.
    const ORDER: [Stage; 10] = [
        Stage::Java,
        Stage::Version,
        Stage::Client,
        Stage::VanillaLibraries,
        Stage::Assets,
        Stage::NeoForgeInstall,
        Stage::NeoForgeLibraries,
        Stage::Natives,
        Stage::Modpack,
        Stage::Launch,
    ];

    /// Относительный вес этапа в общем прогрессе.
    fn weight(self) -> f64 {
        match self {
            Stage::Java => 10.0,
            Stage::Version => 1.0,
            Stage::Client => 10.0,
            Stage::VanillaLibraries => 16.0,
            Stage::Assets => 22.0,
            Stage::NeoForgeInstall => 14.0,
            Stage::NeoForgeLibraries => 12.0,
            Stage::Natives => 2.0,
            Stage::Modpack => 11.0,
            Stage::Launch => 2.0,
        }
    }

    fn index(self) -> usize {
        Self::ORDER.iter().position(|s| *s == self).unwrap()
    }
}

/// Как загрузка отражается в прогрессе этапа.
#[derive(Debug, Clone, Copy)]
pub enum DownloadScope {
    /// Загрузка занимает весь этап целиком: показываем байты/скорость/ETA и
    /// двигаем долю этапа по байтам (например, клиентский jar или Java).
    Stage,
    /// Один файл многофайлового этапа: долей этапа управляет счётчик файлов,
    /// а байты лишь копятся для общей скорости.
    Item,
}

/// Payload события `launcher://progress`. `fraction` — общий прогресс 0..1.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProgressPayload {
    phase: String,
    label: String,
    fraction: Option<f64>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    speed_bytes_per_sec: Option<f64>,
    eta_seconds: Option<f64>,
}

struct Inner {
    /// Суммарный вес этапов, завершённых до текущего.
    completed_weight: f64,
    current: Stage,
    /// Доля текущего этапа, 0..1.
    current_fraction: f64,
    phase: String,
    label: String,
    /// Счётчик файлов многофайлового этапа.
    items_total: usize,
    items_done: usize,
    /// Накопитель байтов этапа для расчёта общей скорости.
    bytes_started: Instant,
    bytes_session: u64,
    /// Метаданные текущей загрузки (для подписи скорости/ETA).
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    speed: Option<f64>,
    eta: Option<f64>,
}

const TOTAL_WEIGHT: f64 = 100.0;

/// Общий трекер прогресса. Потокобезопасен: загрузки идут параллельно и
/// сообщают о готовности из разных задач.
pub struct Progress {
    app: AppHandle,
    inner: Mutex<Inner>,
}

impl Progress {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Mutex::new(Inner {
                completed_weight: 0.0,
                current: Stage::Java,
                current_fraction: 0.0,
                phase: "checking".into(),
                label: String::new(),
                items_total: 0,
                items_done: 0,
                bytes_started: Instant::now(),
                bytes_session: 0,
                downloaded_bytes: None,
                total_bytes: None,
                speed: None,
                eta: None,
            }),
        }
    }

    /// Начинает новый этап. Все предыдущие по порядку считаются завершёнными,
    /// внутренние счётчики (файлы/байты/метаданные) сбрасываются.
    pub fn begin(&self, stage: Stage, phase: &str, label: impl Into<String>) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.completed_weight = Stage::ORDER
                .iter()
                .take(stage.index())
                .map(|s| s.weight())
                .sum();
            inner.current = stage;
            inner.current_fraction = 0.0;
            inner.phase = phase.to_string();
            inner.label = label.into();
            inner.items_total = 0;
            inner.items_done = 0;
            inner.bytes_started = Instant::now();
            inner.bytes_session = 0;
            inner.downloaded_bytes = None;
            inner.total_bytes = None;
            inner.speed = None;
            inner.eta = None;
        }
        self.emit();
    }

    /// Меняет фазу/подпись текущего этапа, не трогая счётчики и долю.
    pub fn set_label(&self, phase: &str, label: impl Into<String>) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.phase = phase.to_string();
            inner.label = label.into();
        }
        self.emit();
    }

    /// Явно задаёт долю текущего этапа (0..1).
    pub fn set_stage_fraction(&self, fraction: f64) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.current_fraction = fraction.clamp(0.0, 1.0);
        }
        self.emit();
    }

    /// Объявляет, сколько файлов будет обработано в многофайловом этапе.
    pub fn set_total_items(&self, total: usize) {
        let mut inner = self.inner.lock().unwrap();
        inner.items_total = total;
        inner.items_done = 0;
        if total == 0 {
            inner.current_fraction = 1.0;
        }
    }

    /// Отмечает завершение одного файла многофайлового этапа и обновляет долю.
    pub fn item_done(&self, label: impl Into<String>) {
        {
            let mut inner = self.inner.lock().unwrap();
            inner.items_done += 1;
            if inner.items_total > 0 {
                inner.current_fraction =
                    (inner.items_done as f64 / inner.items_total as f64).clamp(0.0, 1.0);
            }
            inner.label = label.into();
        }
        self.emit();
    }

    /// Копит скачанные байты для расчёта общей скорости многофайлового этапа.
    /// Не эмитит событие сам (чтобы не спамить на каждый чанк) — скорость
    /// попадёт в UI при ближайшем [`Progress::item_done`].
    pub fn add_bytes(&self, n: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.bytes_session += n;
        let elapsed = inner.bytes_started.elapsed().as_secs_f64().max(0.001);
        inner.speed = Some(inner.bytes_session as f64 / elapsed);
        inner.downloaded_bytes = Some(inner.bytes_session);
        inner.total_bytes = None;
        inner.eta = None;
    }

    /// Обновляет прогресс одиночной загрузки, занимающей весь этап: доля этапа
    /// = скачано/всего, плюс показываем байты/скорость/ETA.
    pub fn download_tick(&self, downloaded: u64, total: Option<u64>, started: Instant) {
        {
            let mut inner = self.inner.lock().unwrap();
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            let speed = downloaded as f64 / elapsed;
            if let Some(t) = total {
                inner.current_fraction = (downloaded as f64 / t.max(1) as f64).clamp(0.0, 1.0);
            }
            inner.downloaded_bytes = Some(downloaded);
            inner.total_bytes = total;
            inner.speed = Some(speed);
            inner.eta = total.and_then(|t| {
                if speed > 1.0 && t > downloaded {
                    Some((t - downloaded) as f64 / speed)
                } else {
                    None
                }
            });
        }
        self.emit();
    }

    /// Отправляет строку лога в UI через событие `launcher://log`.
    pub fn log(&self, msg: impl Into<String>) {
        let msg = msg.into();
        eprintln!("[launcher] {msg}");
        let _ = self.app.emit("launcher://log", msg);
    }

    fn emit(&self) {
        let inner = self.inner.lock().unwrap();
        let overall = ((inner.completed_weight + inner.current.weight() * inner.current_fraction)
            / TOTAL_WEIGHT)
            .clamp(0.0, 1.0);
        let _ = self.app.emit(
            "launcher://progress",
            ProgressPayload {
                phase: inner.phase.clone(),
                label: inner.label.clone(),
                fraction: Some(overall),
                downloaded_bytes: inner.downloaded_bytes,
                total_bytes: inner.total_bytes,
                speed_bytes_per_sec: inner.speed,
                eta_seconds: inner.eta,
            },
        );
    }
}
