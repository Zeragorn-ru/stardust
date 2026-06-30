//! Стили для Iced виджетов.

#![allow(dead_code)]

use iced::{border, Color};

/// Цвета приложения.
pub struct Colors;

impl Colors {
    pub const BG: Color = Color::from_rgb(0.05, 0.06, 0.10);
    pub const SURFACE: Color = Color::from_rgb(0.10, 0.11, 0.16);
    pub const GLASS: Color = Color::from_rgb(0.12, 0.13, 0.20);
    pub const ACCENT: Color = Color::from_rgb(0.48, 0.58, 0.96);
    pub const TEAL: Color = Color::from_rgb(0.36, 0.72, 0.66);
    pub const TEXT: Color = Color::from_rgb(0.96, 0.94, 0.93);
    pub const MUTED: Color = Color::from_rgb(0.50, 0.50, 0.56);
    pub const BORDER: Color = Color::from_rgb(0.20, 0.22, 0.30);
    pub const DANGER: Color = Color::from_rgb(0.88, 0.38, 0.38);
}

/// Glass border стиль.
pub fn glass_border() -> border::Border {
    border::rounded(8).color(Colors::BORDER).width(1)
}
