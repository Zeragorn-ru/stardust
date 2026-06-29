#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#![allow(static_mut_refs)]

use std::mem;
use std::os::windows::ffi::OsStrExt;
use std::path::PathBuf;
use std::ptr;
use std::ffi::OsStr;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Graphics::Gdi::*;
use windows_sys::Win32::System::LibraryLoader::{GetModuleHandleW, GetModuleFileNameW};
use windows_sys::Win32::System::Performance::{QueryPerformanceCounter, QueryPerformanceFrequency};
use windows_sys::Win32::System::Threading::{CreateProcessW, WaitForSingleObject, STARTUPINFOW, PROCESS_INFORMATION};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::ReleaseCapture;
use windows_sys::Win32::UI::WindowsAndMessaging::*;

// ── Design tokens (matching launcher CSS) ────────────────────────────
const BG_DEEP: COLORREF = 0x000F0B0A;
const BG_PANEL: COLORREF = 0x00191C28;
const GLASS_BORDER: COLORREF = 0x0014161F;
const TEXT_COL: COLORREF = 0x00F6F0EE;
const MUTED: COLORREF = 0x00B5A09A;
const ACCENT: COLORREF = 0x00FF5C7C;
const PROGRESS_BG: COLORREF = 0x00282A3A;

const WIN_W: i32 = 380;
const WIN_H: i32 = 160;
const PROGRESS_H: i32 = 5;
const PROGRESS_Y: i32 = 95;
const PROGRESS_X: i32 = 40;
const PROGRESS_W: i32 = WIN_W - 80;

#[derive(PartialEq)]
enum Phase {
    Installing,
    Launching,
    Done,
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
}

static mut STATE: Option<State> = None;

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

/// Run the NSIS installer silently and return the process handle.
unsafe fn run_installer(installer: &std::path::Path, install_dir: &std::path::Path) -> Option<HANDLE> {
    let inst_path = install_dir.to_str().unwrap_or("");
    let args = format!("/S /D={}", inst_path);
    let cmd_line = format!("\"{}\" {}", installer.to_str().unwrap_or(""), args);
    let cmd_w = wide(&cmd_line);

    let mut si = mem::zeroed::<STARTUPINFOW>();
    si.cb = mem::size_of::<STARTUPINFOW>() as u32;
    let mut pi = mem::zeroed::<PROCESS_INFORMATION>();

    if CreateProcessW(
        ptr::null(),
        cmd_w.as_ptr() as *mut u16,
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
        Some(pi.hProcess)
    } else {
        None
    }
}

/// Launch the launcher executable.
unsafe fn launch_launcher(exe: &std::path::Path) -> bool {
    let path_w = wide(exe.to_str().unwrap_or("StarDust.exe"));
    let mut si = mem::zeroed::<STARTUPINFOW>();
    si.cb = mem::size_of::<STARTUPINFOW>() as u32;
    let mut pi = mem::zeroed::<PROCESS_INFORMATION>();
    if CreateProcessW(
        path_w.as_ptr(),
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
        CloseHandle(pi.hProcess);
        CloseHandle(pi.hThread);
        true
    } else {
        false
    }
}

