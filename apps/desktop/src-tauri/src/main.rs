// Phase 0 overlay spike. UNVERIFIED on Windows: see docs/SPIKE_OVERLAY.md for the checklist.
// Keep this shell thin (ADR-0002): window management and OS APIs only, no business logic.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{Manager, PhysicalPosition};

/// The island window is transparent and always-on-top. Empty transparent pixels must not
/// steal clicks from apps underneath; that per-pixel hit-testing is the main thing the
/// spike must validate (see docs/SPIKE_OVERLAY.md).
#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(enabled).map_err(|e| e.to_string())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![set_click_through])
        .setup(|app| {
            // Center horizontally at the top of the primary monitor.
            if let Some(win) = app.get_webview_window("island") {
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let size = monitor.size();
                    let win_w = win.outer_size().map(|s| s.width).unwrap_or(0);
                    let x = (size.width.saturating_sub(win_w) / 2) as i32;
                    let _ = win.set_position(PhysicalPosition::new(x, 8));
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running JARVIS");
}
