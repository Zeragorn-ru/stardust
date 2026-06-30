//! Main screen — hero layout 1:1 с Tauri MainScreen.tsx.

use iced::{
    widget::{button, column, container, row, text},
    Element, Length, Task,
};

use crate::api::{PlayerStats, ServerStatus};
use crate::progress::ProgressSnapshot;
use crate::styles::{self, Colors};

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
        // ─── Header ────────────────────────────────
        let avatar = container(
            text("★").size(18).color(Colors::TEXT),
        )
        .width(42)
        .height(42)
        .style(|_theme: &iced::Theme| iced::widget::container::Style {
            background: Some(iced::Background::Gradient(styles::accent_gradient(135.0))),
            border: iced::border::rounded(11),
            ..Default::default()
        });

        let header_left = row![
            avatar,
            column![
                text("Игрок").size(15).color(Colors::TEXT),
                text("аккаунт").size(12).color(Colors::MUTED),
            ].spacing(2),
        ]
        .spacing(12)
        .align_y(iced::Alignment::Center);

        let settings_btn = button(text("Настройки").size(13))
            .on_press(Message::OpenSettings)
            .padding(iced::Padding::new(8.0).left(14.0).right(14.0))
            .style(styles::btn_ghost);

        let logout_btn = button(text("Выйти").size(13))
            .on_press(Message::Logout)
            .padding(iced::Padding::new(8.0).left(14.0).right(14.0))
            .style(styles::btn_ghost);

        let header = row![
            header_left,
            iced::widget::horizontal_space(),
            settings_btn,
            logout_btn,
        ]
        .spacing(6)
        .align_y(iced::Alignment::Center)
        .padding(iced::Padding::new(0.0).left(18.0).right(18.0).top(12.0).bottom(12.0));

        let header_container = container(header)
            .width(Length::Fill)
            .style(|_theme: &iced::Theme| iced::widget::container::Style {
                background: Some(iced::Background::Color(iced::Color::from_rgba(
                    0.039, 0.043, 0.078, 0.4,
                ))),
                border: iced::border::rounded(0).width(0).color(Colors::GLASS_BORDER),
                ..Default::default()
            });

        // ─── Hero section ─────────────────────────
        let info_row = row![
            self.view_stats_card(),
            self.view_server_card(),
        ].spacing(16);

        let play_section = self.view_play_button();

        // ─── Layout ───────────────────────────────
        let content = column![
            iced::widget::vertical_space().height(18),
            info_row,
            iced::widget::vertical_space().height(16),
            play_section,
        ]
        .spacing(8)
        .padding(iced::Padding::new(0.0).left(22.0).right(22.0).bottom(22.0));

        column![header_container, content].into()
    }

    fn view_stats_card(&self) -> Element<'_, Message> {
        let title = text("Статистика").size(10).color(Colors::MUTED);

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

        let stats_content = column![
            title,
            iced::widget::vertical_space().height(10),
            column![
                text(playtime_text).size(20).color(Colors::TEXT),
                text("в игре").size(11).color(Colors::MUTED),
            ].spacing(2),
            iced::widget::vertical_space().height(10),
            column![
                text(last_launch_text).size(20).color(Colors::TEXT),
                text("последний запуск").size(11).color(Colors::MUTED),
            ].spacing(2),
        ]
        .spacing(4);

        container(stats_content)
            .padding(iced::Padding::new(0.0).left(20.0).right(20.0).top(14.0).bottom(14.0))
            .width(Length::Fill)
            .style(styles::glass_card)
            .into()
    }

    fn view_server_card(&self) -> Element<'_, Message> {
        let title = text("Сервер").size(10).color(Colors::MUTED);

        let (status_text, status_color, players_text) =
            if let Some(ref server) = self.server {
                if server.online {
                    let players = if let (Some(cur), Some(mx)) = (server.players, server.max) {
                        format!("{cur}/{mx}")
                    } else {
                        "—".to_string()
                    };
                    ("Онлайн", Colors::TEAL, players)
                } else {
                    ("Офлайн", Colors::DANGER, "—".to_string())
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
            text(format!(" · {ping}мс")).size(20).color(color)
        });

        let status_row = {
            let mut r = row![text(status_text).size(20).color(status_color)].spacing(4);
            if let Some(pt) = ping_text {
                r = r.push(pt);
            }
            r
        };

        let server_content = column![
            title,
            iced::widget::vertical_space().height(10),
            row![
                column![
                    status_row,
                    text("статус").size(11).color(Colors::MUTED),
                ].spacing(2),
                column![
                    text(players_text).size(20).color(Colors::TEXT),
                    text("игроков").size(11).color(Colors::MUTED),
                ].spacing(2),
            ].spacing(24),
        ]
        .spacing(4);

        container(server_content)
            .padding(iced::Padding::new(0.0).left(20.0).right(20.0).top(14.0).bottom(14.0))
            .width(Length::Fill)
            .style(styles::glass_card)
            .into()
    }

    fn view_play_button(&self) -> Element<'_, Message> {
        if let Some(ref snap) = self.progress {
            let fraction = snap.fraction;
            let pct = (fraction * 100.0) as u32;

            let stage_label = text(snap.stage.clone()).size(11).color(Colors::MUTED);
            let pct_label = text(format!("{pct}%")).size(14).color(Colors::TEXT);

            let label = if !snap.label.is_empty() {
                snap.label.clone()
            } else if !self.status_text.is_empty() {
                self.status_text.clone()
            } else {
                String::new()
            };
            let status = text(label).size(12).color(Colors::MUTED);

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

            let portion = ((fraction * 100.0) as u16).max(1);
            let bar_fill: Element<'_, Message> = container(text(""))
                .width(Length::FillPortion(portion))
                .height(5)
                .style(|_theme: &iced::Theme| iced::widget::container::Style {
                    background: Some(iced::Background::Color(iced::Color::from_rgba(1.0, 1.0, 1.0, 0.7))),
                    border: iced::border::rounded(3),
                    ..Default::default()
                })
                .into();

            let bar: Element<'_, Message> = container(bar_fill)
                .width(Length::Fill)
                .height(5)
                .style(|_theme: &iced::Theme| iced::widget::container::Style {
                    background: Some(iced::Background::Color(iced::Color::from_rgba(0.0, 0.0, 0.0, 0.2))),
                    border: iced::border::rounded(3),
                    ..Default::default()
                })
                .into();

            let inner = column![
                row![stage_label, iced::widget::horizontal_space(), pct_label],
                status,
                info_text,
                bar,
            ]
            .spacing(6);

            container(inner)
                .padding(iced::Padding::new(16.0).left(20.0).right(20.0).top(16.0).bottom(16.0))
                .width(Length::Fill)
                .style(|_theme: &iced::Theme| iced::widget::container::Style {
                    background: Some(iced::Background::Gradient(styles::play_gradient(135.0))),
                    border: iced::border::rounded(11),
                    ..Default::default()
                })
                .into()
        } else {
            let label = if self.busy {
                "Подготовка…"
            } else if !self.status_text.is_empty() {
                self.status_text.as_str()
            } else {
                "Играть"
            };

            button(text(label).size(17).color(Colors::TEXT))
                .on_press_maybe(if self.busy { None } else { Some(Message::Play) })
                .padding(iced::Padding::new(16.0).left(48.0).right(48.0))
                .width(Length::Fill)
                .style(styles::btn_play)
                .into()
        }
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
