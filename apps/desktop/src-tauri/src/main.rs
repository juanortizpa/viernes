// Island shell. Overlay behaviour still UNVERIFIED on Windows: see docs/SPIKE_OVERLAY.md for the checklist.
// Keep this shell thin (ADR-0002): window management, OS APIs and the sidecar's lifecycle only, no business logic.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod launch;
mod overlay;
mod sidecar;

use overlay::{HitRegions, Rect};
use serde::Serialize;
use sidecar::{Relay, SidecarMessage};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, RunEvent, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Logical width of the island window (tauri.conf.json, and `fitWindowTo` in App.tsx).
const ISLAND_WIDTH: f64 = 420.0;
const ISLAND: &str = "island";
/// Push-to-talk from anywhere, without focusing the island. Not Ctrl+Space: editors (VS Code) and IMEs use it.
const PTT_SHORTCUT: &str = "Ctrl+Alt+Space";

/// What the UI needs to know about the shell (for honest labels and settings).
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellInfo {
    /// The global push-to-talk shortcut, or None if the OS refused it (another app owns it).
    ptt_shortcut: Option<String>,
    click_through: bool,
}

/// Interactive parts of the island (CSS px). Outside them the window lets clicks through; `hold` keeps the mouse while
/// a pointer is pressed in the UI.
#[tauri::command]
fn set_hit_regions(regions: State<'_, Arc<HitRegions>>, rects: Vec<Rect>, hold: bool) {
    regions.set(rects, hold);
}

#[tauri::command]
fn shell_info(info: State<'_, Mutex<ShellInfo>>) -> ShellInfo {
    info.lock().map(|i| i.clone()).unwrap_or(ShellInfo { ptt_shortcut: None, click_through: false })
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

fn show_island(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(ISLAND) {
        let _ = win.show();
    }
}

fn toggle_island(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(ISLAND) {
        let _ = if win.is_visible().unwrap_or(true) { win.hide() } else { win.show() };
    }
}

/// The island has no taskbar button and no title bar: the tray is how you hide it or quit.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Mostrar u ocultar la isla", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Salir de JARVIS", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;
    let mut tray = TrayIconBuilder::with_id("jarvis").tooltip("JARVIS").menu(&menu).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| match event.id.as_ref() {
        "toggle" => toggle_island(app),
        "quit" => app.exit(0), // RunEvent::Exit stops the sidecar cleanly
        _ => {}
    })
    .on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            toggle_island(tray.app_handle());
        }
    })
    .build(app)?;
    Ok(())
}

/// Pressed/released of the global push-to-talk go to the island as `jarvis://ptt` events; the UI owns the microphone.
fn register_ptt(app: &tauri::App) -> Option<String> {
    let shortcut: Shortcut = PTT_SHORTCUT.parse().ok()?;
    let plugin = tauri_plugin_global_shortcut::Builder::new()
        .with_handler(move |app, pressed, event| {
            if pressed == &shortcut {
                let down = event.state() == ShortcutState::Pressed;
                if down {
                    show_island(app); // talking to a hidden island would be invisible progress
                }
                let state = if down { "pressed" } else { "released" };
                let _ = app.emit_to(ISLAND, "jarvis://ptt", state);
            }
        })
        .build();
    if let Err(e) = app.handle().plugin(plugin) {
        eprintln!("[jarvis] global shortcuts unavailable: {e}");
        return None;
    }
    match app.global_shortcut().register(shortcut) {
        Ok(()) => Some(PTT_SHORTCUT.to_string()),
        Err(e) => {
            eprintln!("[jarvis] could not register {PTT_SHORTCUT} (another app may own it): {e}");
            None
        }
    }
}

fn main() {
    // JARVIS_CLICK_THROUGH=0 turns per-region click-through off (debugging the overlay spike).
    let click_through = std::env::var("JARVIS_CLICK_THROUGH").map(|v| v != "0").unwrap_or(true);
    let regions = Arc::new(HitRegions::new(click_through));

    let app = tauri::Builder::default()
        // Must be first: a second launch (island.bat twice) just brings this island back instead of starting another.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show_island(app)))
        .manage(build_relay())
        .manage(Arc::clone(&regions))
        .invoke_handler(tauri::generate_handler![set_hit_regions, shell_info, sidecar_token, sidecar_start, sidecar_send, sidecar_stop])
        .setup(move |app| {
            let ptt = register_ptt(app);
            app.manage(Mutex::new(ShellInfo { ptt_shortcut: ptt, click_through }));
            if let Err(e) = build_tray(app) {
                eprintln!("[jarvis] tray unavailable: {e}");
            }
            if let Some(win) = app.get_webview_window(ISLAND) {
                // The height follows the island (src/shell/window-fit.ts); allow it to shrink below the configured one.
                let _ = win.set_min_size(Some(LogicalSize::new(ISLAND_WIDTH, 60.0)));
                // Center horizontally at the top of the primary monitor.
                if let Ok(Some(monitor)) = win.primary_monitor() {
                    let size = monitor.size();
                    // Some platforms report 0 before the window is shown: fall back to the configured 420 logical px.
                    let fallback = (ISLAND_WIDTH * monitor.scale_factor()).round() as u32;
                    let win_w = win.outer_size().map(|s| s.width).ok().filter(|w| *w > 0).unwrap_or(fallback);
                    let x = (size.width.saturating_sub(win_w) / 2) as i32;
                    let _ = win.set_position(PhysicalPosition::new(x, 8));
                }
                overlay::spawn_poller(win, Arc::clone(&regions));
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
