//! Стили для Iced виджетов — 1:1 с Tauri React UI (styles.css).

use iced::{border, Color};

// ═══════════════════════════════════════════════════════════════
// Цвета (строго из CSS переменных Tauri)
// ═══════════════════════════════════════════════════════════════

pub struct Colors;

impl Colors {
    // ─── Фон ──────────────────────────────────────
    pub const BG: Color = Color::from_rgb(0.04, 0.043, 0.078);         // #0a0b14
    pub const BG_DEEP: Color = Color::from_rgb(0.027, 0.031, 0.059);   // #07080f

    // ─── Стекло ───────────────────────────────────
    pub const GLASS: Color = Color::from_rgba(0.086, 0.098, 0.157, 0.55);
    pub const GLASS_STRONG: Color = Color::from_rgba(0.11, 0.125, 0.204, 0.72);
    pub const GLASS_BORDER: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.08);
    pub const GLASS_BORDER_STRONG: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.14);

    // ─── Текст ────────────────────────────────────
    pub const TEXT: Color = Color::from_rgb(0.933, 0.941, 0.965);       // #eef0f6
    pub const MUTED: Color = Color::from_rgb(0.604, 0.627, 0.71);      // #9aa0b5
    pub const TEXT_DIM: Color = Color::from_rgb(0.42, 0.44, 0.537);    // #6b7089

    // ─── Акцент ───────────────────────────────────
    pub const ACCENT: Color = Color::from_rgb(0.486, 0.361, 1.0);      // #7c5cff
    pub const ACCENT_2: Color = Color::from_rgb(0.31, 0.545, 1.0);     // #4f8cff
    pub const TEAL: Color = Color::from_rgb(0.36, 0.72, 0.66);         // #5cb8a8

    // ─── Play ─────────────────────────────────────
    pub const PLAY: Color = Color::from_rgb(0.204, 0.827, 0.6);        // #34d399
    pub const PLAY_2: Color = Color::from_rgb(0.063, 0.725, 0.506);    // #10b981
    pub const PLAY_HOVER: Color = Color::from_rgb(0.29, 0.87, 0.5);    // #4ade80

    // ─── Danger ───────────────────────────────────
    pub const DANGER: Color = Color::from_rgb(1.0, 0.42, 0.42);        // #ff6b6b

    // ─── Доп. цвета (из Tauri CSS) ───────────────
    pub const GREEN_ONLINE: Color = Color::from_rgb(0.29, 0.87, 0.5);  // #4ade80
    pub const PING_YELLOW: Color = Color::from_rgb(0.83, 0.66, 0.26);  // #d4a843
    pub const PING_RED: Color = Color::from_rgb(0.878, 0.376, 0.376);  // #e06060
    pub const FORM_MSG_OK: Color = Color::from_rgb(0.54, 1.0, 0.69);   // #8affb0
    pub const FORM_MSG_ERR: Color = Color::from_rgb(1.0, 0.54, 0.54);  // #ff8a8a
    pub const PLAY_ERROR: Color = Color::from_rgb(0.973, 0.443, 0.443);// #f87171
    pub const BADGE_OK: Color = Color::from_rgba(0.18, 0.627, 0.263, 0.9); // rgba(46,160,67,0.9)
    pub const BADGE_MUTED_BG: Color = Color::from_rgba(1.0, 1.0, 1.0, 0.16);
    pub const GREEN_SUCCESS: Color = Color::from_rgb(0.54, 1.0, 0.69); // #8affb0

    // ─── Tabs (login) ─────────────────────────────
    pub const TABS_BG: Color = Color::from_rgba(0.0, 0.0, 0.0, 0.28);
}

// ═══════════════════════════════════════════════════════════════
// Градиенты
// ═══════════════════════════════════════════════════════════════

pub fn accent_gradient(angle_deg: f32) -> iced::gradient::Gradient {
    iced::gradient::Linear::new(iced::Degrees(angle_deg))
        .add_stop(0.0, Colors::ACCENT)
        .add_stop(1.0, Colors::ACCENT_2)
        .into()
}

pub fn play_gradient(angle_deg: f32) -> iced::gradient::Gradient {
    iced::gradient::Linear::new(iced::Degrees(angle_deg))
        .add_stop(0.0, Colors::PLAY)
        .add_stop(1.0, Colors::PLAY_2)
        .into()
}

