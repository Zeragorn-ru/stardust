//! Общие типы протокола: формат манифеста сборки и контракты API,
//! разделяемые лаунчером, auth-сервером и admin-сервисом.

use serde::{Deserialize, Serialize};

/// На какой стороне нужен файл сборки.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    /// Только клиент (напр. оптимизационные/визуальные моды).
    Client,
    /// Только сервер (напр. серверные плагины ядра).
    Server,
    /// И клиент, и сервер.
    Both,
}

impl Side {
    /// Нужен ли файл на клиенте.
    pub fn on_client(self) -> bool {
        matches!(self, Side::Client | Side::Both)
    }

    /// Нужен ли файл на сервере.
    pub fn on_server(self) -> bool {
        matches!(self, Side::Server | Side::Both)
    }
}

/// Категория файла сборки.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FileKind {
    Mod,
    Config,
    Resource,
    Other,
}

/// Один файл сборки.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileEntry {
    /// Путь относительно корня `.minecraft` (напр. `mods/sodium.jar`).
    pub path: String,
    /// URL для скачивания.
    pub url: String,
    /// SHA-1 содержимого (hex).
    pub sha1: String,
    /// Размер в байтах.
    pub size: u64,
    pub side: Side,
    pub kind: FileKind,
    /// Затирать ли локальную версию файла при обновлении.
    /// Для конфигов обычно `false`, чтобы не терять пользовательские правки.
    #[serde(default = "default_true")]
    pub overwrite: bool,
    /// Опциональный ли это мод: игрок может включать/выключать его в лаунчере.
    /// Для обязательных файлов (ядро, конфиги) — `false`.
    #[serde(default)]
    pub optional: bool,
    /// Если файл опциональный — включён ли он по умолчанию у нового игрока.
    #[serde(default = "default_true", rename = "enabledByDefault")]
    pub enabled_by_default: bool,
    /// Стабильный идентификатор опционального мода — по нему лаунчер хранит
    /// выбор игрока (вкл/выкл). Обычно modid или slug. Только для `optional`.
    #[serde(default, rename = "modId", skip_serializing_if = "Option::is_none")]
    pub mod_id: Option<String>,
    /// Человекочитаемое имя для списка модов в лаунчере.
    #[serde(
        default,
        rename = "displayName",
        skip_serializing_if = "Option::is_none"
    )]
    pub display_name: Option<String>,
    /// Короткое описание мода для UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Описание используемого загрузчика модов.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoaderInfo {
    /// Версия Minecraft, напр. `1.21.1`.
    pub minecraft: String,
    /// Тип загрузчика.
    pub kind: LoaderKind,
    /// Версия загрузчика.
    pub version: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoaderKind {
    Vanilla,
    Fabric,
    Quilt,
    Forge,
    NeoForge,
}

/// Манифест сборки. Лаунчер скачивает его и синхронизирует файлы.
///
/// Клиентский манифест содержит только файлы со `side ∈ {client, both}`;
/// серверная часть формируется из `side ∈ {server, both}`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Manifest {
    /// Имя сборки (для отображения).
    #[serde(default)]
    pub name: String,
    /// Версия сборки (семвер или дата-билд).
    pub version: String,
    pub loader: LoaderInfo,
    pub files: Vec<FileEntry>,
}

impl Manifest {
    /// Опциональные моды клиентской части — для экрана управления в лаунчере.
    pub fn optional_client_mods(&self) -> impl Iterator<Item = &FileEntry> {
        self.files
            .iter()
            .filter(|f| f.optional && f.side.on_client())
    }

    /// Файлы, нужные клиенту.
    pub fn client_files(&self) -> impl Iterator<Item = &FileEntry> {
        self.files.iter().filter(|f| f.side.on_client())
    }

    /// Файлы, нужные серверу.
    pub fn server_files(&self) -> impl Iterator<Item = &FileEntry> {
        self.files.iter().filter(|f| f.side.on_server())
    }
}

/// Профиль игрока, возвращаемый auth-сервером после логина.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerProfile {
    /// UUID без дефисов (формат Mojang). Генерируется сервером при регистрации.
    pub id: String,
    /// Имя игрока.
    pub name: String,
    /// Активный бейдж (эмодзи-префикс), если выбран.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_badge: Option<Badge>,
    /// Активный градиент (раскраска ника), если выбран.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub active_gradient: Option<Gradient>,
}

/// Бейдж — эмодзи-префикс перед ником в TAB.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Badge {
    pub id: i32,
    pub emoji: String,
    pub label: String,
    pub color: String,
}

