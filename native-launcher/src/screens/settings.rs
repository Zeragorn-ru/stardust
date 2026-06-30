//! Экран настроек — 1:1 с Tauri SettingsScreen.tsx.

use iced::{
    widget::{button, column, container, row, slider, text, toggler},
    Element, Length, Task,
};

use crate::api::{self, LauncherSettings};
use crate::styles::{self, Colors};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Section {
    General,
}

#[derive(Debug, Clone)]
pub enum Message {
    Close,
    SwitchSection(Section),
    MemoryChanged(f32),
    ConcurrencyChanged(f32),
    Show3dModelToggled(bool),
    ResetDefaults,
    Save,
    Saved,
}

pub struct State {
    pub settings: Option<LauncherSettings>,
    pub dirty: bool,
    section: Section,
}

impl State {
    pub fn new() -> Self {
        Self {
            settings: None,
            dirty: false,
            section: Section::General,
        }
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Close => Task::none(),
            Message::SwitchSection(s) => {
                self.section = s;
                Task::none()
            }
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
        }
    }

    pub fn view(&self) -> Element<'_, Message> {
        // ─── Header ────────────────────────────────
        let back_btn = button(text("← Назад").size(14))
            .on_press(Message::Close)
            .padding(iced::Padding::new(8.0).left(14.0).right(14.0))
            .style(styles::btn_ghost);

        let title = text("Настройки").size(18).color(Colors::TEXT);

        let save_btn = {
            let btn = button(text("Сохранить").size(14))
                .padding(iced::Padding::new(8.0).left(16.0).right(16.0))
                .style(styles::btn_primary);
            if self.dirty {
                btn.on_press(Message::Save)
            } else {
                btn
            }
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

        let sidebar = column![nav_general]
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
        let body = self.view_body();
        let body_container = container(body)
            .padding(iced::Padding::new(0.0).left(28.0).right(28.0).top(28.0).bottom(28.0))
            .width(Length::Fill)
            .max_width(560);

        let layout = row![sidebar_container, body_container];

        column![header_container, layout].height(Length::Fill).into()
    }

    fn view_body(&self) -> Element<'_, Message> {
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
            ]
            .spacing(4)
            .into()
        } else {
            column![text("Загрузка настроек…").size(14).color(Colors::MUTED)]
                .spacing(8)
                .into()
        }
    }
}