pub fn play_hover_gradient(angle_deg: f32) -> iced::gradient::Gradient {
    iced::gradient::Linear::new(iced::Degrees(angle_deg))
        .add_stop(0.0, Colors::PLAY_HOVER)
        .add_stop(1.0, Colors::PLAY_2)
        .into()
}

// ═══════════════════════════════════════════════════════════════
// Базовые стили
// ═══════════════════════════════════════════════════════════════

/// Glass border (16px radius) — `--glass-border`, `--radius`.
pub fn glass_border() -> border::Border {
    border::rounded(16).color(Colors::GLASS_BORDER).width(1)
}

/// Glass card — `.hero__card`, `.stats-card` фон.
pub fn glass_card(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Colors::GLASS)),
        border: glass_border(),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// Glass card strong — `.modal`, `.info-card`.
pub fn glass_card_strong(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Colors::GLASS_STRONG)),
        border: border::rounded(16)
            .width(1)
            .color(Colors::GLASS_BORDER_STRONG),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

// ═══════════════════════════════════════════════════════════════
// Кнопки
// ═══════════════════════════════════════════════════════════════

/// `.btn--primary` — accent gradient, `--radius-sm: 11px`.
pub fn btn_primary(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Gradient(accent_gradient(135.0))),
        text_color: Colors::TEXT,
        border: border::rounded(11)
            .width(1)
            .color(Color::TRANSPARENT),
        shadow: iced::Shadow {
            color: Color::from_rgba(0.486, 0.361, 1.0, 0.45),
            offset: iced::Vector::new(0.0, 4.0),
            blur_radius: 20.0,
        },
    }
}

/// `.btn--ghost` — `rgba(255,255,255,0.06)` bg, hover `0.12`.
pub fn btn_ghost(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Color::from_rgba(
            1.0, 1.0, 1.0, 0.06,
        ))),
        text_color: Colors::TEXT,
        border: border::rounded(11)
            .width(1)
            .color(Colors::GLASS_BORDER),
        shadow: iced::Shadow::default(),
    }
}

/// `.btn--link` — transparent, muted, underline.
pub fn btn_link(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: None,
        text_color: Colors::MUTED,
        border: border::rounded(0)
            .width(0)
            .color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}

/// `.btn--play` — green gradient, `--radius-sm`.
pub fn btn_play(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Gradient(play_gradient(135.0))),
        text_color: Colors::TEXT,
        border: border::rounded(11)
            .width(1)
            .color(Color::TRANSPARENT),
        shadow: iced::Shadow {
            color: Color::from_rgba(0.063, 0.725, 0.506, 0.7),
            offset: iced::Vector::new(0.0, 6.0),
            blur_radius: 36.0,
        },
    }
}

/// `.btn--danger` (resting) — `rgba(255,107,107,0.12)` bg, danger border.
pub fn btn_danger(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Color::from_rgba(
            1.0, 0.42, 0.42, 0.12,
        ))),
        text_color: Colors::DANGER,
        border: border::rounded(11)
            .width(1)
            .color(Color::from_rgba(1.0, 0.42, 0.42, 0.3)),
        shadow: iced::Shadow::default(),
    }
}

/// `.btn--danger:hover` — solid danger bg.
pub fn btn_danger_hover(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Colors::DANGER)),
        text_color: Color::WHITE,
        border: border::rounded(11)
            .width(1)
            .color(Colors::DANGER),
        shadow: iced::Shadow::default(),
    }
}

/// Title bar window button — `8px radius`, hover bg.
pub fn window_btn_hover(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Color::from_rgba(
            1.0, 1.0, 1.0, 0.08,
        ))),
        text_color: Colors::TEXT,
        border: border::rounded(8)
            .width(1)
            .color(Colors::GLASS_BORDER),
        shadow: iced::Shadow::default(),
    }
}

/// Title bar close button — hover red bg.
pub fn close_btn_hover(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Color(Color::from_rgba(
            1.0, 0.42, 0.42, 0.18,
        ))),
        text_color: Colors::TEXT,
        border: border::rounded(8)
            .width(1)
            .color(Color::from_rgba(1.0, 0.42, 0.42, 0.28)),
        shadow: iced::Shadow::default(),
    }
}

// ═══════════════════════════════════════════════════════════════
// Tabs (login: Вход / Регистрация)
// ═══════════════════════════════════════════════════════════════

