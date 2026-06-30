//! Экран входа — 1:1 с Tauri LoginScreen.tsx.

use iced::{
    widget::{button, column, container, row, text, text_input},
    Element, Length, Task,
};

use crate::api::{self, AuthResponse, LoginResult};
use crate::styles::{self, Colors};

#[derive(Debug, Clone)]
pub enum Message {
    UsernameChanged(String),
    PasswordChanged(String),
    ConfirmChanged(String),
    SwitchMode(bool),
    Submit,
    PasswordlessLogin,
    ResetStart,
    ResetSubmit,
    LoginSuccess(AuthResponse),
    TwoFactorStarted(String),
    Error(String),
}

pub struct State {
    pub username: String,
    pub password: String,
    pub confirm: String,
    pub is_register: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub reset_mode: bool,
    pub new_password: String,
    pub new_password_confirm: String,
    pub two_factor: Option<String>,
}

impl State {
    pub fn new() -> Self {
        Self {
            username: String::new(),
            password: String::new(),
            confirm: String::new(),
            is_register: false,
            busy: false,
            error: None,
            reset_mode: false,
            new_password: String::new(),
            new_password_confirm: String::new(),
            two_factor: None,
        }
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::UsernameChanged(v) => {
                self.username = v;
                self.error = None;
                Task::none()
            }
            Message::PasswordChanged(v) => {
                self.password = v;
                self.error = None;
                Task::none()
            }
            Message::ConfirmChanged(v) => {
                self.confirm = v;
                self.error = None;
                Task::none()
            }
            Message::SwitchMode(reg) => {
                self.is_register = reg;
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
                            api::register(&username, &password).await.map(LoginResult::Ok)
                        } else {
                            api::login(&username, &password).await
                        }
                    },
                    |result| match result {
                        Ok(LoginResult::Ok(auth)) => Message::LoginSuccess(auth),
                        Ok(LoginResult::TwoFactorRequired { challenge, .. }) => {
                            Message::TwoFactorStarted(challenge)
                        }
                        Err(e) => Message::Error(e),
                    },
                )
            }
            Message::PasswordlessLogin => {
                self.busy = true;
                self.error = None;
                let username = self.username.clone();
                Task::perform(
                    async move { api::login_passwordless(&username).await },
                    |result| match result {
                        Ok(LoginResult::Ok(auth)) => Message::LoginSuccess(auth),
                        Ok(LoginResult::TwoFactorRequired { challenge, .. }) => {
                            Message::TwoFactorStarted(challenge)
                        }
                        Err(e) => Message::Error(e),
                    },
                )
            }
            Message::ResetStart => {
                self.busy = true;
                self.error = None;
                let username = self.username.clone();
                Task::perform(
                    async move { api::password_reset_start(&username).await },
                    |result| match result {
                        Ok(LoginResult::Ok(_)) => {
                            Message::Error("Пароль уже сброшен".to_string())
                        }
                        Ok(LoginResult::TwoFactorRequired { challenge, .. }) => {
                            Message::TwoFactorStarted(challenge)
                        }
                        Err(e) => Message::Error(e),
                    },
                )
            }
            Message::ResetSubmit => {
                self.busy = true;
                self.error = None;
                if self.new_password != self.new_password_confirm {
                    self.busy = false;
                    self.error = Some("Пароли не совпадают".to_string());
                    return Task::none();
                }
                let username = self.username.clone();
                let new_pw = self.new_password.clone();
                Task::perform(
                    async move { api::password_reset_complete(&username, &new_pw).await },
                    |result| match result {
                        Ok(()) => Message::Error("Пароль изменён. Войдите заново".to_string()),
                        Err(e) => Message::Error(e),
                    },
                )
            }
            Message::LoginSuccess(_) => {
                self.busy = false;
                Task::none()
            }
            Message::TwoFactorStarted(challenge) => {
                self.busy = false;
                self.two_factor = Some(challenge);
                Task::none()
            }
            Message::Error(e) => {
                self.busy = false;
                self.error = Some(e);
                Task::none()
            }
        }
    }

    pub fn view(&self) -> Element<'_, Message> {
        if self.reset_mode {
            return self.view_reset();
        }
        if self.two_factor.is_some() {
            return self.view_2fa();
        }
        self.view_main()
    }

    fn view_main(&self) -> Element<'_, Message> {
        let title = text("StarDust").size(28).color(Colors::ACCENT);
        let subtitle = text(if self.is_register {
            "Создайте аккаунт"
        } else {
            "Войдите, чтобы продолжить"
        })
        .size(14)
        .color(Colors::MUTED);

        let tab_login = button(text("Вход").size(14))
            .on_press(Message::SwitchMode(false))
            .padding(iced::Padding::new(9.0).left(12.0).right(12.0))
            .width(Length::Fill)
            .style(if !self.is_register { styles::tab_active } else { styles::tab_inactive });

        let tab_register = button(text("Регистрация").size(14))
            .on_press(Message::SwitchMode(true))
            .padding(iced::Padding::new(9.0).left(12.0).right(12.0))
            .width(Length::Fill)
            .style(if self.is_register { styles::tab_active } else { styles::tab_inactive });

        let tabs = row![tab_login, tab_register].spacing(4).padding(4);

        let username_input = text_input("Логин", &self.username)
            .on_input(Message::UsernameChanged)
            .size(14)
            .padding(12);

        let password_input = text_input("Пароль", &self.password)
            .on_input(Message::PasswordChanged)
            .secure(true)
            .size(14)
            .padding(12);

        let mut form: Vec<Element<'_, Message>> = vec![
            username_input.into(),
            password_input.into(),
        ];

        if self.is_register {
            let confirm_input = text_input("Повторите пароль", &self.confirm)
                .on_input(Message::ConfirmChanged)
                .secure(true)
                .size(14)
                .padding(12);
            form.push(confirm_input.into());
        }

        if let Some(ref err) = self.error {
            form.push(text(err.as_str()).size(12).color(Colors::DANGER).into());
        }

        let submit_text = if self.busy {
            if self.is_register { "Создание…" } else { "Вход…" }
        } else if self.is_register {
            "Зарегистрироваться"
        } else {
            "Войти"
        };

        let can_submit = !self.busy && !self.username.is_empty() && !self.password.is_empty()
            && (!self.is_register || !self.confirm.is_empty());

        let submit_btn = button(text(submit_text).size(14))
            .on_press_maybe(if can_submit { Some(Message::Submit) } else { None })
            .padding(iced::Padding::new(12.0).left(24.0).right(24.0))
            .width(Length::Fill)
            .style(styles::btn_primary);

        let mut form_col = column![].spacing(10);
        for child in form {
            form_col = form_col.push(child);
        }
        form_col = form_col.push(submit_btn);

        if !self.is_register {
            form_col = form_col.push(
                button(text("Войти без пароля").size(12))
                    .on_press_maybe(
                        if self.busy || self.username.is_empty() { None } else { Some(Message::PasswordlessLogin) },
                    )
                    .padding(iced::Padding::new(8.0).left(14.0).right(14.0))
                    .style(styles::btn_ghost),
            );
            form_col = form_col.push(
                button(text("Забыли пароль?").size(12))
                    .on_press_maybe(
                        if self.busy || self.username.is_empty() { None } else { Some(Message::ResetStart) },
                    )
                    .padding(iced::Padding::new(8.0).left(14.0).right(14.0))
                    .style(styles::btn_ghost),
            );
        }

        let card = container(form_col)
            .padding(iced::Padding::new(24.0).left(24.0).right(24.0).top(20.0).bottom(20.0))
            .width(360)
            .style(styles::glass_card);

        let layout = column![title, subtitle, iced::widget::vertical_space().height(8), tabs, card]
            .spacing(8)
            .align_x(iced::Alignment::Center)
            .padding(iced::Padding::new(0.0).top(80.0));

        container(layout)
            .width(Length::Fill)
            .height(Length::Fill)
            .center_x(Length::Fill)
            .center_y(Length::Fill)
            .into()
    }

    fn view_2fa(&self) -> Element<'_, Message> {
        let title = text("Подтверждение").size(22).color(Colors::TEXT);
        let subtitle = text("Введите код из Telegram").size(14).color(Colors::MUTED);

        let mut form_col = column![title, subtitle].spacing(8);

        if let Some(ref err) = self.error {
            form_col = form_col.push(text(err.as_str()).size(12).color(Colors::DANGER));
        }

        let card = container(form_col)
            .padding(iced::Padding::new(24.0).left(24.0).right(24.0).top(20.0).bottom(20.0))
            .width(360)
            .style(styles::glass_card);

        container(card)
            .width(Length::Fill)
            .height(Length::Fill)
            .center_x(Length::Fill)
            .center_y(Length::Fill)
            .into()
    }

    fn view_reset(&self) -> Element<'_, Message> {
        let title = text("Сброс пароля").size(22).color(Colors::TEXT);
        let subtitle = text("Введите новый пароль").size(14).color(Colors::MUTED);

        let pw1 = text_input("Новый пароль", &self.new_password)
            .on_input(Message::UsernameChanged)
            .secure(true)
            .size(14)
            .padding(12);

        let pw2 = text_input("Повторите пароль", &self.new_password_confirm)
            .on_input(Message::ConfirmChanged)
            .secure(true)
            .size(14)
            .padding(12);

        let submit = button(text("Сохранить").size(14))
            .on_press_maybe(
                if self.busy || self.new_password.is_empty() || self.new_password_confirm.is_empty() {
                    None
                } else {
                    Some(Message::ResetSubmit)
                },
            )
            .padding(iced::Padding::new(12.0).left(24.0).right(24.0))
            .width(Length::Fill)
            .style(styles::btn_primary);

        let mut form_col = column![title, subtitle, pw1, pw2, submit].spacing(10);

        if let Some(ref err) = self.error {
            form_col = form_col.push(text(err.as_str()).size(12).color(Colors::DANGER));
        }

        let card = container(form_col)
            .padding(iced::Padding::new(24.0).left(24.0).right(24.0).top(20.0).bottom(20.0))
            .width(360)
            .style(styles::glass_card);

        container(card)
            .width(Length::Fill)
            .height(Length::Fill)
            .center_x(Length::Fill)
            .center_y(Length::Fill)
            .into()
    }
}
