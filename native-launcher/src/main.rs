//! StarDust Launcher — native version on Iced.
//!
//! No WebView2, pure Rust, native rendering.

#![allow(dead_code)]

mod api;
mod game_guard;
mod minecraft;
mod modpack;
mod paths;
mod progress;
mod screens;
mod styles;
mod updater;

use screens::App;

fn main() -> iced::Result {
    iced::application("StarDust Launcher", screens::update, screens::view)
        .theme(|state: &App| state.theme.clone())
        .window_size((900.0, 620.0))
        .run_with(App::new)
}
