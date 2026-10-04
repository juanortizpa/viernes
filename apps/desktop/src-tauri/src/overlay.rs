//! Per-region click-through (docs/SPIKE_OVERLAY.md, test 4). The island window is transparent: outside the island and its
//! dock, clicks must reach the apps underneath. The webview reports where its interactive parts are (CSS px); a poller
//! compares them with the OS cursor and makes the whole window ignore the mouse while the cursor is elsewhere.
//! OS plumbing only: which parts are interactive is decided by the UI.

use serde::Deserialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::WebviewWindow;

/// A rectangle in CSS (logical) pixels, relative to the window's content.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// Slack around each region so the cursor does not flicker between modes on an edge.
const PAD: f64 = 4.0;
const POLL: Duration = Duration::from_millis(40);

/// True when the logical point (x, y) falls on an interactive region.
pub fn hits(rects: &[Rect], x: f64, y: f64) -> bool {
    rects.iter().any(|r| x >= r.x - PAD && x <= r.x + r.w + PAD && y >= r.y - PAD && y <= r.y + r.h + PAD)
}

/// Whether the window should take mouse input. Until the UI reports its regions (None), it always does:
/// a UI that failed to start must never become impossible to click.
pub fn interactive(regions: Option<&[Rect]>, hold: bool, cursor: Option<(f64, f64)>) -> bool {
    match (regions, cursor) {
        (None, _) | (_, None) => true,
        _ if hold => true,
        (Some(rects), Some((x, y))) => hits(rects, x, y),
    }
}

pub struct HitRegions {
    regions: Mutex<Option<Vec<Rect>>>,
    /// A pointer is pressed inside the UI (e.g. push-to-talk held): keep the mouse even if it drifts out.
    hold: AtomicBool,
    pub enabled: bool,
}

impl HitRegions {
    pub fn new(enabled: bool) -> Self {
        Self { regions: Mutex::new(None), hold: AtomicBool::new(false), enabled }
    }

    pub fn set(&self, rects: Vec<Rect>, hold: bool) {
        if let Ok(mut r) = self.regions.lock() {
            *r = Some(rects);
        }
        self.hold.store(hold, Ordering::Relaxed);
    }
}

/// Cursor position in logical px relative to the window content, if the platform can tell.
fn cursor_in(window: &WebviewWindow) -> Option<(f64, f64)> {
    let cursor = window.cursor_position().ok()?;
    let origin = window.inner_position().ok()?;
    let scale = window.scale_factor().ok()?;
    Some(((cursor.x - origin.x as f64) / scale, (cursor.y - origin.y as f64) / scale))
}

pub fn spawn_poller(window: WebviewWindow, state: Arc<HitRegions>) {
    if !state.enabled {
        return;
    }
    thread::spawn(move || {
        let mut current = true; // windows start taking the mouse
        loop {
            thread::sleep(POLL);
            if !window.is_visible().unwrap_or(false) {
                continue;
            }
            let want = {
                let regions = state.regions.lock().ok();
                let rects = regions.as_ref().and_then(|r| r.as_deref());
                interactive(rects, state.hold.load(Ordering::Relaxed), cursor_in(&window))
            };
            if want != current && window.set_ignore_cursor_events(!want).is_ok() {
                current = want;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    const ISLAND: Rect = Rect { x: 122.0, y: 8.0, w: 176.0, h: 48.0 };
    const DOCK: Rect = Rect { x: 50.0, y: 62.0, w: 320.0, h: 44.0 };

    #[test]
    fn only_the_painted_parts_take_the_mouse() {
        let rects = [ISLAND, DOCK];
        assert!(hits(&rects, 200.0, 30.0)); // on the island
        assert!(hits(&rects, 60.0, 80.0)); // on the dock
        assert!(hits(&rects, 119.0, 30.0)); // within the edge slack
        assert!(!hits(&rects, 20.0, 20.0)); // transparent corner
        assert!(!hits(&rects, 200.0, 130.0)); // the shadow margin below the dock
    }

    #[test]
    fn never_locks_the_user_out() {
        // No regions yet, or the platform cannot report the cursor: stay clickable.
        assert!(interactive(None, false, Some((0.0, 0.0))));
        assert!(interactive(Some(&[ISLAND]), false, None));
        // A held pointer keeps the mouse even outside (push-to-talk released over the desktop).
        assert!(interactive(Some(&[ISLAND]), true, Some((0.0, 0.0))));
        assert!(!interactive(Some(&[ISLAND]), false, Some((0.0, 0.0))));
        assert!(!interactive(Some(&[]), false, Some((200.0, 30.0))));
    }
}
