//! Кастомный title bar (без декораций окна).

use iced::{
    widget::{button, row, text},
    Element,
};

use super::{PlayerProfile, Screen};

pub fn view(screen: Screen, profile: Option<&PlayerProfile>) -> Element<'_, super::Message> {
    let title = match screen {
        Screen::Login => "StarDust — Вход",
        Screen::Main => "StarDust — Главная",
        Screen::Settings => "StarDust — Настройки",
    };

    let username = profile.map(|p| p.name.as_str()).unwrap_or("");

    row![
        text("★")
            .size(16)
            .color(iced::Color::from_rgb(0.48, 0.58, 0.96)),
        text(" StarDust").size(14).color(iced::Color::WHITE),
        text("  ").size(14),
        text(title)
            .size(12)
            .color(iced::Color::from_rgb(0.6, 0.6, 0.7)),
        iced::widget::horizontal_space(),
        if !username.is_empty() {
            text(username)
                .size(11)
                .color(iced::Color::from_rgb(0.5, 0.5, 0.6))
        } else {
            text("").size(11)
        },
        button(text("─").size(12)).on_press(super::Message::NavigateTo(screen)),
        button(text("✕").size(12)).on_press(super::Message::CloseRequested),
    ]
    .spacing(8)
    .align_y(iced::Alignment::Center)
    .padding(iced::Padding::from([8, 16]))
    .into()
}
