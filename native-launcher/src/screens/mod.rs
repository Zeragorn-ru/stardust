//! Главный модуль экранов и навигации.

pub mod login;
pub mod main_screen;
pub mod settings;
pub mod title_bar;

use iced::{Element, Task, Theme};

use crate::api::Profile;

/// Доступные экраны.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Screen {
    Login,
    Main,
    Settings,
}

/// Главное состояние приложения.
pub struct App {
    pub screen: Screen,
    pub profile: Option<Profile>,
    pub theme: Theme,
    pub login: login::State,
    pub main: main_screen::State,
    pub settings: settings::State,
    pub exit: bool,
}

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum Message {
    NavigateTo(Screen),
    Login(login::Message),
    Main(main_screen::Message),
    Settings(settings::Message),
    ProfileLoaded(Profile),
    ThemeChanged(Theme),
    CloseRequested,
}

impl App {
    pub fn new() -> (Self, Task<Message>) {
        let app = App {
            screen: Screen::Login,
            profile: None,
            theme: Theme::Dark,
            login: login::State::new(),
            main: main_screen::State::new(),
            settings: settings::State::new(),
            exit: false,
        };
        (app, Task::none())
    }
}

pub fn update(state: &mut App, message: Message) -> Task<Message> {
    match message {
        Message::NavigateTo(screen) => {
            state.screen = screen;
            Task::none()
        }
        Message::Login(msg) => {
            let task = state.login.update(msg.clone());
            if let login::Message::LoginSuccess(profile) = msg {
                state.profile = Some(profile);
                state.screen = Screen::Main;
            }
            task.map(Message::Login)
        }
        Message::Main(msg) => {
            let task = state.main.update(msg.clone());
            match msg {
                main_screen::Message::OpenSettings => {
                    state.screen = Screen::Settings;
                }
                main_screen::Message::Logout => {
                    state.profile = None;
                    state.screen = Screen::Login;
                }
                _ => {}
            }
            task.map(Message::Main)
        }
        Message::Settings(msg) => {
            let task = state.settings.update(msg.clone());
            if let settings::Message::Close = msg {
                state.screen = Screen::Main;
            }
            task.map(Message::Settings)
        }
        Message::ProfileLoaded(profile) => {
            state.profile = Some(profile);
            state.screen = Screen::Main;
            Task::none()
        }
        Message::ThemeChanged(theme) => {
            state.theme = theme;
            Task::none()
        }
        Message::CloseRequested => {
            state.exit = true;
            iced::exit()
        }
    }
}

pub fn view(state: &App) -> Element<'_, Message> {
    let content = match state.screen {
        Screen::Login => state.login.view().map(Message::Login),
        Screen::Main => state.main.view().map(Message::Main),
        Screen::Settings => state.settings.view().map(Message::Settings),
    };

    iced::widget::column![
        title_bar::view(state.screen, state.profile.as_ref()),
        content,
    ]
    .into()
}
