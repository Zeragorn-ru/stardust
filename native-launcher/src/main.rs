//! StarDust Launcher — нативная версия на Iced.
//!
//! Без WebView2, чистый Rust, нативный рендеринг.

#[allow(dead_code)]
mod api;
#[allow(dead_code)]
mod paths;
mod screens;
#[allow(dead_code)]
mod styles;

use screens::App;

fn main() -> iced::Result {
    iced::application("StarDust Launcher", screens::update, screens::view)
        .theme(|state: &App| state.theme.clone())
        .window_size((900.0, 620.0))
        .run_with(App::new)
}
