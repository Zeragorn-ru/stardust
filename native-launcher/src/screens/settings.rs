//! Экран настроек — 1:1 с Tauri SettingsScreen.tsx.

use iced::{
    widget::{button, column, container, row, slider, text, text_input, toggler},
    Element, Length, Task,
};

use crate::api::{self, AccountInfo, LauncherSettings, OptionalMod, TelegramLinkResponse};
use crate::styles::{self, Colors};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Section {
    General,
    Account,
    Mods,
}

#[derive(Debug, Clone)]
pub enum Message {
    Close,
    SwitchSection(Section),
    // General
    MemoryChanged(f32),
    ConcurrencyChanged(f32),
    Show3dModelToggled(bool),
    ResetDefaults,
    Save,
    Saved,
    // Account
    AccountInfoLoaded(Result<AccountInfo, String>),
    RenameChanged(String),
    RenameSubmit,
    RenameResult(Result<crate::api::PlayerProfile, String>),
    PasswordCurrentChanged(String),
    PasswordNewChanged(String),
    PasswordConfirmChanged(String),
    PasswordSubmit,
    PasswordResult(Result<(), String>),
    TelegramLinkStart,
    TelegramLinkResult(Result<TelegramLinkResponse, String>),
    TelegramUnlink,
    TelegramUnlinkResult(Result<(), String>),
    DeleteConfirmToggle,
    DeletePasswordChanged(String),
    DeleteSubmit,
    DeleteResult(Result<(), String>),
    LogoutAfterDelete,
    // Mods
    ModsLoaded(Result<Vec<OptionalMod>, String>),
    ModsFilterChanged(String),
    ModToggled(String, bool),
    ModToggleResult(String, bool, Result<(), String>),
}

pub struct State {
    pub settings: Option<LauncherSettings>,
    pub dirty: bool,
    pub(crate) section: Section,
    // Account
    pub(crate) account_info: Option<AccountInfo>,
    account_loading: bool,
    rename_value: String,
    rename_saving: bool,
    rename_msg: Option<String>,
    rename_err: Option<String>,
    pw_current: String,
    pw_new: String,
    pw_confirm: String,
    pw_saving: bool,
    pw_msg: Option<String>,
    pw_err: Option<String>,
    tg_link: Option<TelegramLinkResponse>,
    tg_saving: bool,
    tg_err: Option<String>,
    delete_confirming: bool,
    delete_password: String,
    delete_saving: bool,
    delete_err: Option<String>,
    // Mods
    pub(crate) mods: Option<Vec<OptionalMod>>,
    mods_loading: bool,
    mods_filter: String,
    mods_pending: std::collections::HashSet<String>,
    mods_err: Option<String>,
}

impl State {
    pub fn new() -> Self {
        Self {
            settings: None,
            dirty: false,
            section: Section::General,
            account_info: None,
            account_loading: false,
            rename_value: String::new(),
            rename_saving: false,
            rename_msg: None,
            rename_err: None,
            pw_current: String::new(),
            pw_new: String::new(),
            pw_confirm: String::new(),
            pw_saving: false,
            pw_msg: None,
            pw_err: None,
            tg_link: None,
            tg_saving: false,
            tg_err: None,
            delete_confirming: false,
            delete_password: String::new(),
            delete_saving: false,
            delete_err: None,
            mods: None,
            mods_loading: false,
            mods_filter: String::new(),
            mods_pending: std::collections::HashSet::new(),
            mods_err: None,
        }
    }

    pub fn load_account(&mut self, token: &str) -> Task<Message> {
        self.account_loading = true;
        let t = token.to_string();
        Task::perform(
            async move { api::account_info(&t).await },
            Message::AccountInfoLoaded,
        )
    }

