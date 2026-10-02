//! The common filesystem/network boundary for AI turns and managed runs.
use super::{process::EngineSession, HANDSHAKE_BUDGET};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};

pub const WINDOWS_SANDBOX_OVERRIDE: &str = "windows.sandbox=\"unelevated\"";

pub fn policy(root: &Path, artifacts: Option<&Path>) -> Value {
    let mut roots = vec![root.to_path_buf()];
    if let Some(path) = artifacts {
        roots.push(path.to_path_buf());
    }
    json!({"type":"workspaceWrite", "writableRoots":roots,
        "networkAccess":false,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
}

pub fn gate(home: &Path) -> Arc<Mutex<()>> {
    static GATES: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    GATES
        .get_or_init(Mutex::default)
        .lock()
        .unwrap()
        .entry(home.to_path_buf())
        .or_default()
        .clone()
}

pub fn prepare(session: &mut EngineSession, root: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let ready = session.call("windowsSandbox/readiness", Value::Null, HANDSHAKE_BUDGET)?;
        if ready["status"] != "ready" {
            let result = session.call(
                "windowsSandbox/setupStart",
                json!({"mode":"unelevated", "cwd":root}),
                HANDSHAKE_BUDGET,
            )?;
            let completed = if result["started"] == true {
                session.wait_for_notification(
                    "windowsSandbox/setupCompleted",
                    std::time::Duration::from_secs(180),
                )?
            } else {
                None
            };
            if completed
                .as_ref()
                .is_some_and(|value| value["success"] == true)
            {
                return Ok(());
            }
            if session.call("windowsSandbox/readiness", Value::Null, HANDSHAKE_BUDGET)?["status"]
                != "ready"
            {
                return Err(format!(
                    "Windows 工作区沙箱初始化失败，未执行程序：{}",
                    completed
                        .as_ref()
                        .and_then(|value| value["error"].as_str())
                        .unwrap_or("初始化未完成")
                ));
            }
        }
    }
    let _ = (session, root);
    Ok(())
}

pub fn session(home: &Path, root: &Path) -> Result<EngineSession, String> {
    std::fs::create_dir_all(home).map_err(|e| e.to_string())?;
    let gate = gate(home);
    let _setup = gate.lock().map_err(|e| e.to_string())?;
    let mut args = vec![
        "app-server",
        "--listen",
        "stdio://",
        "-c",
        "sandbox_mode=\"workspace-write\"",
        "-c",
        "approval_policy=\"on-request\"",
        "-c",
        "features.memories=false",
    ];
    // command/exec keeps the startup config even after setupStart persists a
    // new mode. Select the restricted token before loading that config.
    if cfg!(windows) {
        args.extend(["-c", WINDOWS_SANDBOX_OVERRIDE]);
    }
    let mut session = EngineSession::start_with_events(
        &super::process::engine_path()?,
        &args,
        home,
        root,
        &[],
        None,
    )?;
    prepare(&mut session, root)?;
    Ok(session)
}
