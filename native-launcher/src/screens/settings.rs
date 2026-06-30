//! Экран настроек.

use iced::{
    widget::{button, column, row, slider, text, toggler},
    Element, Task,
};

use crate::api::{self, LauncherSettings};

#[derive(Debug, Clone)]
pub enum Message {
    Close,
    MemoryChanged(f32),
    ConcurrencyChanged(f32),
    Show3dModelToggled(bool),
    Save,
    Saved,
}

pub struct State {
    pub settings: Option<LauncherSettings>,
    pub dirty: bool,
}

impl State {
    pub fn new() -> Self {
        Self {
            settings: None,
            dirty: false,
        }
    }

    pub fn update(&mut self, message: Message) -> Task<Message> {
        match message {
            Message::Close => Task::none(),
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
        let back_btn = button(text("← Назад").size(14)).on_press(Message::Close);
        let title = text("Настройки").size(20).color(iced::Color::WHITE);

        let save_btn = {
            let btn = button(text("Сохранить").size(14))
                .padding(iced::Padding::new(8.0).left(16.0).right(16.0));
            if self.dirty {
                btn.on_press(Message::Save)
            } else {
                btn
            }
        };

        let header = row![back_btn, title, iced::widget::horizontal_space(), save_btn]
            .spacing(12)
            .align_y(iced::Alignment::Center);

        if let Some(ref settings) = self.settings {
            let memory = settings.memory_mb as f32;
            let concurrency = settings.download_concurrency as f32;

            let memory_label = text(format!("Память: {} МБ", settings.memory_mb))
                .size(14)
                .color(iced::Color::WHITE);

            let memory_slider =
                slider(1024.0..=16384.0, memory, Message::MemoryChanged).step(512.0);

            let concurrency_label = text(format!(
                "Одновременных загрузок: {}",
                settings.download_concurrency
            ))
            .size(14)
            .color(iced::Color::WHITE);

            let concurrency_slider =
                slider(1.0..=16.0, concurrency, Message::ConcurrencyChanged).step(1.0);

            let model_toggle = row![
                text("3D-модель скина")
                    .size(14)
                    .color(iced::Color::WHITE),
                iced::widget::horizontal_space(),
                toggler(settings.show_3d_model)
                    .on_toggle(Message::Show3dModelToggled),
            ];

            column![
                header,
                iced::widget::vertical_space().height(16),
                memory_label,
                memory_slider,
                iced::widget::vertical_space().height(12),
                concurrency_label,
                concurrency_slider,
                iced::widget::vertical_space().height(12),
                model_toggle,
            ]
            .spacing(4)
            .padding(iced::Padding::new(0.0).top(0.0).right(24.0).bottom(24.0).left(24.0))
            .into()
        } else {
            column![
                header,
                iced::widget::vertical_space().height(24),
                text("Загрузка настроек...")
                    .size(14)
                    .color(iced::Color::from_rgb(0.5, 0.5, 0.6)),
            ]
            .spacing(8)
            .padding(iced::Padding::new(0.0).top(0.0).right(24.0).bottom(24.0).left(24.0))
            .into()
        }
    }
}
