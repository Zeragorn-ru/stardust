//! StarDust Launcher — native version on Iced.
//!
//! No WebView2, pure Rust, native rendering.

#![allow(dead_code)]
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

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
        .window(iced::window::Settings {
            size: iced::Size::new(920.0, 600.0),
            min_size: Some(iced::Size::new(860.0, 560.0)),
            decorations: false,
            resizable: false,
            ..Default::default()
        })
        .run_with(App::new)
}