/// `.tabs__tab.is-active` — accent gradient, glow shadow.
pub fn tab_active(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: Some(iced::Background::Gradient(accent_gradient(135.0))),
        text_color: Color::WHITE,
        border: border::rounded(8)
            .width(0)
            .color(Color::TRANSPARENT),
        shadow: iced::Shadow {
            color: Color::from_rgba(0.486, 0.361, 1.0, 0.7),
            offset: iced::Vector::new(0.0, 3.0),
            blur_radius: 18.0,
        },
    }
}

/// `.tabs__tab` (inactive) — transparent, muted text.
pub fn tab_inactive(
    _theme: &iced::Theme,
    _status: iced::widget::button::Status,
) -> iced::widget::button::Style {
    iced::widget::button::Style {
        background: None,
        text_color: Colors::MUTED,
        border: border::rounded(8)
            .width(0)
            .color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}

// ═══════════════════════════════════════════════════════════════
// Settings: навигация
// ═══════════════════════════════════════════════════════════════

/// `.settings__nav-item` + `.settings__nav-item--active`.
/// Возвращает (style, show_indicator) — indicator рисуется отдельно.
pub fn nav_item(
    active: bool,
) -> impl Fn(&iced::Theme, iced::widget::button::Status) -> iced::widget::button::Style {
    move |_theme, _status| iced::widget::button::Style {
        background: if active {
            Some(iced::Background::Color(Color::from_rgba(0.486, 0.361, 1.0, 0.16)))
        } else {
            None
        },
        text_color: if active { Colors::TEXT } else { Colors::TEXT_DIM },
        border: border::rounded(11)
            .width(0)
            .color(Color::TRANSPARENT),
        shadow: iced::Shadow::default(),
    }
}

/// Цвет индикатора `.settings__nav-item::before` — accent gradient.
pub fn nav_indicator_color() -> iced::gradient::Gradient {
    accent_gradient(135.0)
}

// ═══════════════════════════════════════════════════════════════
// Input
// ═══════════════════════════════════════════════════════════════

/// `.input` — `rgba(0,0,0,0.25)` bg, glass border, `--radius-sm`.
pub fn input_style(
    _theme: &iced::Theme,
    _status: iced::widget::text_input::Status,
) -> iced::widget::text_input::Style {
    iced::widget::text_input::Style {
        background: iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.25)),
        border: border::rounded(11)
            .width(1)
            .color(Colors::GLASS_BORDER),
        icon: Colors::MUTED,
        placeholder: Colors::TEXT_DIM,
        value: Colors::TEXT,
        selection: Color::from_rgba(0.486, 0.361, 1.0, 0.3),
    }
}

/// `.input:focus` — accent border + glow.
pub fn input_focus(
    _theme: &iced::Theme,
    _status: iced::widget::text_input::Status,
) -> iced::widget::text_input::Style {
    iced::widget::text_input::Style {
        background: iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.25)),
        border: border::rounded(11)
            .width(1)
            .color(Colors::ACCENT),
        icon: Colors::MUTED,
        placeholder: Colors::TEXT_DIM,
        value: Colors::TEXT,
        selection: Color::from_rgba(0.486, 0.361, 1.0, 0.3),
    }
}

/// Danger input (delete account confirmation).
pub fn input_danger_style(
    _theme: &iced::Theme,
    _status: iced::widget::text_input::Status,
) -> iced::widget::text_input::Style {
    iced::widget::text_input::Style {
        background: iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.25)),
        border: border::rounded(11)
            .width(1)
            .color(Color::from_rgba(1.0, 0.42, 0.42, 0.4)),
        icon: Colors::MUTED,
        placeholder: Colors::TEXT_DIM,
        value: Colors::TEXT,
        selection: Color::from_rgba(1.0, 0.42, 0.42, 0.3),
    }
}

// ═══════════════════════════════════════════════════════════════
// Компоненты: badge, toggle-row, form-msg, tg-code, account-form
// ═══════════════════════════════════════════════════════════════

/// `.badge` — pill, accent gradient bg.
pub fn badge_style(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Gradient(accent_gradient(135.0))),
        border: border::rounded(99).width(0).color(Color::TRANSPARENT),
        text_color: Some(Color::WHITE),
        ..Default::default()
    }
}

/// `.badge--ok` — green bg.
pub fn badge_ok(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Colors::BADGE_OK)),
        border: border::rounded(99).width(0).color(Color::TRANSPARENT),
        text_color: Some(Color::WHITE),
        ..Default::default()
    }
}

