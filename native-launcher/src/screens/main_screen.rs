//! Главный экран — статистика, сервер, кнопка «Играть»。

use iced::{
    widget::{button, column, row, text},
    Element, Length, Task,
};

use crate::api::{PlayerStats, ServerStatus};

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
}

impl State {
    pub fn new() -> Self {
        Self {
            stats: None,
            server: None,
            busy: false,
            status_text: String::new(),
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
            .color(iced::Color::from_rgb(0.5, 0.5, 0.6));

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
                    text(playtime_text).size(20).color(iced::Color::WHITE),
                    text("в игре")
                        .size(11)
                        .color(iced::Color::from_rgb(0.5, 0.5, 0.6)),
                ],
                column![
                    text(last_launch_text).size(20).color(iced::Color::WHITE),
                    text("последний запуск")
                        .size(11)
                        .color(iced::Color::from_rgb(0.5, 0.5, 0.6)),
                ],
            ]
            .spacing(24),
        ]
        .spacing(8)
        .padding(16);

        let server_title = text("Сервер")
            .size(12)
            .color(iced::Color::from_rgb(0.5, 0.5, 0.6));

        let (status_text, status_color, players_text) =
            if let Some(ref server) = self.server {
                if server.online {
                    let color = iced::Color::from_rgb(0.36, 0.72, 0.66);
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
                        iced::Color::from_rgb(0.6, 0.3, 0.3),
                        "—".to_string(),
                    )
                }
            } else {
                ("—", iced::Color::from_rgb(0.5, 0.5, 0.6), "—".to_string())
            };

        let ping_text = self.server.as_ref().and_then(|s| s.ping).map(|ping| {
            let color = if ping < 80 {
                iced::Color::from_rgb(0.36, 0.72, 0.66)
            } else if ping < 200 {
                iced::Color::from_rgb(0.83, 0.66, 0.26)
            } else {
                iced::Color::from_rgb(0.88, 0.38, 0.38)
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
                        .color(iced::Color::from_rgb(0.5, 0.5, 0.6)),
                ],
                column![
                    text(players_text).size(20).color(iced::Color::WHITE),
                    text("игроков")
                        .size(11)
                        .color(iced::Color::from_rgb(0.5, 0.5, 0.6)),
                ],
            ]
            .spacing(24),
        ]
        .spacing(8)
        .padding(16);

        let status_line = if !self.status_text.is_empty() {
            text(&self.status_text)
                .size(11)
                .color(iced::Color::from_rgb(0.6, 0.6, 0.7))
        } else {
            text("").size(11)
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
            status_line,
            play_btn,
            iced::widget::vertical_space().height(16),
            row![settings_btn, iced::widget::horizontal_space(), logout_btn],
        ]
        .spacing(8)
        .padding(iced::Padding::new(0.0).top(0.0).right(24.0).bottom(24.0).left(24.0))
        .into()
    }
}
