#import <AVFoundation/AVFoundation.h>

// Simple Voice Chat проверяет AVAuthorizationStatus из процесса Minecraft.
// Лаунчер должен заранее запросить TCC, пока у .app есть NSMicrophoneUsageDescription
// и com.apple.security.device.audio-input (см. Entitlements.plist).
void stardust_request_microphone_access(void) {
    if (@available(macOS 10.14, *)) {
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
}

int stardust_microphone_authorization_status(void) {
    if (@available(macOS 10.14, *)) {
        return (int)[AVCaptureDevice authorizationStatusForMediaType:AVMediaTypeAudio];
    }
    return 3; // authorized — до 10.14 TCC для микрофона не требовался
}
