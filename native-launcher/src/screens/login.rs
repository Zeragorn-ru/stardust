//! Экран входа。

use iced::{
    widget::{button, column, container, text, text_input},
    Element, Length, Task,
};

use crate::api::{self, Profile};

#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum Message {
    UsernameChanged(String),
    PasswordChanged(String),
    ToggleRegister,
    Submit,
    LoginSuccess(Profile),
    Error(String),
    ClearError,
}

pub struct State {
    pub username: String,
    pub password: String,
    pub is_register: bool,
    pub busy: bool,
    pub error: Option<String>,
}

impl State {
    pub fn new() -> Self {
        Self {
            username: String::new(),
            password: String::new(),
            is_register: false,
            busy: false,
            error: None,
        }
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::UsernameChanged(v) => {
                self.username = v;
                Task::none()
            }
            Message::PasswordChanged(v) => {
                self.password = v;
                Task::none()
            }
            Message::ToggleRegister => {
                self.is_register = !self.is_register;
                self.error = None;
                Task::none()
            }
            Message::Submit => {
                self.busy = true;
                self.error = None;
                let username = self.username.clone();
                let password = self.password.clone();
                let is_register = self.is_register;
                Task::perform(
                    async move {
                        if is_register {
                            api::register(&username, &password).await
                        } else {
                            api::login(&username, &password).await
                        }
                    },
                    |result| match result {
                        Ok(profile) => Message::LoginSuccess(profile),
                        Err(e) => Message::Error(e),
                    },
                )
            }
            Message::LoginSuccess(_) => {
                self.busy = false;
                Task::none()
            }
            Message::Error(e) => {
                self.busy = false;
                self.error = Some(e);
                Task::none()
            }
            Message::ClearError => {
                self.error = None;
                Task::none()
            }
        }
    }

    pub fn view(&self) -> Element<'_, Message> {
        let title = text("StarDust")
            .size(32)
            .color(iced::Color::from_rgb(0.48, 0.58, 0.96));

        let subtitle = text(if self.is_register {
            "Создание аккаунта"
        } else {
            "Вход в аккаунт"
        })
        .size(14)
        .color(iced::Color::from_rgb(0.6, 0.6, 0.7));

        let username_input = text_input("Логин", &self.username)
            .on_input(Message::UsernameChanged)
            .size(14)
            .padding(12);

        let password_input = text_input("Пароль", &self.password)
            .on_input(Message::PasswordChanged)
            .secure(true)
            .size(14)
            .padding(12);

        let submit_text = if self.busy {
            if self.is_register {
                "Создание..."
            } else {
                "Вход..."
            }
        } else if self.is_register {
            "Зарегистрироваться"
        } else {
            "Войти"
        };

        let submit_btn = button(text(submit_text).size(14))
            .on_press_maybe(
                if self.busy || self.username.is_empty() || self.password.is_empty() {
                    None
                } else {
                    Some(Message::Submit)
                },
            )
            .padding(iced::Padding::new(12.0).left(24.0).right(24.0))
            .width(Length::Fill);

        let toggle_text = if self.is_register {
            "Уже есть аккаунт? Войти"
        } else {
            "Нет аккаунта? Зарегистрироваться"
        };

        let toggle_btn =
            button(text(toggle_text).size(12)).on_press(Message::ToggleRegister);

        let error_text = if let Some(ref err) = self.error {
            text(err.as_str())
                .size(12)
                .color(iced::Color::from_rgb(0.9, 0.3, 0.3))
        } else {
            text("").size(12)
        };

        let form = column![
            title,
            subtitle,
            iced::widget::vertical_space().height(20),
            username_input,
            iced::widget::vertical_space().height(8),
            password_input,
            iced::widget::vertical_space().height(16),
            submit_btn,
            iced::widget::vertical_space().height(8),
            toggle_btn,
            iced::widget::vertical_space().height(8),
            error_text,
        ]
        .spacing(4)
        .max_width(320);

        container(form)
            .center_x(Length::Fill)
            .center_y(Length::Fill)
            .into()
    }
}
