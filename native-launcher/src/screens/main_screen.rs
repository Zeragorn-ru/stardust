//! Main screen — stats, server, play button with progress.

use iced::{
    widget::{button, column, container, row, text},
    Element, Length, Task,
};

use crate::api::{PlayerStats, ServerStatus};
use crate::progress::ProgressSnapshot;
use crate::styles::Colors;

#[derive(Debug, Clone)]
pub enum Message {
    OpenSettings,
    Logout,
    Play,
}

pub struct State {
    pub stats: Option<PlayerStats>,
    pub server: Option<ServerStatus>,
    pub busy: bool,
    pub status_text: String,
    pub progress: Option<ProgressSnapshot>,
}

impl State {
    pub fn new() -> Self {
        Self {
            stats: None,
            server: None,
            busy: false,
            status_text: String::new(),
            progress: None,
        }
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Play => {
                self.busy = true;
                Task::none()
            }
            Message::OpenSettings | Message::Logout => Task::none(),
        }
    }

    pub fn view(&self) -> Element<'_, Message> {
        let stats_title = text("Статистика")
            .size(12)
            .color(Colors::MUTED);

        let (playtime_text, last_launch_text) = if let Some(ref stats) = self.stats {
            let hours = stats.playtime_seconds / 3600;
            let mins = (stats.playtime_seconds % 3600) / 60;
            let playtime = format!("{}ч {}м", hours, mins);
            let last_launch = stats
                .last_launched
                .map(|t| t.format("%d.%m.%Y %H:%M").to_string())
                .unwrap_or_else(|| "—".to_string());
            (playtime, last_launch)
        } else {
            ("—".to_string(), "—".to_string())
        };

        let stats_card = column![
            stats_title,
            row![
                column![
                    text(playtime_text).size(20).color(Colors::TEXT),
                    text("в игре")
                        .size(11)
                        .color(Colors::MUTED),
                ],
                column![
                    text(last_launch_text).size(20).color(Colors::TEXT),
                    text("последний запуск")
                        .size(11)
                        .color(Colors::MUTED),
                ],
            ]
            .spacing(24),
        ]
        .spacing(8)
        .padding(16);

        let server_title = text("Сервер")
            .size(12)
            .color(Colors::MUTED);

        let (status_text, status_color, players_text) =
            if let Some(ref server) = self.server {
                if server.online {
                    let color = Colors::TEAL;
                    let players = if let (Some(cur), Some(mx)) =
                        (server.players, server.max)
                    {
                        format!("{cur}/{mx}")
                    } else {
                        "—".to_string()
                    };
                    ("Онлайн", color, players)
                } else {
                    (
                        "Офлайн",
                        Colors::DANGER,
                        "—".to_string(),
                    )
                }
            } else {
                ("—", Colors::MUTED, "—".to_string())
            };

        let ping_text = self.server.as_ref().and_then(|s| s.ping).map(|ping| {
            let color = if ping < 80 {
                Colors::TEAL
            } else if ping < 200 {
                iced::Color::from_rgb(0.83, 0.66, 0.26)
            } else {
                Colors::DANGER
            };
            text(format!("· {ping}мс")).size(20).color(color)
        });

        let server_card = column![
            server_title,
            row![
                column![
                    {
                        let mut r = row![text(status_text)
                            .size(20)
                            .color(status_color)]
                        .spacing(4);
                        if let Some(pt) = ping_text {
                            r = r.push(pt);
                        }
                        r
                    },
                    text("статус")
                        .size(11)
                        .color(Colors::MUTED),
                ],
                column![
                    text(players_text).size(20).color(Colors::TEXT),
                    text("игроков")
                        .size(11)
                        .color(Colors::MUTED),
                ],
            ]
            .spacing(24),
        ]
        .spacing(8)
        .padding(16);

        // Progress bar
        let progress_section: Element<'_, Message> = if let Some(ref snap) = self.progress {
            let fraction = snap.fraction;
            let pct = (fraction * 100.0) as u32;

            // Stage label
            let stage_label = text(snap.stage.clone())
                .size(11)
                .color(Colors::MUTED);

            // Progress bar fill
            let portion = ((fraction * 100.0) as u16).max(1);
            let bar_fill: Element<'_, Message> = container(text(""))
                .width(Length::FillPortion(portion))
                .height(6)
                .style(|_theme: &iced::Theme| iced::widget::container::Style {
                    background: Some(iced::Background::Color(Colors::ACCENT)),
                    border: iced::border::rounded(3),
                    ..Default::default()
                })
                .into();

            // Progress bar background with fill overlay
            let bar: Element<'_, Message> = container(bar_fill)
                .width(Length::Fill)
                .height(6)
                .style(|_theme: &iced::Theme| iced::widget::container::Style {
                    background: Some(iced::Background::Color(iced::Color::from_rgb(0.16, 0.17, 0.23))),
                    border: iced::border::rounded(3),
                    ..Default::default()
                })
                .into();

            // Status text
            let status = if !snap.label.is_empty() {
                text(&snap.label).size(11).color(Colors::MUTED)
            } else if !self.status_text.is_empty() {
                text(&self.status_text).size(11).color(Colors::MUTED)
            } else {
                text("").size(11)
            };

            // Speed / ETA
            let mut info_parts = Vec::new();
            if let Some(speed) = snap.speed_bytes_per_sec {
                if speed > 0.0 {
                    info_parts.push(format_bytes_per_sec(speed));
                }
            }
            if let Some(eta) = snap.eta_seconds {
                if eta > 0.0 {
                    info_parts.push(format!("ETA {}", format_duration(eta)));
                }
            }
            let info_text = if info_parts.is_empty() {
                text("").size(10)
            } else {
                text(info_parts.join(" · ")).size(10).color(Colors::MUTED)
            };

            column![
                row![
                    stage_label,
                    iced::widget::horizontal_space(),
                    text(format!("{pct}%")).size(11).color(Colors::MUTED),
                ],
                bar,
                status,
                info_text,
            ]
            .spacing(4)
            .into()
        } else {
            let status = if !self.status_text.is_empty() {
                text(&self.status_text)
                    .size(11)
                    .color(iced::Color::from_rgb(0.6, 0.6, 0.7))
            } else {
                text("").size(11)
            };
            status.into()
        };

        let play_btn = if self.busy {
            button(text("Подготовка...").size(16))
                .padding(iced::Padding::new(16.0).left(48.0).right(48.0))
                .width(Length::Fill)
        } else {
            button(text("Играть").size(16))
                .on_press(Message::Play)
                .padding(iced::Padding::new(16.0).left(48.0).right(48.0))
                .width(Length::Fill)
        };

        let settings_btn =
            button(text("⚙ Настройки").size(12)).on_press(Message::OpenSettings);
        let logout_btn = button(text("Выйти").size(12)).on_press(Message::Logout);

        column![
            iced::widget::vertical_space().height(24),
            row![stats_card, server_card].spacing(16),
            iced::widget::vertical_space().height(16),
            progress_section,
            iced::widget::vertical_space().height(12),
            play_btn,
            iced::widget::vertical_space().height(16),
            row![settings_btn, iced::widget::horizontal_space(), logout_btn],
        ]
        .spacing(8)
        .padding(iced::Padding::new(0.0).top(0.0).right(24.0).bottom(24.0).left(24.0))
        .into()
    }
}

fn format_bytes_per_sec(bytes_per_sec: f64) -> String {
    if bytes_per_sec >= 1_048_576.0 {
        format!("{:.1} МБ/с", bytes_per_sec / 1_048_576.0)
    } else if bytes_per_sec >= 1024.0 {
        format!("{:.0} КБ/с", bytes_per_sec / 1024.0)
    } else {
        format!("{:.0} Б/с", bytes_per_sec)
    }
}

fn format_duration(seconds: f64) -> String {
    let secs = seconds as u64;
    if secs < 60 {
        format!("{}с", secs)
    } else if secs < 3600 {
        format!("{}м {}с", secs / 60, secs % 60)
    } else {
        format!("{}ч {}м", secs / 3600, (secs % 3600) / 60)
    }
}
