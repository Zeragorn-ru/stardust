//! Экран входа — 1:1 с Tauri LoginScreen.tsx.

use iced::{
    widget::{button, column, container, row, text, text_input},
    Element, Length, Task,
};

use crate::api::{self, LoginResult};
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
    LoginSuccess(LoginResult),
    Error(String),
}

pub struct State {
    pub username: String,
    pub password: String,
    pub confirm: String,
    pub is_register: bool,
    pub busy: bool,
    pub error: Option<String>,
    pub two_factor: Option<TwoFactorState>,
    pub code: String,
    pub reset_mode: bool,
    pub new_password: String,
    pub new_password_confirm: String,
}

#[derive(Debug, Clone)]
pub struct TwoFactorState {
    pub challenge: String,
    pub hint: Option<String>,
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
            two_factor: None,
            code: String::new(),
            reset_mode: false,
            new_password: String::new(),
            new_password_confirm: String::new(),
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
            Message::ConfirmChanged(v) => {
                self.confirm = v;
                Task::none()
            }
            Message::SwitchMode(register) => {
                self.is_register = register;
                self.error = None;
                self.two_factor = None;
                self.reset_mode = false;
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
                        Ok(lr) => Message::LoginSuccess(lr),
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
                        Ok(lr) => Message::LoginSuccess(lr),
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
                        Ok(()) => Message::Error("Код отправлен в Telegram".to_string()),
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
                        Ok(lr) => Message::LoginSuccess(lr),
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
        }
    }

    pub fn view(&self) -> Element<'_, Message> {
        if self.reset_mode {
            return self.view_reset();
        }
        if let Some(ref tf) = self.two_factor {
            return self.view_2fa(tf);
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

        // Tabs
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
                    .padding(iced::Padding::new(4.0).left(8.0).right(8.0))
                    .style(styles::btn_ghost),
            );
        }

        let form_container = container(form_col)
            .padding(20)
            .width(320)
            .style(styles::glass_card);

        let layout = column![
            title,
            subtitle,
            iced::widget::vertical_space().height(14),
            tabs,
            iced::widget::vertical_space().height(8),
            form_container,
        ]
        .spacing(6)
        .align_x(iced::Alignment::Center)
        .max_width(360);

        container(layout)
            .center_x(Length::Fill)
            .center_y(Length::Fill)
            .into()
    }

    fn view_2fa(&self, tf: &TwoFactorState) -> Element<'_, Message> {
        let title = text("StarDust").size(28).color(Colors::ACCENT);
        let hint_str = tf.hint.clone().unwrap_or_else(|| "Введите код из Telegram".to_string());
        let hint = text(hint_str)
            .size(14).color(Colors::MUTED);

        let code_input = text_input("Код подтверждения", &self.code)
            .on_input(Message::UsernameChanged)
            .size(14)
            .padding(12);

        let error_text = if let Some(ref err) = self.error {
            text(err.as_str()).size(12).color(Colors::DANGER)
        } else {
            text("").size(12)
        };

        let submit_btn = button(text("Подтвердить").size(14))
            .on_press_maybe(if self.busy || self.code.is_empty() { None } else { Some(Message::Submit) })
            .padding(iced::Padding::new(12.0).left(24.0).right(24.0))
            .width(Length::Fill)
            .style(styles::btn_primary);

        let back_btn = button(text("Назад").size(12))
            .on_press(Message::SwitchMode(false))
            .padding(iced::Padding::new(8.0).left(14.0).right(14.0))
            .style(styles::btn_ghost);

        let form = column![code_input, error_text, submit_btn, back_btn].spacing(10);
        let form_container = container(form).padding(20).width(320).style(styles::glass_card);

        let layout = column![title, hint, iced::widget::vertical_space().height(14), form_container]
            .spacing(6)
            .align_x(iced::Alignment::Center)
            .max_width(360);

        container(layout).center_x(Length::Fill).center_y(Length::Fill).into()
    }

    fn view_reset(&self) -> Element<'_, Message> {
        let title = text("StarDust").size(28).color(Colors::ACCENT);
        let subtitle = text("Задайте новый пароль").size(14).color(Colors::MUTED);

        let new_pw = text_input("Новый пароль", &self.new_password)
            .on_input(Message::PasswordChanged)
            .secure(true).size(14).padding(12);

        let confirm_pw = text_input("Повторите пароль", &self.new_password_confirm)
            .on_input(Message::ConfirmChanged)
            .secure(true).size(14).padding(12);

        let error_text = if let Some(ref err) = self.error {
            text(err.as_str()).size(12).color(Colors::DANGER)
        } else {
            text("").size(12)
        };

        let submit_btn = button(text("Сохранить пароль").size(14))
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

        let back_btn = button(text("Назад").size(12))
            .on_press(Message::SwitchMode(false))
            .padding(iced::Padding::new(8.0).left(14.0).right(14.0))
            .style(styles::btn_ghost);

        let form = column![new_pw, confirm_pw, error_text, submit_btn, back_btn].spacing(10);
        let form_container = container(form).padding(20).width(320).style(styles::glass_card);

        let layout = column![title, subtitle, iced::widget::vertical_space().height(14), form_container]
            .spacing(6)
            .align_x(iced::Alignment::Center)
            .max_width(360);

        container(layout).center_x(Length::Fill).center_y(Length::Fill).into()
    }
}
