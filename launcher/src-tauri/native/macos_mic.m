#import <AVFoundation/AVFoundation.h>

// Simple Voice Chat проверяет AVAuthorizationStatus из процесса Minecraft.
// Лаунчер должен заранее запросить TCC, пока у .app есть NSMicrophoneUsageDescription
// и com.apple.security.device.audio-input (см. Entitlements.plist).
//
// Внимание: НЕ оборачивать вызовы в @available. Его хелпер
// ___isPlatformVersionAtLeast не линкуется в universal-сборке Tauri
// (Rust линкует с -nodefaultlibs и не тянет clang_rt). Вместо этого
// deployment target нативного файла поднят до 10.14 в build.rs —
// там, где API недоступен, лаунчер всё равно не запускается.

void stardust_request_microphone_access(void) {
    AVAuthorizationStatus status =
        [AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    if (status != AVAuthorizationStatusNotDetermined) {
        return;
    }

    dispatch_semaphore_t sem = dispatch_semaphore_create(0);
    [AVCaptureDevice requestAccessForMediaType:AVMediaTypeAudio
                             completionHandler:^(BOOL granted) {
                               (void)granted;
                               dispatch_semaphore_signal(sem);
                             }];
    dispatch_semaphore_wait(sem, dispatch_time(DISPATCH_TIME_NOW, 120 * NSEC_PER_SEC));
}

int stardust_microphone_authorization_status(void) {
    return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
}
