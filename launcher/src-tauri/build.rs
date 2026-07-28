fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("native/macos_mic.m")
            .flag("-fobjc-arc")
            .compile("macos_mic");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }

    tauri_build::build()
}