/// `.badge--muted` — `rgba(255,255,255,0.16)` bg.
pub fn badge_muted(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Colors::BADGE_MUTED_BG)),
        border: border::rounded(99).width(0).color(Color::TRANSPARENT),
        text_color: Some(Color::from_rgba(1.0, 1.0, 1.0, 0.7)),
        ..Default::default()
    }
}

/// `.toggle-row` wrapper — glass bg, `--radius-sm`, padding.
pub fn toggle_row_bg(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Colors::GLASS)),
        border: border::rounded(11)
            .width(1)
            .color(Colors::GLASS_BORDER),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// `.form-msg--error` — `#ff8a8a`.
pub fn form_msg_error() -> Color {
    Colors::FORM_MSG_ERR
}

/// `.form-msg--ok` — `#8affb0`.
pub fn form_msg_ok() -> Color {
    Colors::FORM_MSG_OK
}

/// `.tg-code` — monospace, dark bg, glass border.
pub fn tg_code_bg(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.3))),
        border: border::rounded(11)
            .width(1)
            .color(Colors::GLASS_BORDER),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// `.account-form` — `rgba(0,0,0,0.22)` bg, glass border, padding.
pub fn account_form_bg(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.22))),
        border: border::rounded(11)
            .width(1)
            .color(Colors::GLASS_BORDER),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// `.account-form--danger` — danger-tinted bg.
pub fn account_form_danger(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(1.0, 0.42, 0.42, 0.04))),
        border: border::rounded(11)
            .width(1)
            .color(Color::from_rgba(1.0, 0.42, 0.42, 0.15)),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// `.alert--error` — `rgba(255,107,107,0.12)` bg, danger border.
pub fn alert_error(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(
            1.0, 0.42, 0.42, 0.12,
        ))),
        border: border::rounded(11)
            .width(1)
            .color(Color::from_rgba(1.0, 0.42, 0.42, 0.3)),
        text_color: Some(Colors::FORM_MSG_ERR),
        ..Default::default()
    }
}

/// `.info-card` — dark bg, glass border, for data display rows.
pub fn info_card(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.22))),
        border: border::rounded(11)
            .width(1)
            .color(Colors::GLASS_BORDER),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// Settings header bg — `rgba(10,11,20,0.4)`, glass border bottom.
pub fn settings_header_bg(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(
            0.039, 0.043, 0.078, 0.4,
        ))),
        border: border::rounded(0)
            .width(1)
            .color(Colors::GLASS_BORDER),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// Settings sidebar bg — `rgba(10,11,20,0.25)`.
pub fn settings_sidebar_bg(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(
            0.039, 0.043, 0.078, 0.25,
        ))),
        border: border::rounded(0)
            .width(0)
            .color(Colors::GLASS_BORDER),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

/// Main screen header bg — `rgba(10,11,20,0.4)`.
pub fn main_header_bg(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(
            0.039, 0.043, 0.078, 0.4,
        ))),
        border: border::rounded(0)
            .width(0)
            .color(Colors::GLASS_BORDER),
        text_color: Some(Colors::TEXT),
        ..Default::default()
    }
}

// ═══════════════════════════════════════════════════════════════
// Progress bar
// ═══════════════════════════════════════════════════════════════

/// `.progress__track` — `rgba(0,0,0,0.35)`, 8px height, 4px radius.
pub fn progress_track(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.35))),
        border: border::rounded(4).width(0).color(Color::TRANSPARENT),
        ..Default::default()
    }
}

/// `.progress__bar` — accent gradient fill.
pub fn progress_bar(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Gradient(accent_gradient(90.0))),
        border: border::rounded(4).width(0).color(Color::TRANSPARENT),
        ..Default::default()
    }
}

/// `.play-button__bar` — `rgba(255,255,255,0.7)` with glow.
pub fn play_bar_fill(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(1.0, 1.0, 1.0, 0.7))),
        border: border::rounded(3).width(0).color(Color::TRANSPARENT),
        ..Default::default()
    }
}

/// `.play-button__track` — `rgba(0,0,0,0.2)`.
pub fn play_bar_track(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Color(Color::from_rgba(0.0, 0.0, 0.0, 0.2))),
        border: border::rounded(3).width(0).color(Color::TRANSPARENT),
        ..Default::default()
    }
}

/// Play button progress container — green gradient bg.
pub fn play_progress_bg(_theme: &iced::Theme) -> iced::widget::container::Style {
    iced::widget::container::Style {
        background: Some(iced::Background::Gradient(play_gradient(135.0))),
        border: border::rounded(11).width(0).color(Color::TRANSPARENT),
        ..Default::default()
    }
}
