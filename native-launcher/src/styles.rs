//! Стили для Iced виджетов — 1:1 с Tauri React UI.

#![allow(dead_code)]

use iced::{border, Color};

/// Цвета приложения (из CSS переменных Tauri).
pub struct Colors;

impl Colors {
    // ─── Фон ──────────────────────────────────────
    pub const BG: Color = Color::from_rgb(0.04, 0.043, 0.078);
    pub const BG_DEEP: Color = Color::from_rgb(0.027, 0.031, 0.059);

    // ─── Стекло ───────────────────────────────────
    pub const GLASS: Color = Color::from_rgba(0.086, 0.098, 0.157, 0.55);
    pub const GLASS_STRONG: Color = Color::from_rgba(0.11, 0.125, 0.204, 0.72);
    pub const GLASS_BORDER: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.08);
    pub const GLASS_BORDER_STRONG: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.14);

    // ─── Текст ────────────────────────────────────
    pub const TEXT: Color = Color::from_rgb(0.933, 0.941, 0.965);
    pub const MUTED: Color = Color::from_rgb(0.604, 0.627, 0.71);
    pub const TEXT_DIM: Color = Color::from_rgb(0.42, 0.44, 0.537);

    // ─── Акцент ───────────────────────────────────
    pub const ACCENT: Color = Color::from_rgb(0.486, 0.361, 1.0);
    pub const ACCENT_2: Color = Color::from_rgb(0.31, 0.545, 1.0);
    pub const TEAL: Color = Color::from_rgb(0.36, 0.72, 0.66);

    // ─── Play ─────────────────────────────────────
    pub const PLAY: Color = Color::from_rgb(0.204, 0.827, 0.6);
    pub const PLAY_2: Color = Color::from_rgb(0.063, 0.725, 0.506);

    // ─── Danger ───────────────────────────────────
    pub const DANGER: Color = Color::from_rgb(1.0, 0.42, 0.42);
}

/// Accent gradient helper
pub fn accent_gradient(angle_deg: f32) -> iced::gradient::Gradient {
    iced::gradient::Linear::new(iced::Degrees(angle_deg))
        .add_stop(0.0, Colors::ACCENT)
        .add_stop(1.0, Colors::ACCENT_2)
        .into()
}

/// Play gradient helper
pub fn play_gradient(angle_deg: f32) -> iced::gradient::Gradient {
    iced::gradient::Linear::new(iced::Degrees(angle_deg))
        .add_stop(0.0, Colors::PLAY)
        .add_stop(1.0, Colors::PLAY_2)
        .into()
}

/// Glass border стиль (16px radius).
pub fn glass_border() -> border::Border {
    border::rounded(16).color(Colors::GLASS_BORDER).width(1)
}

/// Glass card стиль.
pub fn glass_card(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Colors::GLASS)),
        border: glass_border(),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// Primary button стиль (градиент accent).
pub fn btn_primary(_theme: &iced::Theme, _status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Gradient(accent_gradient(135.0))),
        text_color: Colors::TEXT,
        border: border::rounded(11).width(1).color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}

/// Ghost button стиль.
pub fn btn_ghost(_theme: &iced::Theme, _status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Color::from_rgba(1.0, 1.0, 1.0, 0.06))),
        text_color: Colors::TEXT,
        border: border::rounded(11).width(1).color(Colors::GLASS_BORDER),
        shadow: iced::Shadow::default(),
    }
}

/// Play button стиль (градиент green).
pub fn btn_play(_theme: &iced::Theme, _status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Gradient(play_gradient(135.0))),
        text_color: Colors::TEXT,
        border: border::rounded(11).width(1).color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}

/// Window button hover стиль.
pub fn window_btn_hover(_theme: &iced::Theme, _status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Color::from_rgba(1.0, 1.0, 1.0, 0.08))),
        text_color: Colors::TEXT,
        border: border::rounded(8).width(1).color(Colors::GLASS_BORDER),
        shadow: iced::Shadow::default(),
    }
}

/// Close button hover стиль.
pub fn close_btn_hover(_theme: &iced::Theme, _status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Color::from_rgba(1.0, 0.42, 0.42, 0.18))),
        text_color: Colors::TEXT,
        border: border::rounded(8).width(1).color(Color::from_rgba(1.0, 0.42, 0.42, 0.28)),
        shadow: iced::Shadow::default(),
    }
}

/// Tab button стиль (active).
pub fn tab_active(_theme: &iced::Theme, _status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Gradient(accent_gradient(135.0))),
        text_color: Colors::TEXT,
        border: border::rounded(8).width(0).color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}

/// Tab button стиль (inactive).
pub fn tab_inactive(_theme: &iced::Theme, _status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: None,
        text_color: Colors::MUTED,
        border: border::rounded(8).width(0).color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}

/// Settings nav item стиль.
pub fn nav_item(active: bool) -> impl Fn(&iced::Theme, iced::widget::button::Status) -> iced::widget::button::Style {
    move |_theme, _status| iced::widget::button::Style {
        background: if active {
            Some(iced::Background::Color(Color::from_rgba(0.486, 0.361, 1.0, 0.16)))
        } else {
            None
        },
        text_color: if active { Colors::TEXT } else { Colors::TEXT_DIM },
        border: border::rounded(11).width(0).color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}

/// Input field стиль.
pub fn input_style(_theme: &iced::Theme, _status: iced::widget::text_input::Status) -> iced::widget::text_input::Style {
    iced::widget::text_input::Style {
        background: iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.2)),
        border: border::rounded(8).width(1).color(Colors::GLASS_BORDER),
        icon: Colors::MUTED,
        placeholder: Colors::TEXT_DIM,
        value: Colors::TEXT,
        selection: Color::from_rgba(0.486, 0.361, 1.0, 0.3),
    }
}

/// Input field danger стиль (для удаления аккаунта).
pub fn input_danger_style(_theme: &iced::Theme, _status: iced::widget::text_input::Status) -> iced::widget::text_input::Style {
    iced::widget::text_input::Style {
        background: iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.2)),
        border: border::rounded(8).width(1).color(Color::from_rgba(1.0, 0.42, 0.42, 0.4)),
        icon: Colors::MUTED,
        placeholder: Colors::TEXT_DIM,
        value: Colors::TEXT,
        selection: Color::from_rgba(1.0, 0.42, 0.42, 0.3),
    }
}

/// Danger button стиль (красный градиент).
pub fn btn_danger(_theme: &iced::Theme, _status: iced::widget::button::Status) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Colors::DANGER)),
        text_color: Color::WHITE,
        border: border::rounded(11).width(1).color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}
