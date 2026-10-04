// Island shell. Overlay behaviour still UNVERIFIED on Windows: see docs/SPIKE_OVERLAY.md for the checklist.
// Keep this shell thin (ADR-0002): window management, OS APIs and the sidecar's lifecycle only, no business logic.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launch;
mod sidecar;

use sidecar::{Relay, SidecarMessage};
use std::path::PathBuf;
use tauri::ipc::Channel;
use tauri::{Manager, PhysicalPosition, RunEvent, State};

/// Logical width of the island window (tauri.conf.json, and `fitWindowTo` in App.tsx).
const ISLAND_WIDTH: f64 = 420.0;

/// The island window is transparent and always-on-top. Empty transparent pixels must not
/// steal clicks from apps underneath; that per-pixel hit-testing is the main thing the
/// spike must validate (see docs/SPIKE_OVERLAY.md).
#[tauri::command]
fn set_click_through(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
    window.set_ignore_cursor_events(enabled).map_err(|e| e.to_string())
}

/// Session token the UI sends in its `hello` (ADR-0008). Only this app's own pages can call commands.
#[tauri::command]
fn sidecar_token(relay: State<'_, Relay>) -> String {
    relay.token().to_string()
}

/// (Re)starts the sidecar; its stdout lines and its exit arrive on `on_message`. Returns the generation to address it.
#[tauri::command]
async fn sidecar_start(relay: State<'_, Relay>, on_message: Channel<SidecarMessage>) -> Result<u64, String> {
    relay.start(on_message)
}

#[tauri::command]
async fn sidecar_send(relay: State<'_, Relay>, generation: u64, line: String) -> Result<(), String> {
    relay.send(generation, &line)
}

#[tauri::command]
async fn sidecar_stop(relay: State<'_, Relay>, generation: u64) -> Result<(), String> {
    relay.stop(generation);
    Ok(())
}

fn build_relay() -> Relay {
    let exe_dir = std::env::current_exe().ok().and_then(|p| p.parent().map(PathBuf::from));
    // Debug builds run from the source tree, so the repo's bundle is a sensible default there.
    let dev_root = if cfg!(debug_assertions) { Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")) } else { None };
    let launch = launch::resolve_launch(|k| std::env::var(k).ok(), exe_dir.as_deref(), dev_root.as_deref());
    if let Err(e) = &launch {
        eprintln!("[jarvis] {e}");
    }
    let log_path = std::env::var_os("JARVIS_DATA_DIR").map(|d| PathBuf::from(d).join("sidecar.log"));
    let token = launch::new_token().expect("OS randomness");
    Relay::new(token, launch, log_path)
}

fn main() {
    let app = tauri::Builder::default()
        .manage(build_relay())
        .invoke_handler(tauri::generate_handler![set_click_through, sidecar_token, sidecar_start, sidecar_send, sidecar_stop])
        .setup(|app| {
            // Center horizontally at the top of the primary monitor. The height follows the island (see src/shell/window-fit.ts).
            if let Some(win) = app.get_webview_window("island") {
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let size = monitor.size();
                    // Some platforms report 0 before the window is shown: fall back to the configured 420 logical px.
                    let fallback = (ISLAND_WIDTH * monitor.scale_factor()).round() as u32;
                    let win_w = win.outer_size().map(|s| s.width).ok().filter(|w| *w > 0).unwrap_or(fallback);
                    let x = (size.width.saturating_sub(win_w) / 2) as i32;
                    let _ = win.set_position(PhysicalPosition::new(x, 8));
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building JARVIS");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            app.state::<Relay>().shutdown();
        }
    });
}
