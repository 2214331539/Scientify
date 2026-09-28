//! Built-in agent engine.
//!
//! The engine is a Codex sidecar spoken to over stdio JSON-RPC. A *domain* is the
//! permission boundary: it maps one-to-one onto a root directory. Domains are
//! deliberately not the same as the six navigation entries — Code, Manuscript and
//! All files all edit the same project root, so they share one domain.

mod config;
mod process;
mod protocol;

use super::AppState;
use process::EngineSession;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, State};

/// Domains in display order.
pub const DOMAINS: [&str; 2] = ["literature", "code"];

/// The initialize exchange. The engine starts a local process and answers
/// immediately, so a slow response means something is wrong.
const HANDSHAKE_BUDGET: Duration = Duration::from_secs(20);
/// Starting a thread loads configuration and the model catalog.
const THREAD_BUDGET: Duration = Duration::from_secs(120);
/// A turn performs a model request plus tool calls.
const TURN_BUDGET: Duration = Duration::from_secs(600);

/// One engine process per (project, domain). Sessions are dropped on shutdown,
/// which terminates the sidecar.
#[derive(Default)]
pub struct AgentState {
    sessions: Mutex<HashMap<String, SessionEntry>>,
}

/// A running engine plus the connection it was started with. A changed
/// connection restarts the process, because the model provider is read at
/// startup rather than per request.
struct SessionEntry {
    session: EngineSession,
    fingerprint: u64,
}

/// Model service settings handed down from the assistant panel.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInput {
    endpoint: String,
    model: String,
    provider: String,
    #[serde(default)]
    api_key: Option<String>,
}

impl ConnectionInput {
    fn as_connection(&self) -> config::Connection<'_> {
        config::Connection {
            endpoint: &self.endpoint,
            model: &self.model,
            provider: &self.provider,
            api_key: self.api_key.as_deref(),
        }
    }
}

