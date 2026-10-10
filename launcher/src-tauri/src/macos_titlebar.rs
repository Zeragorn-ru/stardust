//! Нативная шапка macOS: полоса 38pt, светофор по центру полосы,
//! заголовок окна по центру. Раскладку делает AppKit-хелпер на Obj-C
//! (native/macos_titlebar.m), здесь только безопасная обёртка.

#[cfg(target_os = "macos")]
extern "C" {
    fn stardust_configure_macos_titlebar(ns_window: *mut std::ffi::c_void);
}

/// Применяет геометрию нативной шапки. Вызывать на главном потоке ПОСЛЕ
/// применения нативных масок окна (async main-queue в tao), чтобы AppKit
/// не перетёр раскладку своим автолейаутом.
#[cfg(target_os = "macos")]
pub fn apply(window: &tauri::WebviewWindow) {
    match window.ns_window() {
        Ok(ns_window) => unsafe { stardust_configure_macos_titlebar(ns_window) },
        Err(error) => tracing::warn!("failed to get NSWindow for titlebar layout: {error}"),
    }
}

#[cfg(not(target_os = "macos"))]
pub fn apply(_window: &tauri::WebviewWindow) {}
