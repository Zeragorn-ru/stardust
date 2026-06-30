//! Кастомный title bar (без декораций окна).

use iced::{
    widget::{button, container, row, text},
    Element, Length,
};

use crate::styles::{self, Colors};

use super::{PlayerProfile, Screen};

pub fn view(screen: Screen, profile: Option<&PlayerProfile>) -> Element<'_, super::Message> {
    let title = match screen {
        Screen::Login => "StarDust — Вход",
        Screen::Main => "StarDust — Главная",
        Screen::Settings => "StarDust — Настройки",
    };

    let username = profile.map(|p| p.name.as_str()).unwrap_or("");

    // ─── Brand ──────────────────────────────────────
    let mark = container(text(""))
        .width(10)
        .height(10)
        .style(|_theme: &iced::Theme| iced::widget::container::Style {
            background: Some(iced::Background::Gradient(styles::accent_gradient(135.0))),
            border: iced::border::rounded(999),
            ..Default::default()
        });

    let brand = row![
        mark,
        text("  StarDust").size(12).color(Colors::TEXT),
    ]
    .spacing(9)
    .align_y(iced::Alignment::Center);

    let title_text = text(title).size(12).color(Colors::MUTED);

    // ─── Username ───────────────────────────────────
    let username_elem: Element<'_, super::Message> = if !username.is_empty() {
        text(username)
            .size(12)
            .color(Colors::TEXT_DIM)
            .into()
    } else {
        text("").into()
    };

    // ─── Window buttons ─────────────────────────────
    let minimize_btn = button(
        text("─").size(11).color(Colors::TEXT),
    )
    .on_press(super::Message::Minimize)
    .padding(iced::Padding::new(0.0).left(6.0).right(6.0).top(4.0).bottom(4.0))
    .style(styles::window_btn_hover);

    let close_btn = button(
        text("×").size(14).color(Colors::TEXT),
    )
    .on_press(super::Message::CloseRequested)
    .padding(iced::Padding::new(0.0).left(6.0).right(6.0).top(2.0).bottom(2.0))
    .style(styles::close_btn_hover);

    let actions = row![minimize_btn, close_btn].spacing(6);

    // ─── Title bar layout ───────────────────────────
    let title_bar_content = row![
        brand,
        text("  ").size(12),
        title_text,
        iced::widget::horizontal_space(),
        username_elem,
        iced::widget::horizontal_space().width(8),
        actions,
    ]
    .spacing(8)
    .align_y(iced::Alignment::Center)
    .padding(iced::Padding::new(0.0).left(14.0).right(8.0).top(6.0).bottom(6.0));

    // Use a button wrapper for drag support
    button(title_bar_content)
        .on_press(super::Message::DragWindow)
        .width(Length::Fill)
        .height(38)
        .style(|_theme: &iced::Theme, _status: iced::widget::button::Status| {
            iced::widget::button::Style {
                background: Some(iced::Background::Color(iced::Color::from_rgba(
                    0.031, 0.035, 0.063, 0.58,
                ))),
                border: iced::border::rounded(0).width(0).color(Colors::GLASS_BORDER),
                text_color: Colors::TEXT,
                shadow: iced::Shadow::default(),
            }
        })
        .into()
}