/// Hash what decides the engine's behaviour. The key is included so rotating it
/// restarts the process, and hashed so it is never held as a comparable string.
fn fingerprint(connection: &config::Connection<'_>) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    connection.endpoint.hash(&mut hasher);
    connection.model.hash(&mut hasher);
    connection.provider.hash(&mut hasher);
    connection.api_key.hash(&mut hasher);
    hasher.finish()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub available: bool,
    pub engine_path: Option<String>,
    pub version: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DomainBinding {
    pub domain: &'static str,
    pub root: Option<String>,
    pub available: bool,
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHandle {
    pub thread_id: String,
    pub domain: String,
    pub project_id: String,
    pub cwd: String,
    pub model: String,
    pub model_provider: String,
    /// Instruction files the engine actually loaded for this thread, which is how
    /// the UI shows whether an `AGENTS.md` is in effect.
    pub instruction_sources: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnHandle {
    pub turn_id: String,
    pub status: Value,
    /// Messages raised while starting the turn, typically approval requests.
    pub events: Vec<Value>,
}

fn valid_domain(domain: &str) -> Result<&'static str, String> {
    DOMAINS
        .into_iter()
        .find(|candidate| *candidate == domain)
        .ok_or_else(|| "未知的 Agent 作用域。".to_string())
}

fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

/// Per-domain engine home. Two homes give each domain its own threads,
/// configuration and credentials.
fn codex_home(app: &tauri::AppHandle, domain: &str) -> Result<PathBuf, String> {
    let home = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法定位应用数据目录：{e}"))?
        .join("workspace")
        .join("agent")
        .join(domain);
    std::fs::create_dir_all(&home).map_err(|e| format!("无法创建 Agent 数据目录：{e}"))?;
    Ok(home)
}

/// Resolve the single writable root a domain operates on.
fn resolve_root(
    app: &tauri::AppHandle,
    state: &AppState,
    project_id: &str,
    domain: &str,
) -> Result<PathBuf, String> {
    let loaded = state.storage.load()?.ok_or("工作区尚未载入。")?;
    let project = loaded["projects"]
        .as_array()
        .and_then(|items| items.iter().find(|p| p["id"].as_str() == Some(project_id)))
        .ok_or("项目不存在。")?;
    if domain == "literature" {
        return app
            .state::<super::library::LibraryState>()
            .service
            .root(project_id)?
            .ok_or_else(|| "请先在文献库打开本地文件夹。".to_string());
    }
    state
        .files
        .project_root(project_id, project["path"].as_str())
}

#[tauri::command]
pub async fn agent_status() -> Result<EngineStatus, String> {
    let Ok(path) = process::engine_path() else {
        return Ok(EngineStatus {
            available: false,
            engine_path: None,
            version: None,
        });
    };
    let version = process::version(&path).ok();
    Ok(EngineStatus {
        available: version.is_some(),
        engine_path: Some(path.display().to_string()),
        version,
    })
}

/// Start the engine, complete the initialize handshake, and shut it down.
///
/// This is the end-to-end proof that the sidecar is packaged, spawnable, and
/// speaking the expected protocol.
#[tauri::command]
pub async fn agent_handshake(app: tauri::AppHandle) -> Result<Value, String> {
    let engine = process::engine_path()?;
    let home = codex_home(&app, "handshake")?;
    let request = protocol::initialize(1, "scientify", "Scientify", env!("CARGO_PKG_VERSION"));
    process::exchange(&engine, &home, request, 1, HANDSHAKE_BUDGET)
}

/// Resolve each domain's root so the UI can show the real boundary.
#[tauri::command]
pub async fn agent_domains(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<DomainBinding>, String> {
    if !valid_key(&project_id) {
        return Err("项目标识无效。".into());
    }
    let mut bindings = Vec::with_capacity(DOMAINS.len());
    for domain in DOMAINS {
        bindings.push(match resolve_root(&app, &state, &project_id, domain) {
            Ok(root) => DomainBinding {
                domain,
                root: Some(root.display().to_string()),
                available: true,
                reason: None,
            },
            Err(reason) => DomainBinding {
                domain,
                root: None,
                available: false,
                reason: Some(reason),
            },
        });
    }
    Ok(bindings)
}

/// Create a thread bound to one domain's root.
///
/// The engine is spawned on first use and kept for later turns. Writes are
/// limited to `workspace-write` inside the root, and approvals are requested
/// rather than assumed.
#[tauri::command]
pub async fn agent_start_thread(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    agent: State<'_, AgentState>,
    project_id: String,
    domain: String,
    connection: ConnectionInput,
) -> Result<ThreadHandle, String> {
    super::library::trusted(&view)?;
    let domain = valid_domain(&domain)?;
    if !valid_key(&project_id) {
        return Err("项目标识无效。".into());
    }
    let root = resolve_root(&app, &state, &project_id, domain)?;
    let home = codex_home(&app, domain)?;
    let connection = connection.as_connection();
    // Refuse an unusable provider before spawning anything, so a wrong setting
    // surfaces as a clear message rather than a request-time failure.
    config::write(&home, &connection)?;
    let environment = config::environment(&connection);
    let fingerprint = fingerprint(&connection);
    let key = format!("{project_id}:{domain}");

    let mut sessions = agent.sessions.lock().map_err(|e| e.to_string())?;
    if sessions
        .get(&key)
        .is_some_and(|entry| entry.fingerprint != fingerprint)
    {
        // Dropping the entry terminates the previous process.
        sessions.remove(&key);
    }
    if !sessions.contains_key(&key) {
        let engine = process::engine_path()?;
        sessions.insert(
            key.clone(),
            SessionEntry {
                session: EngineSession::start(&engine, &home, &root, &environment)?,
                fingerprint,
            },
        );
    }
    let session = &mut sessions.get_mut(&key).ok_or("会话创建失败。")?.session;

    let response = session.call(
        "thread/start",
        json!({
            "cwd": root.to_string_lossy(),
            // Approvals are requested per action; nothing is assumed.
            "approvalPolicy": "on-request",
            "sandbox": "workspace-write",
            "sessionStartSource": "startup"
        }),
        THREAD_BUDGET,
    )?;

    let thread = response.get("thread").cloned().unwrap_or(Value::Null);
    Ok(ThreadHandle {
        thread_id: thread["id"].as_str().unwrap_or_default().to_string(),
        domain: domain.to_string(),
        project_id,
        cwd: response["cwd"].as_str().unwrap_or_default().to_string(),
        model: response["model"].as_str().unwrap_or_default().to_string(),
        model_provider: response["modelProvider"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        instruction_sources: response["instructionSources"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// Send one user message to a thread.
#[tauri::command]
pub async fn agent_start_turn(
    view: tauri::Webview,
    agent: State<'_, AgentState>,
    project_id: String,
    domain: String,
    thread_id: String,
    text: String,
) -> Result<TurnHandle, String> {
    super::library::trusted(&view)?;
    let domain = valid_domain(&domain)?;
    if text.trim().is_empty() || text.len() > 100_000 {
        return Err("任务内容无效或过长。".into());
    }
    let key = format!("{project_id}:{domain}");
    let mut sessions = agent.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&key)
        .map(|entry| &mut entry.session)
        .ok_or("该作用域尚未启动会话，请先建立线程。")?;
    let response = session.call(
        "turn/start",
        json!({
            "threadId": thread_id,
            // `text_elements` is part of the transport contract even when empty.
            "input": [{ "type": "text", "text": text, "text_elements": [] }]
        }),
        TURN_BUDGET,
    )?;
    Ok(TurnHandle {
        turn_id: response["turn"]["id"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
        status: response["turn"]["status"].clone(),
        events: session.take_pending(),
    })
}

/// Drain messages the engine raised since the last call.
///
/// The UI polls this while a turn runs so an approval raised between two host
/// requests is not missed. A push channel replaces it once the event pipeline
/// lands; polling is honest about the fact that nothing is pushed yet.
#[tauri::command]
pub async fn agent_events(
    view: tauri::Webview,
    agent: State<'_, AgentState>,
    project_id: String,
    domain: String,
) -> Result<Vec<Value>, String> {
    super::library::trusted(&view)?;
    let domain = valid_domain(&domain)?;
    let mut sessions = agent.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&format!("{project_id}:{domain}"))
        .map(|entry| &mut entry.session)
        .ok_or("该作用域尚未启动会话。")?;
    Ok(session.take_pending())
}

/// Answer a server-initiated request.
///
/// The decision vocabulary (`accept` / `decline` / `cancel`) belongs to the
/// transport and is therefore assembled by the platform layer, not here.
#[tauri::command]
pub async fn agent_respond(
    view: tauri::Webview,
    agent: State<'_, AgentState>,
    project_id: String,
    domain: String,
    id: Value,
    result: Value,
) -> Result<(), String> {
    super::library::trusted(&view)?;
    let domain = valid_domain(&domain)?;
    if !result.is_object() {
        return Err("审批回应的内容无效。".into());
    }
    let mut sessions = agent.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions
        .get_mut(&format!("{project_id}:{domain}"))
        .map(|entry| &mut entry.session)
        .ok_or("该作用域尚未启动会话。")?;
    session.respond(&id, result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_declared_domains_are_accepted() {
        // Navigation names are not domains: three views share the code root.
        assert_eq!(valid_domain("literature").unwrap(), "literature");
        assert_eq!(valid_domain("code").unwrap(), "code");
        assert!(valid_domain("experiments").is_err());
        assert!(valid_domain("../code").is_err());
        assert!(valid_domain("").is_err());
    }

    #[test]
    fn identifiers_reject_path_like_input() {
        assert!(valid_key("project-1"));
        assert!(!valid_key(""));
        assert!(!valid_key("../escape"));
        assert!(!valid_key("has space"));
        assert!(!valid_key(&"a".repeat(81)));
    }
}