/// Градиент — раскраска ника от одного цвета к другому.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Gradient {
    pub id: i32,
    pub label: String,
    pub color_start: String,
    pub color_end: String,
}

/// Полная информация о кастомизации игрока для лаунчера.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerCustomization {
    pub available_badges: Vec<Badge>,
    pub available_gradients: Vec<Gradient>,
    pub active_badge_id: Option<i32>,
    pub active_gradient_id: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_badge_ids: Option<Vec<i32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owned_gradient_ids: Option<Vec<i32>>,
}

/// Данные кастомизации для серверного мода (TAB integration).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerPlayerCustomization {
    pub badge: Option<String>,
    pub badge_color: Option<String>,
    pub name_color: Option<String>,
    pub gradient_start: Option<String>,
    pub gradient_end: Option<String>,
}

/// Учётные данные для входа/регистрации (логин по нику, без почты).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Credentials {
    pub username: String,
    pub password: String,
}

/// Успешный ответ на логин/регистрацию.
///
/// `token` — временный токен сессии. Лаунчер хранит его в памяти и использует
/// для действий владельца аккаунта: загрузка/импорт скина, позже — запуск игры.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub profile: PlayerProfile,
    pub token: String,
}

/// Результат входа: либо сразу сессия, либо требование второго фактора.
///
/// Внутренне тегирован полем `status`. При `two_factor_required` лаунчер
/// показывает поле ввода кода и затем шлёт код на `/api/login/2fa` с тем же
/// `challenge`. Если у аккаунта Telegram не привязан — сервер возвращает
/// `ok` сразу (2FA неприменима).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum LoginResult {
    /// Вход завершён, выдана сессия.
    Ok(AuthResponse),
    /// Нужен код из Telegram. `challenge` предъявляется на шаге подтверждения.
    TwoFactorRequired {
        challenge: String,
        /// Подсказка, куда отправлен код (напр. «отправлен в Telegram»).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        hint: Option<String>,
        /// Можно ли подтвердить вход кнопкой в Telegram (без ввода кода).
        /// Лаунчер тогда опрашивает `/api/login/2fa/status`.
        #[serde(rename = "buttonApproval", default)]
        button_approval: bool,
    },
}

/// Запрос подтверждения второго фактора: `challenge` из `LoginResult` и код.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwoFactorRequest {
    pub challenge: String,
    pub code: String,
}

/// Запрос статуса challenge (для подтверждения кнопкой). Лаунчер периодически
/// опрашивает сервер, пока пользователь не нажмёт кнопку в Telegram.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChallengeStatusRequest {
    pub challenge: String,
}

/// Статус challenge при опросе кнопочного подтверждения.
///
/// Тегирован полем `status`. `approved` несёт готовую сессию (для входа) —
/// при сбросе пароля поле `auth` отсутствует и нужно вызвать reset-эндпоинт.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "snake_case")]
#[allow(clippy::large_enum_variant)]
pub enum ChallengeStatus {
    /// Пользователь ещё не ответил — продолжать опрос.
    Pending,
    /// Подтверждено кнопкой «Это я».
    Approved {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        auth: Option<AuthResponse>,
    },
    /// Отклонено кнопкой «Это не я».
    Denied,
    /// Истёк срок или challenge не найден — начать заново.
    Expired,
}

/// Запрос входа без пароля: только ник. Подтверждается кнопкой в Telegram.
/// Возвращает `LoginResult::TwoFactorRequired { button_approval: true }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordlessLoginRequest {
    pub username: String,
}

#[cfg(test)]
mod tests {
    use super::{Badge, Gradient, PlayerCustomization, ServerPlayerCustomization};

    #[test]
    fn player_customization_uses_camel_case_for_frontends() {
        let dto = PlayerCustomization {
            available_badges: vec![Badge {
                id: 1,
                emoji: "⭐".into(),
                label: "VIP".into(),
                color: "#ffd700".into(),
            }],
            available_gradients: vec![Gradient {
                id: 2,
                label: "Огонь".into(),
                color_start: "#ff0000".into(),
                color_end: "#ffaa00".into(),
            }],
            active_badge_id: Some(1),
            active_gradient_id: Some(2),
            owned_badge_ids: Some(vec![1]),
            owned_gradient_ids: Some(vec![2]),
        };

        let json = serde_json::to_value(dto).unwrap();
        assert!(json.get("availableBadges").is_some());
        assert!(json.get("availableGradients").is_some());
        assert_eq!(json["availableGradients"][0]["colorStart"], "#ff0000");
        assert_eq!(json["activeBadgeId"], 1);
        assert_eq!(json["ownedBadgeIds"][0], 1);
        assert!(json.get("available_badges").is_none());
    }

