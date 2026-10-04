//! Where the sidecar lives and how to start it. Pure (no Tauri, no process spawning) so it is unit-tested.
//! Precedence: JARVIS_SIDECAR > `sidecar.mjs` next to the executable > (debug builds) the repo's bundle.

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Launch {
    /// Node.js executable (>= 22.13 for `node:sqlite`). The launcher script passes its own `process.execPath`.
    pub node: PathBuf,
    /// The bundled sidecar (`apps/sidecar/dist/sidecar.mjs`).
    pub script: PathBuf,
    /// Working directory for the sidecar process: the script's folder.
    pub cwd: PathBuf,
}

pub const BUILD_HINT: &str = "construye el sidecar con «pnpm --filter @jarvis/sidecar build» (island.bat lo hace solo) o define JARVIS_SIDECAR";

/// `env` reads an environment variable, `exe_dir` is the folder of the running executable and `dev_root` the
/// repository root (only passed in debug builds, where the source tree is known to exist).
pub fn resolve_launch(
    env: impl Fn(&str) -> Option<String>,
    exe_dir: Option<&Path>,
    dev_root: Option<&Path>,
) -> Result<Launch, String> {
    let non_empty = |k: &str| env(k).filter(|v| !v.trim().is_empty());
    let script = if let Some(explicit) = non_empty("JARVIS_SIDECAR") {
        let p = PathBuf::from(explicit);
        if !p.is_file() {
            return Err(format!("JARVIS_SIDECAR apunta a un archivo que no existe: {}", p.display()));
        }
        p
    } else {
        let candidates = exe_dir
            .map(|d| d.join("sidecar.mjs"))
            .into_iter()
            .chain(dev_root.map(|r| r.join("apps").join("sidecar").join("dist").join("sidecar.mjs")));
        let tried: Vec<PathBuf> = candidates.collect();
        match tried.iter().find(|p| p.is_file()) {
            Some(p) => p.clone(),
            None => {
                let list = tried.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(", ");
                return Err(format!("no encuentro el sidecar (busqué: {list}); {BUILD_HINT}"));
            }
        }
    };
    let node = non_empty("JARVIS_NODE").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("node"));
    let cwd = script.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."));
    Ok(Launch { node, script, cwd })
}

/// Session token for the sidecar handshake (ADR-0008): 24 random bytes, hex.
pub fn new_token() -> Result<String, String> {
    let mut bytes = [0u8; 24];
    getrandom::getrandom(&mut bytes).map_err(|e| format!("no hay fuente de aleatoriedad del SO: {e}"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::fs;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("jarvis-launch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| map.get(k).cloned()
    }

    #[test]
    fn explicit_path_wins_and_must_exist() {
        let dir = tmp("explicit");
        let script = dir.join("custom.mjs");
        fs::write(&script, "").unwrap();
        fs::write(dir.join("sidecar.mjs"), "").unwrap();
        let l = resolve_launch(env_of(&[("JARVIS_SIDECAR", script.to_str().unwrap()), ("JARVIS_NODE", "/opt/node")]), Some(&dir), None).unwrap();
        assert_eq!(l.script, script);
        assert_eq!(l.node, PathBuf::from("/opt/node"));
        assert_eq!(l.cwd, dir);

        let missing = dir.join("nope.mjs");
        let err = resolve_launch(env_of(&[("JARVIS_SIDECAR", missing.to_str().unwrap())]), Some(&dir), None).unwrap_err();
        assert!(err.contains("no existe"), "{err}");
    }

    #[test]
    fn next_to_exe_before_repo_bundle() {
        let exe = tmp("exe");
        let root = tmp("root");
        let bundle = root.join("apps/sidecar/dist");
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("sidecar.mjs"), "").unwrap();
        // Only the repo bundle exists: use it.
        let l = resolve_launch(env_of(&[]), Some(&exe), Some(&root)).unwrap();
        assert_eq!(l.script, bundle.join("sidecar.mjs"));
        assert_eq!(l.node, PathBuf::from("node"));
        // A copy next to the executable takes precedence.
        fs::write(exe.join("sidecar.mjs"), "").unwrap();
        assert_eq!(resolve_launch(env_of(&[("JARVIS_SIDECAR", " ")]), Some(&exe), Some(&root)).unwrap().script, exe.join("sidecar.mjs"));
    }

    #[test]
    fn explains_how_to_fix_a_missing_bundle() {
        let exe = tmp("none");
        let err = resolve_launch(env_of(&[]), Some(&exe), None).unwrap_err();
        assert!(err.contains("pnpm --filter @jarvis/sidecar build"), "{err}");
        assert!(err.contains("sidecar.mjs"), "{err}");
    }

    #[test]
    fn tokens_are_random_hex() {
        let a = new_token().unwrap();
        let b = new_token().unwrap();
        assert_eq!(a.len(), 48);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
}
