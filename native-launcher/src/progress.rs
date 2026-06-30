//! Multi-stage weighted progress tracker.
//!
//! Each stage has a weight; total = 100. Overall progress = sum of completed
//! weights + current weight * current fraction.

use std::sync::Mutex;
use std::time::Instant;

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

    pub fn label(self) -> &'static str {
        match self {
            Stage::Java => "Java",
            Stage::Version => "Версия",
            Stage::Client => "Клиент",
            Stage::VanillaLibraries => "Библиотеки",
            Stage::Assets => "Ресурсы",
            Stage::NeoForgeInstall => "NeoForge",
            Stage::NeoForgeLibraries => "Библиотеки NF",
            Stage::Natives => "Natives",
            Stage::Modpack => "Модпак",
            Stage::Launch => "Запуск",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub enum DownloadScope {
    Stage,
    Item,
}

#[derive(Debug, Clone)]
pub struct ProgressSnapshot {
    pub phase: String,
    pub label: String,
    pub fraction: f64,
    pub stage: String,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub speed_bytes_per_sec: Option<f64>,
    pub eta_seconds: Option<f64>,
}

struct Inner {
    completed_weight: f64,
    current: Stage,
    current_fraction: f64,
    phase: String,
    label: String,
    items_total: usize,
    items_done: usize,
    bytes_started: Instant,
    bytes_session: u64,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
    speed: Option<f64>,
    eta: Option<f64>,
}

const TOTAL_WEIGHT: f64 = 100.0;

pub struct Progress {
    inner: Mutex<Inner>,
}

impl Progress {
    pub fn new() -> Self {
        Self {
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
    }

    pub fn set_label(&self, phase: &str, label: impl Into<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.phase = phase.to_string();
        inner.label = label.into();
    }

    pub fn set_stage_fraction(&self, fraction: f64) {
        let mut inner = self.inner.lock().unwrap();
        inner.current_fraction = fraction.clamp(0.0, 1.0);
    }

    pub fn set_total_items(&self, total: usize) {
        let mut inner = self.inner.lock().unwrap();
        inner.items_total = total;
        inner.items_done = 0;
        if total == 0 {
            inner.current_fraction = 1.0;
        }
    }

    pub fn item_done(&self, label: impl Into<String>) {
        let mut inner = self.inner.lock().unwrap();
        inner.items_done += 1;
        if inner.items_total > 0 {
            inner.current_fraction =
                (inner.items_done as f64 / inner.items_total as f64).clamp(0.0, 1.0);
        }
        inner.label = label.into();
    }

    pub fn add_bytes(&self, n: u64) {
        let mut inner = self.inner.lock().unwrap();
        inner.bytes_session += n;
        let elapsed = inner.bytes_started.elapsed().as_secs_f64().max(0.001);
        inner.speed = Some(inner.bytes_session as f64 / elapsed);
        inner.downloaded_bytes = Some(inner.bytes_session);
        inner.total_bytes = None;
        inner.eta = None;
    }

    pub fn download_tick(&self, downloaded: u64, total: Option<u64>, started: Instant) {
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

    pub fn snapshot(&self) -> ProgressSnapshot {
        let inner = self.inner.lock().unwrap();
        let overall = ((inner.completed_weight + inner.current.weight() * inner.current_fraction)
            / TOTAL_WEIGHT)
            .clamp(0.0, 1.0);
        ProgressSnapshot {
            phase: inner.phase.clone(),
            label: inner.label.clone(),
            fraction: overall,
            stage: inner.current.label().to_string(),
            downloaded_bytes: inner.downloaded_bytes,
            total_bytes: inner.total_bytes,
            speed_bytes_per_sec: inner.speed,
            eta_seconds: inner.eta,
        }
    }
}

impl Default for Progress {
    fn default() -> Self {
        Self::new()
    }
}