unsafe fn paint(hdc: HDC, hwnd: HWND) {
    let mut rc = mem::zeroed::<RECT>();
    GetClientRect(hwnd, &mut rc);
    let w = rc.right - rc.left;
    let h = rc.bottom - rc.top;

    let mem_dc = CreateCompatibleDC(hdc);
    let bmp = CreateCompatibleBitmap(hdc, w, h);
    let old_bmp = SelectObject(mem_dc, bmp);

    // ── Background ──
    let bg_brush = CreateSolidBrush(BG_DEEP);
    FillRect(mem_dc, &rc, bg_brush);
    DeleteObject(bg_brush as _);

    // ── Inner panel ──
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

    // ── Top accent line ──
    let pen = CreatePen(PS_SOLID, 2, ACCENT);
    let old_pen = SelectObject(mem_dc, pen);
    MoveToEx(mem_dc, 30, 2, ptr::null_mut());
    LineTo(mem_dc, w - 30, 2);
    SelectObject(mem_dc, old_pen);
    DeleteObject(pen as _);

    // ── Brand ──
    SetBkMode(mem_dc, TRANSPARENT as i32);

    let dot_brush = CreateSolidBrush(ACCENT);
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

    // ── Status text ──
    let state = STATE.as_ref().unwrap();

    let status_text;
    let status_color;
    match state.phase {
        Phase::Installing => {
            status_text = wide("Установка обновления...");
            status_color = TEXT_COL;
        }
        Phase::Launching => {
            status_text = wide("Запуск...");
            status_color = TEXT_COL;
        }
        Phase::Done => {
            status_text = wide("Готово!");
            status_color = ACCENT;
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

    // ── Sub-text ──
    let hfont_sub = CreateFontW(
        12, 0, 0, 0, 400, 0, 0, 0,
        DEFAULT_CHARSET as u32, 0, 0, CLEARTYPE_QUALITY as u32, 0,
        segui.as_ptr(),
    );
    let old_font = SelectObject(mem_dc, hfont_sub);
    SetTextColor(mem_dc, MUTED);
    let sub = wide("Пожалуйста, подождите");
    TextOutW(mem_dc, 40, 73, sub.as_ptr(), sub.len() as i32 - 1);
    SelectObject(mem_dc, old_font);
    DeleteObject(hfont_sub as _);

    // ── Progress bar ──
    let progress_fraction: f64 = match state.phase {
        Phase::Done => 1.0,
        Phase::Launching => 0.95,
        Phase::Installing => {
            // Indeterminate pulse while installer runs
            let phase = (state.ticks as f64 * 0.08).sin() * 0.5 + 0.5;
            0.4 + phase * 0.3
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

        let fill_brush = CreateSolidBrush(ACCENT);
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

    // ── Bottom separator ──
    let sep_pen = CreatePen(PS_SOLID, 1, GLASS_BORDER);
    let old_pen = SelectObject(mem_dc, sep_pen);
    MoveToEx(mem_dc, 15, h - 30, ptr::null_mut());
    LineTo(mem_dc, w - 15, h - 30);
    SelectObject(mem_dc, old_pen);
    DeleteObject(sep_pen as _);

    // ── Version text ──
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

            // Start installer immediately
            let installer_path = state.installer_path.clone();
            let install_dir = state.install_dir.clone();
            if let Some(handle) = run_installer(&installer_path, &install_dir) {
                state.installer_handle = Some(handle);
                state.installer_start_ms = now_ms();
                state.phase = Phase::Installing;
            } else {
                // Installer failed to start — try launching directly
                state.phase = Phase::Launching;
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
                    // Check if installer process exited
                    if let Some(handle) = state.installer_handle {
                        let result = WaitForSingleObject(handle, 0);
                        if result == WAIT_OBJECT_0 {
                            // Installer finished
                            CloseHandle(handle);
                            state.installer_handle = None;
                            state.phase = Phase::Launching;
                        }
                    }
                }
                Phase::Launching => {
                    let launcher_path = state.launcher_path.clone();
                    if launch_launcher(&launcher_path) {
                        state.phase = Phase::Done;
                        state.close_at = now_ms() + 600;
                    }
                }
                Phase::Done if state.close_at > 0 && now_ms() >= state.close_at => {
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
            PostQuitMessage(0);
            0
        }

        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

#[cfg(target_os = "windows")]
fn main() {
    let args: Vec<String> = std::env::args().collect();

    // Expected: bootstrap.exe <installer_path> <install_dir>
    // If no args, fall back to launching StarDust.exe from own directory (NSIS mode)
    let (installer_path, install_dir) = if args.len() >= 3 {
        (PathBuf::from(&args[1]), PathBuf::from(&args[2]))
    } else {
        // Standalone / NSIS mode: just wait briefly then launch launcher
        let dir = unsafe {
            let mut buf = [0u16; 512];
            let len = GetModuleFileNameW(ptr::null_mut(), buf.as_mut_ptr(), 512);
            PathBuf::from(String::from_utf16_lossy(&buf[..len as usize]))
                .parent().unwrap_or(&PathBuf::new()).to_path_buf()
        };
        (PathBuf::new(), dir)
    };

    let launcher_path = install_dir.join("StarDust.exe");

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
            return;
        }

        SetLayeredWindowAttributes(hwnd, 0, 245, LWA_ALPHA);

        ShowWindow(hwnd, SW_SHOW);
        UpdateWindow(hwnd);

        let mut msg = mem::zeroed::<MSG>();
        while GetMessageW(&mut msg, ptr::null_mut(), 0, 0) > 0 {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn main() {
    eprintln!("bootstrap.exe is Windows-only");
}
