#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(static_mut_refs)]

#[cfg(target_os = "windows")]
mod win {
    use std::mem;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr;
    use std::ffi::OsStr;
    use std::fs::OpenOptions;
    use std::io::Write;

    use windows_sys::Win32::Foundation::*;
    use windows_sys::Win32::Graphics::Gdi::*;
    use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetModuleFileNameW};
    use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
    use windows_sys::Win32::System::Threading::{CreateProcessW, WaitForSingleObject, STARTUPINFOW, PROCESS_INFORMATION, GetExitCodeProcess};
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::*;

    const BG_DEEP: COLORREF = 0x000F0B0A;
    const BG_PANEL: COLORREF = 0x00191C28;
    const GLASS_BORDER: COLORREF = 0x0014161F;
    const TEXT_COL: COLORREF = 0x00F6F0EE;
    const MUTED: COLORREF = 0x00B5A09A;
    const PROGRESS_BG: COLORREF = 0x00282A3A;
    const PROGRESS_FG: COLORREF = 0x00F6F0EE;

    const WIN_W: i32 = 380;
    const WIN_H: i32 = 160;
    const PROGRESS_H: i32 = 5;
    const PROGRESS_Y: i32 = 95;
    const PROGRESS_X: i32 = 40;
    const PROGRESS_W: i32 = WIN_W - 80;

    #[derive(PartialEq)]
    #[allow(dead_code)]
    enum Phase {
        Installing,
        Launching,
        Done,
        Error,
    }

    struct State {
        launcher_path: PathBuf,
        installer_path: PathBuf,
        install_dir: PathBuf,
        installer_handle: Option<HANDLE>,
        phase: Phase,
        start_ms: u64,
        installer_start_ms: u64,
        ticks: u32,
        close_at: u64,
        launch_delay_ms: Option<u64>,
        error_msg: Option<String>,
    }

    static mut STATE: Option<State> = None;
    static mut LOG_FILE: Option<std::fs::File> = None;

    fn log(msg: &str) {
        let ts = unsafe { now_ms() };
        let line = format!("[{ts}ms] {msg}\n");
        unsafe {
            if let Some(ref mut f) = LOG_FILE {
                let _ = f.write_all(line.as_bytes());
                let _ = f.flush();
            }
        }
    }

    fn wide(s: &str) -> Vec<u16> {
        OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
    }

    unsafe fn now_ms() -> u64 {
        let mut freq: i64 = 0;
        let mut cnt: i64 = 0;
        QueryPerformanceCounter(&mut cnt);
        QueryPerformanceFrequency(&mut freq);
        (cnt as u64 * 1000) / freq as u64
    }

    unsafe fn last_error() -> u32 {
        windows_sys::Win32::Foundation::GetLastError()
    }

    fn init_log(install_dir: &std::path::Path) {
        let log_path = install_dir.join("bootstrap.log");
        match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            Ok(f) => {
                unsafe { LOG_FILE = Some(f); }
                log("=== Bootstrap started ===");
            }
            Err(e) => {
                eprintln!("bootstrap: cannot open log {}: {e}", log_path.display());
            }
        }
    }

    unsafe fn run_installer(installer: &std::path::Path, install_dir: &std::path::Path) -> Option<HANDLE> {
        let inst_path = install_dir.to_str().unwrap_or("");
        let args = format!("/S /D={inst_path}");
        let cmd_line = format!("\"{}\" {args}", installer.to_str().unwrap_or(""));

        log(&format!("run_installer: cmd_line={cmd_line}"));
        log(&format!("run_installer: installer.exists={}", installer.exists()));
        log(&format!("run_installer: install_dir={inst_path}"));
        log(&format!("run_installer: install_dir.exists={}", install_dir.exists()));

        let cmd_w = wide(&cmd_line);

        let mut si = mem::zeroed::<STARTUPINFOW>();
        si.cb = mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi = mem::zeroed::<PROCESS_INFORMATION>();

        let ok = CreateProcessW(
            ptr::null(),           // lpApplicationName = NULL
            cmd_w.as_ptr() as *mut u16,  // lpCommandLine
            ptr::null(),
            ptr::null(),
            0,
            0,
            ptr::null(),
            ptr::null(),
            &si,
            &mut pi,
        );
        if ok != 0 {
            log(&format!("run_installer: CreateProcessW OK, hProcess={:?}", pi.hProcess));
            Some(pi.hProcess)
        } else {
            let err = last_error();
            log(&format!("run_installer: CreateProcessW FAILED, GetLastError={err}"));
            None
        }
    }

    unsafe fn launch_launcher(exe: &std::path::Path) -> bool {
        let exe_str = exe.to_str().unwrap_or("");
        log(&format!("launch_launcher: exe={exe_str}"));
        log(&format!("launch_launcher: exe.exists={}", exe.exists()));

        if !exe.exists() {
            log("launch_launcher: file does not exist, returning false");
            return false;
        }

        // Попытка 1: lpApplicationName + lpCommandLine (с кавычками).
        let exe_w = wide(exe_str);
        let mut si = mem::zeroed::<STARTUPINFOW>();
        si.cb = mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi = mem::zeroed::<PROCESS_INFORMATION>();

        if CreateProcessW(
            exe_w.as_ptr(),
            ptr::null_mut(),
            ptr::null(),
            ptr::null(),
            0,
            0,
            ptr::null(),
            ptr::null(),
            &si,
            &mut pi,
        ) != 0
        {
            log(&format!("launch_launcher: attempt 1 OK, hProcess={:?}", pi.hProcess));
            CloseHandle(pi.hProcess);
            CloseHandle(pi.hThread);
            return true;
        }
        let err1 = last_error();
        log(&format!("launch_launcher: attempt 1 FAILED, GetLastError={err1}"));

        // Попытка 2: lpCommandLine с кавычками вокруг exe.
        let cmd_line = format!("\"{exe_str}\"");
        let cmd_w = wide(&cmd_line);
        let mut si2 = mem::zeroed::<STARTUPINFOW>();
        si2.cb = mem::size_of::<STARTUPINFOW>() as u32;
        let mut pi2 = mem::zeroed::<PROCESS_INFORMATION>();

        if CreateProcessW(
            ptr::null(),
            cmd_w.as_ptr() as *mut u16,
            ptr::null(),
            ptr::null(),
            0,
            0,
            ptr::null(),
            ptr::null(),
            &si2,
            &mut pi2,
        ) != 0
        {
            log(&format!("launch_launcher: attempt 2 OK, hProcess={:?}", pi2.hProcess));
            CloseHandle(pi2.hProcess);
            CloseHandle(pi2.hThread);
            return true;
        }
        let err2 = last_error();
        log(&format!("launch_launcher: attempt 2 FAILED, GetLastError={err2}"));

        // Попытка 3: ShellExecuteW (открыть exe как файл).
        let shell_ok = ShellExecuteW(
            ptr::null_mut(),
            wide("open").as_ptr(),
            exe_w.as_ptr(),
            ptr::null(),
            ptr::null(),
            1, // SW_SHOWNORMAL
        );
        log(&format!("launch_launcher: attempt 3 (ShellExecuteW) hInst={:?}", shell_ok));
        if (shell_ok as isize) > 32 {
            log("launch_launcher: attempt 3 OK");
            return true;
        }

        log("launch_launcher: ALL ATTEMPTS FAILED");
        false
    }

    unsafe fn paint(hdc: HDC, hwnd: HWND) {
        let mut rc = mem::zeroed::<RECT>();
        GetClientRect(hwnd, &mut rc);
        let w = rc.right - rc.left;
        let h = rc.bottom - rc.top;

        let mem_dc = CreateCompatibleDC(hdc);
        let bmp = CreateCompatibleBitmap(hdc, w, h);
        let old_bmp = SelectObject(mem_dc, bmp);

        let bg_brush = CreateSolidBrush(BG_DEEP);
        FillRect(mem_dc, &rc, bg_brush);
        DeleteObject(bg_brush as _);

        let panel_brush = CreateSolidBrush(BG_PANEL);
        let panel_rgn = CreateRoundRectRgn(1, 35, w - 1, h - 1, 14, 14);
        FillRgn(mem_dc, panel_rgn, panel_brush);
        DeleteObject(panel_rgn as _);
        DeleteObject(panel_brush as _);

        let border_brush = CreateSolidBrush(GLASS_BORDER);
        let border_rgn = CreateRoundRectRgn(1, 35, w - 1, h - 1, 14, 14);
        FrameRgn(mem_dc, border_rgn, border_brush, 1, 1);
        DeleteObject(border_rgn as _);
        DeleteObject(border_brush as _);

        let pen = CreatePen(PS_SOLID, 2, TEXT_COL);
        let old_pen = SelectObject(mem_dc, pen);
        MoveToEx(mem_dc, 30, 2, ptr::null_mut());
        LineTo(mem_dc, w - 30, 2);
        SelectObject(mem_dc, old_pen);
        DeleteObject(pen as _);

        SetBkMode(mem_dc, TRANSPARENT as i32);

        let dot_brush = CreateSolidBrush(TEXT_COL);
        let dot_rgn = CreateEllipticRgn(20, 14, 30, 24);
        FillRgn(mem_dc, dot_rgn, dot_brush);
        DeleteObject(dot_rgn as _);
        DeleteObject(dot_brush as _);

        let segui = wide("Segoe UI");
        let hfont_brand = CreateFontW(
            13, 0, 0, 0, 700, 0, 0, 0,
            DEFAULT_CHARSET as u32, 0, 0, CLEARTYPE_QUALITY as u32, 0,
            segui.as_ptr(),
        );
        let old_font = SelectObject(mem_dc, hfont_brand);
        SetTextColor(mem_dc, MUTED);
        let brand = wide("STARDUST");
        TextOutW(mem_dc, 36, 12, brand.as_ptr(), 8);
        SelectObject(mem_dc, old_font);
        DeleteObject(hfont_brand as _);

        let state = STATE.as_ref().unwrap();

        let status_text;
        let status_color;
        match state.phase {
            Phase::Installing => {
                status_text = wide("Установка обновления...");
                status_color = TEXT_COL;
            }
            Phase::Launching => {
                status_text = wide("Запуск лаунчера...");
                status_color = TEXT_COL;
            }
            Phase::Done => {
                status_text = wide("Готово!");
                status_color = TEXT_COL;
            }
            Phase::Error => {
                status_text = wide("Ошибка обновления");
                status_color = 0x004444FF; // красный
            }
        }

        let hfont_main = CreateFontW(
            20, 0, 0, 0, 400, 0, 0, 0,
            DEFAULT_CHARSET as u32, 0, 0, CLEARTYPE_QUALITY as u32, 0,
            segui.as_ptr(),
        );
        let old_font = SelectObject(mem_dc, hfont_main);
        SetTextColor(mem_dc, status_color);
        TextOutW(mem_dc, 40, 48, status_text.as_ptr(), status_text.len() as i32 - 1);
        SelectObject(mem_dc, old_font);
        DeleteObject(hfont_main as _);

        let sub_text = match state.phase {
            Phase::Error => state.error_msg.as_deref().unwrap_or("Неизвестная ошибка"),
            _ => "Пожалуйста, подождите",
        };
        let hfont_sub = CreateFontW(
            12, 0, 0, 0, 400, 0, 0, 0,
            DEFAULT_CHARSET as u32, 0, 0, CLEARTYPE_QUALITY as u32, 0,
            segui.as_ptr(),
        );
        let old_font = SelectObject(mem_dc, hfont_sub);
        SetTextColor(mem_dc, MUTED);
        let sub_w = wide(sub_text);
        TextOutW(mem_dc, 40, 73, sub_w.as_ptr(), sub_w.len() as i32 - 1);
        SelectObject(mem_dc, old_font);
        DeleteObject(hfont_sub as _);

        let progress_fraction: f64 = match state.phase {
            Phase::Done => 1.0,
            Phase::Launching => 0.9,
            Phase::Error => 0.0,
            Phase::Installing => {
                let elapsed = now_ms() - state.installer_start_ms;
                let t = (elapsed as f64 / 1000.0).min(1.0);
                0.1 + t.sqrt() * 0.75
            }
        };

        let pb_brush = CreateSolidBrush(PROGRESS_BG);
        let pb_rgn = CreateRoundRectRgn(
            PROGRESS_X, PROGRESS_Y,
            PROGRESS_X + PROGRESS_W, PROGRESS_Y + PROGRESS_H,
            3, 3,
        );
        FillRgn(mem_dc, pb_rgn, pb_brush);
        DeleteObject(pb_rgn as _);
        DeleteObject(pb_brush as _);

        let fill_w = ((PROGRESS_W as f64) * progress_fraction) as i32;
        if fill_w > 2 {
            let clip_rgn = CreateRoundRectRgn(
                PROGRESS_X, PROGRESS_Y,
                PROGRESS_X + PROGRESS_W, PROGRESS_Y + PROGRESS_H,
                3, 3,
            );
            SelectClipRgn(mem_dc, clip_rgn);

            let fill_brush = CreateSolidBrush(PROGRESS_FG);
            let fill_rect = RECT {
                left: PROGRESS_X,
                top: PROGRESS_Y,
                right: PROGRESS_X + fill_w,
                bottom: PROGRESS_Y + PROGRESS_H,
            };
            FillRect(mem_dc, &fill_rect, fill_brush);
            DeleteObject(fill_brush as _);

            SelectClipRgn(mem_dc, ptr::null_mut());
            DeleteObject(clip_rgn as _);
        }

        let sep_pen = CreatePen(PS_SOLID, 1, GLASS_BORDER);
        let old_pen = SelectObject(mem_dc, sep_pen);
        MoveToEx(mem_dc, 15, h - 30, ptr::null_mut());
        LineTo(mem_dc, w - 15, h - 30);
        SelectObject(mem_dc, old_pen);
        DeleteObject(sep_pen as _);

        let hfont_ver = CreateFontW(
            11, 0, 0, 0, 400, 0, 0, 0,
            DEFAULT_CHARSET as u32, 0, 0, CLEARTYPE_QUALITY as u32, 0,
            segui.as_ptr(),
        );
        let old_font = SelectObject(mem_dc, hfont_ver);
        SetTextColor(mem_dc, MUTED);
        let ver = wide("StarDust Launcher");
        TextOutW(mem_dc, 18, h - 25, ver.as_ptr(), ver.len() as i32 - 1);
        SelectObject(mem_dc, old_font);
        DeleteObject(hfont_ver as _);

        BitBlt(hdc, 0, 0, w, h, mem_dc, 0, 0, SRCCOPY);
        SelectObject(mem_dc, old_bmp);
        DeleteObject(bmp as _);
        DeleteDC(mem_dc);
    }

    unsafe extern "system" fn wnd_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        match msg {
            WM_CREATE => {
                let rgn = CreateRoundRectRgn(0, 0, WIN_W, WIN_H, 24, 24);
                SetWindowRgn(hwnd, rgn, 0);

                SetTimer(hwnd, 1, 33, None);
                let state = STATE.as_mut().unwrap();
                state.start_ms = now_ms();

                let installer_path = state.installer_path.clone();
                let install_dir = state.install_dir.clone();

                log(&format!("WM_CREATE: installer={}", installer_path.display()));
                log(&format!("WM_CREATE: install_dir={}", install_dir.display()));

                if installer_path.exists() {
                    log("WM_CREATE: installer exists, running...");
                    if let Some(handle) = run_installer(&installer_path, &install_dir) {
                        state.installer_handle = Some(handle);
                        state.installer_start_ms = now_ms();
                        state.phase = Phase::Installing;
                        log("WM_CREATE: phase = Installing");
                    } else {
                        log("WM_CREATE: run_installer returned None, phase = Launching");
                        state.phase = Phase::Launching;
                        state.launch_delay_ms = Some(500);
                    }
                } else {
                    log("WM_CREATE: installer not found, phase = Launching");
                    state.phase = Phase::Launching;
                    state.launch_delay_ms = Some(500);
                }

                0
            }

            WM_PAINT => {
                let mut ps = mem::zeroed::<PAINTSTRUCT>();
                let hdc = BeginPaint(hwnd, &mut ps);
                paint(hdc, hwnd);
                EndPaint(hwnd, &ps);
                0
            }

            WM_TIMER => {
                let state = STATE.as_mut().unwrap();
                state.ticks += 1;

                match state.phase {
                    Phase::Installing => {
                        if let Some(handle) = state.installer_handle {
                            let result = WaitForSingleObject(handle, 0);
                            if result == WAIT_OBJECT_0 {
                                let mut exit_code: u32 = 0;
                                GetExitCodeProcess(handle, &mut exit_code);
                                log(&format!("NSIS process exited with code {exit_code}"));
                                CloseHandle(handle);
                                state.installer_handle = None;
                                state.launch_delay_ms = Some(1500);
                                state.phase = Phase::Launching;
                                log("Phase -> Launching (waiting 1500ms)");
                            }
                        }
                    }
                    Phase::Launching => {
                        if let Some(remaining) = state.launch_delay_ms {
                            if remaining > 0 {
                                let step = 33.min(remaining);
                                state.launch_delay_ms = Some(remaining - step);
                                let mut rc = mem::zeroed::<RECT>();
                                GetClientRect(hwnd, &mut rc);
                                InvalidateRect(hwnd, &rc, 0);
                                return 0;
                            }
                        }
                        let launcher_path = state.launcher_path.clone();
                        if !launcher_path.exists() {
                            if state.ticks % 30 == 1 {
                                log(&format!("WM_TIMER: waiting for {}", launcher_path.display()));
                            }
                            let mut rc = mem::zeroed::<RECT>();
                            GetClientRect(hwnd, &mut rc);
                            InvalidateRect(hwnd, &rc, 0);
                            return 0;
                        }
                        log(&format!("WM_TIMER: attempting launch of {}", launcher_path.display()));
                        if launch_launcher(&launcher_path) {
                            log("WM_TIMER: launch succeeded! Phase -> Done");
                            state.phase = Phase::Done;
                            state.close_at = now_ms() + 500;
                        } else {
                            log("WM_TIMER: launch_launcher returned false, will retry next tick");
                        }
                    }
                    Phase::Done if state.close_at > 0 && now_ms() >= state.close_at => {
                        log("Phase::Done, closing window");
                        DestroyWindow(hwnd);
                        return 0;
                    }
                    _ => {}
                }

                let mut rc = mem::zeroed::<RECT>();
                GetClientRect(hwnd, &mut rc);
                InvalidateRect(hwnd, &rc, 0);
                0
            }

            WM_LBUTTONDOWN => {
                ReleaseCapture();
                SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION as WPARAM, 0);
                0
            }

            WM_DESTROY => {
                KillTimer(hwnd, 1);
                log("WM_DESTROY, PostQuitMessage");
                PostQuitMessage(0);
                0
            }

            _ => DefWindowProcW(hwnd, msg, wparam, lparam),
        }
    }

    pub fn run() {
        let args: Vec<String> = std::env::args().collect();
        log(&format!("args: {args:?}"));

        let (installer_path, install_dir, exe_name) = if args.len() >= 4 {
            // Аргументы: <installer> <install_dir> <exe_name>
            (
                PathBuf::from(&args[1]),
                PathBuf::from(&args[2]),
                args[3].clone(),
            )
        } else if args.len() >= 3 {
            (
                PathBuf::from(&args[1]),
                PathBuf::from(&args[2]),
                "launcher.exe".to_string(),
            )
        } else {
            let dir = unsafe {
                let mut buf = [0u16; 512];
                let len = GetModuleFileNameW(ptr::null_mut(), buf.as_mut_ptr(), 512);
                PathBuf::from(String::from_utf16_lossy(&buf[..len as usize]))
                    .parent().unwrap_or(&PathBuf::new()).to_path_buf()
            };
            log(&format!("no args, fallback dir={}", dir.display()));
            (PathBuf::new(), dir, "launcher.exe".to_string())
        };

        init_log(&install_dir);

        log(&format!("installer_path={}", installer_path.display()));
        log(&format!("install_dir={}", install_dir.display()));
        log(&format!("exe_name={exe_name}"));

        let launcher_path = install_dir.join(&exe_name);
        log(&format!("launcher_path={}", launcher_path.display()));
        log(&format!("launcher_path.exists={}", launcher_path.exists()));

        unsafe {
            STATE = Some(State {
                launcher_path,
                installer_path: installer_path.clone(),
                install_dir: install_dir.clone(),
                installer_handle: None,
                phase: if installer_path.exists() {
                    Phase::Installing
                } else {
                    Phase::Launching
                },
                start_ms: 0,
                installer_start_ms: 0,
                ticks: 0,
                close_at: 0,
                launch_delay_ms: None,
                error_msg: None,
            });

            let class = wide("StarDustBootstrap");
            let h_inst = GetModuleHandleW(class.as_ptr());

            let mut wc = mem::zeroed::<WNDCLASSEXW>();
            wc.cbSize = mem::size_of::<WNDCLASSEXW>() as u32;
            wc.style = CS_HREDRAW | CS_VREDRAW;
            wc.lpfnWndProc = Some(wnd_proc);
            wc.hInstance = h_inst;
            wc.lpszClassName = class.as_ptr();
            wc.hbrBackground = CreateSolidBrush(BG_DEEP);
            wc.hCursor = LoadCursorW(ptr::null_mut(), IDC_ARROW);
            RegisterClassExW(&wc);

            let screen_w = GetSystemMetrics(SM_CXSCREEN);
            let screen_h = GetSystemMetrics(SM_CYSCREEN);
            let x = (screen_w - WIN_W) / 2;
            let y = (screen_h - WIN_H) / 2;

            let title = wide("StarDust");
            let hwnd = CreateWindowExW(
                WS_EX_TOPMOST | WS_EX_LAYERED,
                class.as_ptr(),
                title.as_ptr(),
                WS_POPUP | WS_VISIBLE,
                x,
                y,
                WIN_W,
                WIN_H,
                ptr::null_mut(),
                ptr::null_mut(),
                h_inst,
                ptr::null(),
            );

            if hwnd.is_null() {
                log("CreateWindowExW returned NULL");
                return;
            }

            SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA);

            ShowWindow(hwnd, SW_SHOW);
            UpdateWindow(hwnd);
            log("Window created, entering message loop");

            let mut msg = mem::zeroed::<MSG>();
            while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            log("Message loop exited");
        }
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    win::run();

    #[cfg(not(target_os = "windows"))]
    eprintln!("bootstrap.exe is Windows-only");
}
