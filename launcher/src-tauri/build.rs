fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("native/macos_mic.m")
            .flag("-fobjc-arc")
            // AVAuthorizationStatus требует macOS 10.14, а у tao/tauri
            // deployment target 10.13. Поднимаем только для нативного файла:
            // ниже 10.14 голосовой чат всё равно не работает, а дефолт
            // порождает каскад -Wunguarded-availability-new.
            .flag("-mmacosx-version-min=10.14")
            .compile("macos_mic");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }

    tauri_build::build()
}
