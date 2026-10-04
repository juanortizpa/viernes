//! Sidecar relay (ADR-0002/0008/0021): spawns the TypeScript core and pipes its NDJSON stdio to the webview.
//! No business logic and no parsing here: lines go through untouched; the sidecar checks the token itself.
//! One sidecar per UI connection, like the dev bridge. Every start gets a new `generation` so a late message
//! from a previous process (reload, retry) can never reach or kill the current one.

use crate::launch::Launch;
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

/// What the webview receives on the channel it passed to `sidecar_start`.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SidecarMessage {
    Line { line: String },
    Exit { code: Option<i32> },
}

struct Running {
    generation: u64,
    child: Arc<Mutex<Child>>,
    stdin: ChildStdin,
}

#[derive(Default)]
struct State {
    next_generation: u64,
    running: Option<Running>,
}

pub struct Relay {
    token: String,
    launch: Result<Launch, String>,
    log_path: Option<PathBuf>,
    state: Mutex<State>,
}

/// Grace period for a clean exit (stdin EOF makes the sidecar close its SQLite stores) before killing it.
const GRACE: Duration = Duration::from_secs(2);
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

impl Relay {
    pub fn new(token: String, launch: Result<Launch, String>, log_path: Option<PathBuf>) -> Self {
        Self { token, launch, log_path, state: Mutex::new(State::default()) }
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// Stops any previous sidecar and starts a fresh one whose stdout lines go to `channel`. Returns its generation.
    pub fn start(&self, channel: Channel<SidecarMessage>) -> Result<u64, String> {
        let launch = self.launch.as_ref().map_err(Clone::clone)?;
        let mut state = self.state.lock().map_err(|_| "estado del relevo corrupto".to_string())?;
        if let Some(old) = state.running.take() {
            stop_in_background(old);
        }

        let mut cmd = Command::new(&launch.node);
        cmd.arg(&launch.script)
            .current_dir(&launch.cwd)
            .env("JARVIS_TOKEN", &self.token)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000; // no console window flashing up behind the island
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| {
            format!("no pude lanzar el sidecar con «{}»: {e}. ¿Está Node.js 22.13+ en el PATH? (o define JARVIS_NODE)", launch.node.display())
        })?;
        let (Some(stdin), Some(stdout), Some(stderr)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            let _ = child.kill();
            return Err("el sidecar arrancó sin stdio".into());
        };

        state.next_generation += 1;
        let generation = state.next_generation;
        let child = Arc::new(Mutex::new(child));

        let reaper = Arc::clone(&child);
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if channel.send(SidecarMessage::Line { line }).is_err() {
                    break; // the webview is gone
                }
            }
            let code = wait_for(&reaper, GRACE);
            let _ = channel.send(SidecarMessage::Exit { code });
        });

        let log = self.log_path.clone();
        thread::spawn(move || {
            let mut file = log.and_then(|p| open_log(&p));
            for line in BufReader::new(stderr).lines() {
                let Ok(line) = line else { break };
                eprintln!("{line}");
                if let Some(f) = file.as_mut() {
                    let _ = writeln!(f, "{line}");
                }
            }
        });

        state.running = Some(Running { generation, child, stdin });
        Ok(generation)
    }

    /// Writes one protocol line to the sidecar of `generation`.
    pub fn send(&self, generation: u64, line: &str) -> Result<(), String> {
        let line = line.trim_end_matches(['\r', '\n']);
        if line.contains('\n') {
            return Err("una línea del protocolo no puede contener saltos de línea".into());
        }
        let mut state = self.state.lock().map_err(|_| "estado del relevo corrupto".to_string())?;
        let running = state
            .running
            .as_mut()
            .filter(|r| r.generation == generation)
            .ok_or_else(|| "el sidecar no está en marcha".to_string())?;
        running
            .stdin
            .write_all(line.as_bytes())
            .and_then(|_| running.stdin.write_all(b"\n"))
            .and_then(|_| running.stdin.flush())
            .map_err(|e| format!("no pude escribir al sidecar: {e}"))
    }

    /// Stops the sidecar of `generation`; a stale generation is a no-op.
    pub fn stop(&self, generation: u64) {
        if let Ok(mut state) = self.state.lock() {
            if state.running.as_ref().is_some_and(|r| r.generation == generation) {
                if let Some(r) = state.running.take() {
                    stop_in_background(r);
                }
            }
        }
    }

    /// On app exit: closes stdin, waits for the clean exit, kills it after the grace period.
    pub fn shutdown(&self) {
        let running = self.state.lock().ok().and_then(|mut s| s.running.take());
        if let Some(r) = running {
            stop_now(r);
        }
    }
}

fn stop_now(r: Running) {
    drop(r.stdin); // EOF: the sidecar closes its stores and exits 0
    if wait_for(&r.child, GRACE).is_none() {
        if let Ok(mut c) = r.child.lock() {
            let _ = c.kill();
            let _ = c.wait();
        }
    }
}

fn stop_in_background(r: Running) {
    thread::spawn(move || stop_now(r));
}

/// Exit code once the process is gone; None if it is still running after `timeout` (or was killed by a signal).
fn wait_for(child: &Mutex<Child>, timeout: Duration) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.lock().ok()?.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            _ => return None,
        }
    }
}

fn open_log(path: &PathBuf) -> Option<File> {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let too_big = std::fs::metadata(path).map(|m| m.len() > MAX_LOG_BYTES).unwrap_or(false);
    let mut opts = OpenOptions::new();
    opts.create(true);
    if too_big {
        opts.write(true).truncate(true);
    } else {
        opts.append(true);
    }
    opts.open(path).ok()
}