    #[test]
    fn server_customization_stays_snake_case_for_java_mod() {
        let dto = ServerPlayerCustomization {
            badge: Some("⭐".into()),
            badge_color: Some("#ffd700".into()),
            name_color: Some("#ffffff".into()),
            gradient_start: Some("#ff0000".into()),
            gradient_end: Some("#ffaa00".into()),
        };

        let json = serde_json::to_value(dto).unwrap();
        assert_eq!(json["badge_color"], "#ffd700");
        assert_eq!(json["gradient_start"], "#ff0000");
        assert!(json.get("badgeColor").is_none());
    }
}

/// Запрос на сброс пароля: ник аккаунта с привязанным Telegram. Возвращает
/// `challenge`, который подтверждается кнопкой в Telegram.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordResetRequest {
    pub username: String,
}

/// Запрос установки нового пароля после подтверждения сброса в Telegram.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PasswordResetConfirm {
    pub challenge: String,
    pub code: String,
    #[serde(rename = "newPassword")]
    pub new_password: String,
}

/// Ответ на запрос кода привязки Telegram (лаунчер/админка).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelegramLinkResponse {
    /// Код для команды `/start <code>` боту.
    pub code: String,
    /// Username бота (`@name` без `@`), если известен.
    #[serde(rename = "botUsername", default, skip_serializing_if = "Option::is_none")]
    pub bot_username: Option<String>,
    /// Готовая deep-link `https://t.me/<bot>?start=<code>`, если известен бот.
    #[serde(rename = "deepLink", default, skip_serializing_if = "Option::is_none")]
    pub deep_link: Option<String>,
}

/// Ответ проверки текущей bearer-сессии.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionResponse {
    pub profile: PlayerProfile,
}

/// Расширенные сведения об аккаунте владельца (вкладка «Аккаунт»).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    pub profile: PlayerProfile,
    /// Привязан ли Telegram для 2FA.
    #[serde(rename = "telegramLinked")]
    pub telegram_linked: bool,
    /// Имеет ли аккаунт права администратора.
    #[serde(rename = "isAdmin")]
    pub is_admin: bool,
}

/// Запрос смены ника.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeUsernameRequest {
    #[serde(rename = "newUsername")]
    pub new_username: String,
}

/// Запрос смены пароля (требует текущий).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangePasswordRequest {
    #[serde(rename = "currentPassword")]
    pub current_password: String,
    #[serde(rename = "newPassword")]
    pub new_password: String,
}

/// Запрос само-удаления аккаунта (требует пароль для подтверждения).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeleteAccountRequest {
    pub password: String,
}

/// Модель скина: `classic` (4px руки) или `slim` (3px руки).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SkinModel {
    #[default]
    Classic,
    Slim,
}

/// Запрос на импорт скина с лицензионного аккаунта Mojang.
///
/// `source` — ник Mojang или UUID (с дефисами или без). Сервер сам
/// резолвит ник в UUID, тянет текстуру и сохраняет её у себя.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkinImportRequest {
    /// UUID нашего аккаунта, которому привязываем скин.
    pub uuid: String,
    /// Источник на стороне Mojang: ник или UUID.
    pub source: String,
    /// Обновлять ли скин периодически по этому источнику.
    #[serde(default)]
    pub keep_synced: bool,
}

/// Запрос на загрузку собственного скина игроком.
///
/// Скин хранится на сервере и привязан к аккаунту (UUID), поэтому
/// следует за игроком на любом устройстве.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkinUploadRequest {
    /// UUID аккаунта, которому привязываем скин.
    pub uuid: String,
    /// PNG-скин в base64 (без префикса `data:`).
    #[serde(rename = "pngBase64")]
    pub png_base64: String,
    /// Модель скина.
    #[serde(default)]
    pub model: SkinModel,
}

/// Статистика игрока: суммарное время игры и дата последнего захода на сервер.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerStats {
    /// Суммарное время игры в секундах.
    #[serde(rename = "playtimeSeconds")]
    pub playtime_seconds: i64,
    /// ISO-8601 дата-время последнего подтверждённого захода на сервер, либо null.
    #[serde(rename = "lastJoinedAt", skip_serializing_if = "Option::is_none")]
    pub last_joined_at: Option<String>,
}

/// Тело запроса на запись игровой сессии.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecordSessionRequest {
    /// Длительность сессии в секундах.
    #[serde(rename = "durationSeconds")]
    pub duration_seconds: i64,
    /// ISO-8601 момент запуска игры.
    #[serde(rename = "launchedAt")]
    pub launched_at: String,
}
