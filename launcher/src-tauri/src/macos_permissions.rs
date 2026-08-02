//! Запрос разрешения на микрофон на macOS для Simple Voice Chat.
//!
//! Мод проверяет `AVAuthorizationStatus` при первом доступе к микрофону и показывает
//! «лаунчер не поддерживает», если статус `NOT_DETERMINED`. Лаунчер должен
//! заранее вызвать системный диалог TCC и быть подписан с `audio-input`.

#[cfg(target_os = "macos")]
extern "C" {
    fn stardust_request_microphone_access();
    fn stardust_microphone_authorization_status() -> i32;
}

/// AVAuthorizationStatus: 0 = notDetermined, 1 = restricted, 2 = denied, 3 = authorized.
#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(i32)]
enum AvAuthorizationStatus {
    NotDetermined = 0,
    Restricted = 1,
    Denied = 2,
    Authorized = 3,
}

#[cfg(target_os = "macos")]
impl AvAuthorizationStatus {
    fn current() -> Self {
        let raw = unsafe { stardust_microphone_authorization_status() };
        match raw {
            1 => Self::Restricted,
            2 => Self::Denied,
            3 => Self::Authorized,
            _ => Self::NotDetermined,
        }
    }
}

/// Запрашивает доступ к микрофону, если пользователь ещё не отвечал на TCC-диалог.
pub fn ensure_microphone_permission() {
    #[cfg(target_os = "macos")]
    {
        let before = AvAuthorizationStatus::current();
        if before == AvAuthorizationStatus::Authorized {
            return;
        }

        unsafe {
            stardust_request_microphone_access();
        }

        let after = AvAuthorizationStatus::current();
        tracing::info!("macOS microphone authorization: before={before:?}, after={after:?}");
    }
}