    pub fn load_mods(&mut self, token: &str) -> Task<Message> {
        self.mods_loading = true;
        let t = token.to_string();
        Task::perform(
            async move { api::list_optional_mods(&t).await },
            Message::ModsLoaded,
        )
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Close => Task::none(),
            Message::SwitchSection(s) => {
                self.section = s;
                Task::none()
            }
            // ─── General ─────────────────────────────
            Message::MemoryChanged(v) => {
                if let Some(ref mut s) = self.settings {
                    s.memory_mb = v as u32;
                    self.dirty = true;
                }
                Task::none()
            }
            Message::ConcurrencyChanged(v) => {
                if let Some(ref mut s) = self.settings {
                    s.download_concurrency = v as u32;
                    self.dirty = true;
                }
                Task::none()
            }
            Message::Show3dModelToggled(v) => {
                if let Some(ref mut s) = self.settings {
                    s.show_3d_model = v;
                    self.dirty = true;
                }
                Task::none()
            }
            Message::ResetDefaults => {
                self.settings = Some(LauncherSettings::default());
                self.dirty = true;
                Task::none()
            }
            Message::Save => {
                if let Some(ref settings) = self.settings {
                    let s = settings.clone();
                    self.dirty = false;
                    Task::perform(
                        async move {
                            let data_dir = crate::paths::data_dir();
                            let _ = api::save_settings(&data_dir, &s);
                        },
                        |_| Message::Saved,
                    )
                } else {
                    Task::none()
                }
            }
            Message::Saved => Task::none(),

            // ─── Account ─────────────────────────────
            Message::AccountInfoLoaded(Ok(info)) => {
                self.rename_value = info.profile.name.clone();
                self.account_info = Some(info);
                self.account_loading = false;
                Task::none()
            }
            Message::AccountInfoLoaded(Err(_)) => {
                self.account_loading = false;
                Task::none()
            }
            Message::RenameChanged(v) => {
                self.rename_value = v;
                self.rename_msg = None;
                self.rename_err = None;
                Task::none()
            }
            Message::RenameSubmit => {
                let name = self.rename_value.trim().to_string();
                if name.len() < 3 {
                    self.rename_err = Some("Имя игрока: минимум 3 символа".into());
                    return Task::none();
                }
                if let Some(ref info) = self.account_info {
                    if name == info.profile.name {
                        self.rename_err = Some("Это уже ваш текущий ник".into());
                        return Task::none();
                    }
                }
                self.rename_saving = true;
                self.rename_msg = None;
                self.rename_err = None;
                Task::perform(
                    async move {
                        let token = crate::api::load_session(&crate::paths::data_dir())
                            .map(|s| s.token)
                            .unwrap_or_default();
                        api::change_username(&token, &name).await
                    },
                    Message::RenameResult,
                )
            }
            Message::RenameResult(Ok(profile)) => {
                self.rename_saving = false;
                self.rename_value = profile.name.clone();
                if let Some(ref mut info) = self.account_info {
                    info.profile = profile;
                }
                self.rename_msg = Some("Ник обновлён".into());
                Task::none()
            }
            Message::RenameResult(Err(e)) => {
                self.rename_saving = false;
                self.rename_err = Some(e);
                Task::none()
            }

            Message::PasswordCurrentChanged(v) => {
                self.pw_current = v;
                self.pw_msg = None;
                self.pw_err = None;
                Task::none()
            }
            Message::PasswordNewChanged(v) => {
                self.pw_new = v;
                self.pw_msg = None;
                self.pw_err = None;
                Task::none()
            }
            Message::PasswordConfirmChanged(v) => {
                self.pw_confirm = v;
                self.pw_msg = None;
                self.pw_err = None;
                Task::none()
            }
            Message::PasswordSubmit => {
                if self.pw_new.len() < 6 {
                    self.pw_err = Some("Пароль: минимум 6 символов".into());
                    return Task::none();
                }
                if self.pw_new != self.pw_confirm {
                    self.pw_err = Some("Пароли не совпадают".into());
                    return Task::none();
                }
                self.pw_saving = true;
                self.pw_msg = None;
                self.pw_err = None;
                let cur = self.pw_current.clone();
                let new = self.pw_new.clone();
                Task::perform(
                    async move {
                        let token = crate::api::load_session(&crate::paths::data_dir())
                            .map(|s| s.token)
                            .unwrap_or_default();
                        api::change_password(&token, &cur, &new).await
                    },
                    Message::PasswordResult,
                )
            }
            Message::PasswordResult(Ok(())) => {
                self.pw_saving = false;
                self.pw_current.clear();
                self.pw_new.clear();
                self.pw_confirm.clear();
                self.pw_msg = Some("Пароль изменён".into());
                Task::none()
            }
            Message::PasswordResult(Err(e)) => {
                self.pw_saving = false;
                self.pw_err = Some(e);
                Task::none()
            }

            Message::TelegramLinkStart => {
                self.tg_saving = true;
                self.tg_err = None;
                Task::perform(
                    async move {
                        let token = crate::api::load_session(&crate::paths::data_dir())
                            .map(|s| s.token)
                            .unwrap_or_default();
                        api::telegram_link_start(&token).await
                    },
                    Message::TelegramLinkResult,
                )
            }
            Message::TelegramLinkResult(Ok(link)) => {
                self.tg_saving = false;
                self.tg_link = Some(link);
                Task::none()
            }
            Message::TelegramLinkResult(Err(e)) => {
                self.tg_saving = false;
                self.tg_err = Some(e);
                Task::none()
            }
            Message::TelegramUnlink => {
                self.tg_saving = true;
                self.tg_err = None;
                Task::perform(
                    async move {
                        let token = crate::api::load_session(&crate::paths::data_dir())
                            .map(|s| s.token)
                            .unwrap_or_default();
                        api::telegram_unlink(&token).await
                    },
                    Message::TelegramUnlinkResult,
                )
            }
            Message::TelegramUnlinkResult(Ok(())) => {
                self.tg_saving = false;
                self.tg_link = None;
                if let Some(ref mut info) = self.account_info {
                    info.telegram_linked = false;
                }
                Task::none()
            }
            Message::TelegramUnlinkResult(Err(e)) => {
                self.tg_saving = false;
                self.tg_err = Some(e);
                Task::none()
            }

            Message::DeleteConfirmToggle => {
                self.delete_confirming = !self.delete_confirming;
                self.delete_password.clear();
                self.delete_err = None;
                Task::none()
            }
            Message::DeletePasswordChanged(v) => {
                self.delete_password = v;
                self.delete_err = None;
                Task::none()
            }
            Message::DeleteSubmit => {
                if self.delete_password.is_empty() {
                    self.delete_err = Some("Введите пароль для подтверждения".into());
                    return Task::none();
                }
                self.delete_saving = true;
                self.delete_err = None;
                let pw = self.delete_password.clone();
                Task::perform(
                    async move {
                        let token = crate::api::load_session(&crate::paths::data_dir())
                            .map(|s| s.token)
                            .unwrap_or_default();
                        api::delete_account(&token, &pw).await
                    },
                    Message::DeleteResult,
                )
            }
            Message::DeleteResult(Ok(())) => {
                self.delete_saving = false;
                Task::perform(async {}, |_| Message::LogoutAfterDelete)
            }
            Message::DeleteResult(Err(e)) => {
                self.delete_saving = false;
                self.delete_err = Some(e);
                Task::none()
            }
            Message::LogoutAfterDelete => Task::none(),

            // ─── Mods ────────────────────────────────
            Message::ModsLoaded(Ok(mods)) => {
                self.mods = Some(mods);
                self.mods_loading = false;
                Task::none()
            }
            Message::ModsLoaded(Err(e)) => {
                self.mods_loading = false;
                self.mods_err = Some(e);
                Task::none()
            }
            Message::ModsFilterChanged(v) => {
                self.mods_filter = v;
                Task::none()
            }
            Message::ModToggled(mod_id, enabled) => {
                self.mods_pending.insert(mod_id.clone());
                let mid = std::sync::Arc::new(mod_id);
                let mid2 = mid.clone();
                Task::perform(
                    async move {
                        let token = crate::api::load_session(&crate::paths::data_dir())
                            .map(|s| s.token)
                            .unwrap_or_default();
                        api::set_mod_enabled(&token, &mid, enabled).await
                    },
                    move |r| Message::ModToggleResult((*mid2).clone(), enabled, r),
                )
            }
            Message::ModToggleResult(mod_id, enabled, Ok(())) => {
                self.mods_pending.remove(&mod_id);
                if let Some(ref mut mods) = self.mods {
                    for m in mods.iter_mut() {
                        if m.mod_id == mod_id {
                            m.enabled = enabled;
                            break;
                        }
                    }
                }
                Task::none()
            }
            Message::ModToggleResult(mod_id, _enabled, Err(_)) => {
                self.mods_pending.remove(&mod_id);
                // Revert: reload
                if let Some(ref mut mods) = self.mods {
                    for m in mods.iter_mut() {
                        if m.mod_id == mod_id {
                            m.enabled = !m.enabled;
                            break;
                        }
                    }
                }
                Task::none()
            }
        }
    }

    pub fn view(&self, token: Option<&str>) -> Element<'_, Message> {
        // ─── Header ────────────────────────────────
        let back_btn = button(text("← Назад").size(14))
            .on_press(Message::Close)
            .padding(iced::Padding::new(8.0).left(14.0).right(14.0))
            .style(styles::btn_ghost);

        let title = text("Настройки").size(18).color(Colors::TEXT);

        let save_btn = if self.section == Section::General {
            let btn = button(text("Сохранить").size(14))
                .padding(iced::Padding::new(8.0).left(16.0).right(16.0))
                .style(styles::btn_primary);
            if self.dirty {
                btn.on_press(Message::Save)
            } else {
                btn
            }
        } else {
            button(text("Сохранить").size(14))
                .padding(iced::Padding::new(8.0).left(16.0).right(16.0))
                .style(styles::btn_primary)
        };

        let header = row![back_btn, title, iced::widget::horizontal_space(), save_btn]
            .spacing(14)
            .align_y(iced::Alignment::Center)
            .padding(iced::Padding::new(0.0).left(22.0).right(22.0).top(16.0).bottom(16.0));

        let header_container = container(header)
            .width(Length::Fill)
            .style(|_theme: &iced::Theme| iced::widget::container::Style {
                background: Some(iced::Background::Color(iced::Color::from_rgba(
                    0.039, 0.043, 0.078, 0.4,
                ))),
                border: iced::border::rounded(0).width(1).color(Colors::GLASS_BORDER),
                ..Default::default()
            });

        // ─── Sidebar nav ───────────────────────────
        let nav_general = button(text("Общие").size(14))
            .on_press(Message::SwitchSection(Section::General))
            .padding(iced::Padding::new(10.0).left(14.0).right(14.0))
            .width(Length::Fill)
            .style(styles::nav_item(self.section == Section::General));

        let nav_account = button(text("Аккаунт").size(14))
            .on_press(Message::SwitchSection(Section::Account))
            .padding(iced::Padding::new(10.0).left(14.0).right(14.0))
            .width(Length::Fill)
            .style(styles::nav_item(self.section == Section::Account));

        let nav_mods = button(text("Сборка").size(14))
            .on_press(Message::SwitchSection(Section::Mods))
            .padding(iced::Padding::new(10.0).left(14.0).right(14.0))
            .width(Length::Fill)
            .style(styles::nav_item(self.section == Section::Mods));

        let sidebar = column![nav_general, nav_account, nav_mods]
            .spacing(4)
            .padding(iced::Padding::new(0.0).left(12.0).right(12.0).top(22.0).bottom(22.0))
            .width(180);

        let sidebar_container = container(sidebar)
            .style(|_theme: &iced::Theme| iced::widget::container::Style {
                background: Some(iced::Background::Color(iced::Color::from_rgba(
                    0.039, 0.043, 0.078, 0.25,
                ))),
                border: iced::border::rounded(0).width(0).color(Colors::GLASS_BORDER),
                ..Default::default()
            });

        // ─── Body ──────────────────────────────────
        let body = match self.section {
            Section::General => self.view_general(),
            Section::Account => self.view_account(token),
            Section::Mods => self.view_mods(),
        };
        let body_container = container(body)
            .padding(iced::Padding::new(0.0).left(28.0).right(28.0).top(28.0).bottom(28.0))
            .width(Length::Fill)
            .max_width(560);

        let layout = row![sidebar_container, body_container];

        column![header_container, layout].height(Length::Fill).into()
    }

    fn view_general(&self) -> Element<'_, Message> {
        if let Some(ref settings) = self.settings {
            let memory = settings.memory_mb as f32;
            let concurrency = settings.download_concurrency as f32;

            let memory_label = text(format!("Память: {} МБ", settings.memory_mb))
                .size(14).color(Colors::TEXT);

            let memory_slider = slider(1024.0..=16384.0, memory, Message::MemoryChanged).step(512.0);

            let concurrency_label = text(format!("Одновременных загрузок: {}", settings.download_concurrency))
                .size(14).color(Colors::TEXT);

            let concurrency_slider = slider(1.0..=16.0, concurrency, Message::ConcurrencyChanged).step(1.0);

            let model_toggle = row![
                column![
                    text("3D-модель скина").size(14).color(Colors::TEXT),
                    text("Отключите для экономии ресурсов").size(12).color(Colors::MUTED),
                ].spacing(3),
                iced::widget::horizontal_space(),
                toggler(settings.show_3d_model).on_toggle(Message::Show3dModelToggled),
            ];

            let reset_btn = button(text("Сбросить настройки по умолчанию").size(14))
                .on_press(Message::ResetDefaults)
                .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
                .style(styles::btn_ghost);

            // Info card
            let data_dir = crate::paths::data_dir();
            let data_dir_str = data_dir.display().to_string();
            let version_str = env!("CARGO_PKG_VERSION").to_string();
            let info_rows = column![
                self.info_row("Папка данных", &data_dir_str),
                self.info_row("Версия", &version_str),
            ].spacing(6);

            let info_card = container(info_rows)
                .padding(iced::Padding::new(14.0).left(16.0).right(16.0).top(12.0).bottom(12.0))
                .width(Length::Fill)
                .style(styles::glass_card);

            column![
                memory_label,
                memory_slider,
                iced::widget::vertical_space().height(12),
                concurrency_label,
                concurrency_slider,
                iced::widget::vertical_space().height(12),
                model_toggle,
                iced::widget::vertical_space().height(12),
                reset_btn,
                iced::widget::vertical_space().height(12),
                info_card,
            ]
            .spacing(4)
            .into()
        } else {
            column![text("Загрузка настроек…").size(14).color(Colors::MUTED)]
                .spacing(8)
                .into()
        }
    }

    fn view_account(&self, _token: Option<&str>) -> Element<'_, Message> {
        if self.account_loading {
            return column![text("Загрузка…").size(14).color(Colors::MUTED)]
                .spacing(8)
                .into();
        }

        let mut content = column![].spacing(16);

        // ─── Info card ─────────────────────────────
        if let Some(ref info) = self.account_info {
            let role_badge = if info.is_admin { "Администратор" } else { "Игрок" };
            let tg_status = if info.telegram_linked { "привязан" } else { "не привязан" };

            let info_card = container(column![
                self.info_row("Ник", &info.profile.name),
                self.info_row("UUID", &info.profile.id),
                self.info_row("Роль", role_badge),
                self.info_row("Telegram 2FA", tg_status),
            ].spacing(6))
            .padding(iced::Padding::new(14.0).left(16.0).right(16.0).top(12.0).bottom(12.0))
            .width(Length::Fill)
            .style(styles::glass_card);

            content = content.push(info_card);
        }

        // ─── Rename form ───────────────────────────
        let rename_title = text("Сменить ник").size(15).color(Colors::TEXT);
        let rename_input = text_input("Новый ник", &self.rename_value)
            .on_input(Message::RenameChanged)
            .padding(iced::Padding::new(10.0).left(12.0).right(12.0))
            .style(styles::input_style);
        let rename_btn = button(
            text(if self.rename_saving { "Сохранение…" } else { "Сохранить ник" }).size(14)
        )
        .on_press_maybe(if self.rename_saving { None } else { Some(Message::RenameSubmit) })
        .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
        .style(styles::btn_primary);

        let mut rename_section = column![rename_title, rename_input, rename_btn].spacing(8);
        if let Some(ref msg) = self.rename_msg {
            rename_section = rename_section.push(text(msg.as_str()).size(13).color(Colors::TEAL));
        }
        if let Some(ref err) = self.rename_err {
            rename_section = rename_section.push(text(err.as_str()).size(13).color(Colors::DANGER));
        }

        let rename_card = container(rename_section)
            .padding(iced::Padding::new(14.0).left(16.0).right(16.0).top(12.0).bottom(12.0))
            .width(Length::Fill)
            .style(styles::glass_card);

        content = content.push(rename_card);

        // ─── Password form ─────────────────────────
        let pw_title = text("Сменить пароль").size(15).color(Colors::TEXT);
        let pw_cur = text_input("Текущий пароль", &self.pw_current)
            .on_input(Message::PasswordCurrentChanged)
            .padding(iced::Padding::new(10.0).left(12.0).right(12.0))
            .style(styles::input_style)
            .secure(true);
        let pw_new = text_input("Новый пароль", &self.pw_new)
            .on_input(Message::PasswordNewChanged)
            .padding(iced::Padding::new(10.0).left(12.0).right(12.0))
            .style(styles::input_style)
            .secure(true);
        let pw_conf = text_input("Повторите новый пароль", &self.pw_confirm)
            .on_input(Message::PasswordConfirmChanged)
            .padding(iced::Padding::new(10.0).left(12.0).right(12.0))
            .style(styles::input_style)
            .secure(true);
        let pw_btn = button(
            text(if self.pw_saving { "Сохранение…" } else { "Изменить пароль" }).size(14)
        )
        .on_press_maybe(if self.pw_saving { None } else { Some(Message::PasswordSubmit) })
        .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
        .style(styles::btn_primary);

        let mut pw_section = column![pw_title, pw_cur, pw_new, pw_conf, pw_btn].spacing(8);
        if let Some(ref msg) = self.pw_msg {
            pw_section = pw_section.push(text(msg.as_str()).size(13).color(Colors::TEAL));
        }
        if let Some(ref err) = self.pw_err {
            pw_section = pw_section.push(text(err.as_str()).size(13).color(Colors::DANGER));
        }

        let pw_card = container(pw_section)
            .padding(iced::Padding::new(14.0).left(16.0).right(16.0).top(12.0).bottom(12.0))
            .width(Length::Fill)
            .style(styles::glass_card);

        content = content.push(pw_card);

        // ─── Telegram 2FA ──────────────────────────
        let tg_title = text("Telegram 2FA").size(15).color(Colors::TEXT);
        let mut tg_section = column![tg_title].spacing(8);

        let is_linked = self.account_info.as_ref().map(|i| i.telegram_linked).unwrap_or(false);
        if is_linked {
            tg_section = tg_section.push(
                text("Двухфакторная защита включена: при входе нужен код из Telegram.")
                    .size(13).color(Colors::MUTED),
            );
            let unlink_btn = button(
                text(if self.tg_saving { "Отключение…" } else { "Отключить 2FA" }).size(14)
            )
            .on_press_maybe(if self.tg_saving { None } else { Some(Message::TelegramUnlink) })
            .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
            .style(styles::btn_ghost);
            tg_section = tg_section.push(unlink_btn);
        } else if let Some(ref link) = self.tg_link {
            tg_section = tg_section.push(
                text("Откройте бота в Telegram и отправьте команду /start с кодом:")
                    .size(13).color(Colors::MUTED),
            );
            let code_display = container(
                text(format!("/start {}", link.code)).size(14).color(Colors::TEXT),
            )
            .padding(iced::Padding::new(10.0).left(14.0).right(14.0))
            .width(Length::Fill)
            .style(|_theme: &iced::Theme| iced::widget::container::Style {
                background: Some(iced::Background::Color(iced::Color::from_rgba(0.0, 0.0, 0.0, 0.3))),
                border: iced::border::rounded(8).width(1).color(Colors::GLASS_BORDER),
                ..Default::default()
            });
            tg_section = tg_section.push(code_display);

            if let Some(ref deep) = link.deep_link {
                let tg_btn = button(text("Открыть Telegram").size(14))
                    .on_press(Message::TelegramLinkStart) // placeholder — ideally open external
                    .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
                    .style(styles::btn_primary);
                tg_section = tg_section.push(tg_btn);
                let _ = deep;
            }
        } else {
            tg_section = tg_section.push(
                text("Привяжите Telegram, чтобы включить вход по коду подтверждения.")
                    .size(13).color(Colors::MUTED),
            );
            let link_btn = button(
                text(if self.tg_saving { "Подготовка…" } else { "Привязать Telegram" }).size(14)
            )
            .on_press_maybe(if self.tg_saving { None } else { Some(Message::TelegramLinkStart) })
            .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
            .style(styles::btn_primary);
            tg_section = tg_section.push(link_btn);
        }
        if let Some(ref err) = self.tg_err {
            tg_section = tg_section.push(text(err.as_str()).size(13).color(Colors::DANGER));
        }

        let tg_card = container(tg_section)
            .padding(iced::Padding::new(14.0).left(16.0).right(16.0).top(12.0).bottom(12.0))
            .width(Length::Fill)
            .style(styles::glass_card);

        content = content.push(tg_card);

        // ─── Delete account (danger zone) ───────────
        let del_title = text("Удалить аккаунт").size(15).color(Colors::DANGER);
        let mut del_section = column![del_title].spacing(8);
        del_section = del_section.push(
            text("Аккаунт и все связанные данные будут удалены безвозвратно.")
                .size(13).color(Colors::MUTED),
        );

        if self.delete_confirming {
            let del_pw = text_input("Пароль для подтверждения", &self.delete_password)
                .on_input(Message::DeletePasswordChanged)
                .padding(iced::Padding::new(10.0).left(12.0).right(12.0))
                .style(styles::input_danger_style)
                .secure(true);
            del_section = del_section.push(del_pw);

            if let Some(ref err) = self.delete_err {
                del_section = del_section.push(text(err.as_str()).size(13).color(Colors::DANGER));
            }

            let cancel_btn = button(text("Отмена").size(14))
                .on_press(Message::DeleteConfirmToggle)
                .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
                .style(styles::btn_ghost);
            let confirm_btn = button(
                text(if self.delete_saving { "Удаление…" } else { "Удалить навсегда" }).size(14)
            )
            .on_press_maybe(if self.delete_saving { None } else { Some(Message::DeleteSubmit) })
            .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
            .style(styles::btn_danger);

            del_section = del_section.push(row![cancel_btn, confirm_btn].spacing(10));
        } else {
            let del_btn = button(text("Удалить аккаунт").size(14))
                .on_press(Message::DeleteConfirmToggle)
                .padding(iced::Padding::new(9.0).left(14.0).right(14.0))
                .style(styles::btn_danger);
            del_section = del_section.push(del_btn);
        }

        let del_card = container(del_section)
            .padding(iced::Padding::new(14.0).left(16.0).right(16.0).top(12.0).bottom(12.0))
            .width(Length::Fill)
            .style(styles::glass_card);

        content = content.push(del_card);

        content.into()
    }

    fn view_mods(&self) -> Element<'_, Message> {
        if self.mods_loading {
            return column![text("Загрузка списка модов…").size(14).color(Colors::MUTED)]
                .spacing(8)
                .into();
        }

        let mut content = column![].spacing(12);

        content = content.push(
            text("Дополнительные моды устанавливаются вместе со сборкой. Выключенные не загружаются игрой.")
                .size(13).color(Colors::MUTED),
        );

        if let Some(ref err) = self.mods_err {
            let err_text = format!("Ошибка: {err}");
            content = content.push(text(err_text).size(14).color(Colors::DANGER));
            return content.into();
        }

        if let Some(ref mods) = self.mods {
            if mods.is_empty() {
                content = content.push(
                    text("В активной сборке нет дополнительных модов для настройки.")
                        .size(13).color(Colors::MUTED),
                );
            } else {
                // Filter input
                let filter_input = text_input("Поиск модов…", &self.mods_filter)
                    .on_input(Message::ModsFilterChanged)
                    .padding(iced::Padding::new(10.0).left(12.0).right(12.0))
                    .style(styles::input_style);
                content = content.push(filter_input);

                let q = self.mods_filter.trim().to_lowercase();
                for mod_entry in mods.iter() {
                    if !q.is_empty()
                        && !mod_entry.name.to_lowercase().contains(&q)
                        && !mod_entry.description.as_deref().unwrap_or("").to_lowercase().contains(&q)
                    {
                        continue;
                    }

                    let enabled = mod_entry.enabled;

                    let mut row_content = column![].spacing(2);
                    let name_text = if mod_entry.size > 0 {
                        text(format!("{} · {}", mod_entry.name, format_size(mod_entry.size)))
                            .size(14).color(Colors::TEXT)
                    } else {
                        text(mod_entry.name.as_str()).size(14).color(Colors::TEXT)
                    };
                    row_content = row_content.push(name_text);
                    if let Some(ref desc) = mod_entry.description {
                        row_content = row_content.push(
                            text(desc.as_str()).size(12).color(Colors::MUTED),
                        );
                    }

                    let toggle = toggler(enabled)
                        .on_toggle({
                            let mid = std::sync::Arc::new(mod_entry.mod_id.clone());
                            move |v| Message::ModToggled((*mid).clone(), v)
                        });

                    let mod_row = row![row_content, iced::widget::horizontal_space(), toggle]
                        .align_y(iced::Alignment::Center)
                        .spacing(12);

                    let mod_card = container(mod_row)
                        .padding(iced::Padding::new(12.0).left(14.0).right(14.0).top(10.0).bottom(10.0))
                        .width(Length::Fill)
                        .style(styles::glass_card);

                    content = content.push(mod_card);
                }
            }
        } else {
            content = content.push(text("Нет данных").size(13).color(Colors::MUTED));
        }

        content.into()
    }

    fn info_row(&self, label: &str, value: &str) -> Element<'_, Message> {
        row![
            text(label.to_owned()).size(13).color(Colors::MUTED),
            iced::widget::horizontal_space(),
            text(value.to_owned()).size(13).color(Colors::TEXT),
        ]
        .align_y(iced::Alignment::Center)
        .into()
    }
}

fn format_size(bytes: u64) -> String {
    if bytes >= 1_048_576 {
        format!("{:.1} МБ", bytes as f64 / 1_048_576.0)
    } else if bytes >= 1024 {
        format!("{:.0} КБ", bytes as f64 / 1024.0)
    } else {
        format!("{bytes} Б")
    }
}
