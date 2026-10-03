//! Local Codex runtime. A conversation owns its thread, command lock and process.
//! Native tasks outlive panels. Slow I/O only runs on Tauri's blocking pool.
mod config;
pub(crate) mod execution;
pub(crate) mod process;
mod protocol;
#[cfg(windows)]
mod quiet_process;
mod registry;
mod tools;

use super::AppState;
use process::EngineSession;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

pub const DOMAINS: [&str; 2] = ["literature", "code"];
const HANDSHAKE_BUDGET: Duration = Duration::from_secs(20);
const THREAD_BUDGET: Duration = Duration::from_secs(120);
const TURN_BUDGET: Duration = Duration::from_secs(30);

// Slots are inserted under the map lock before starting I/O. Concurrent opens
// of one chat share a slot; unrelated chats never wait for its initialization.
type SharedSession = Arc<Mutex<Option<SessionEntry>>>;
#[derive(Default)]
pub struct AgentState {
    sessions: Mutex<HashMap<String, SharedSession>>,
}
struct SessionEntry {
    session: EngineSession,
    fingerprint: u64,
    handle: ThreadHandle,
    active_turn: Option<String>,
    has_turns: bool,
    requests: HashMap<String, Value>,
    lease: Option<crate::code::Lease>,
    managed_runs: bool,
    git_tools: bool,
    git_requests: HashMap<String, Value>,
    host_events: Vec<Value>,
}
impl SessionEntry {
    fn collect(&mut self) -> Result<Vec<Value>, String> {
        let mut events: Vec<_> = self
            .session
            .take_pending()
            .into_iter()
            .filter(|event| event["method"] != "item/tool/call")
            .collect();
        events.append(&mut self.host_events);
        for event in &events {
            if event["kind"] == "request" {
                self.requests.insert(event["id"].to_string(), event.clone());
            }
            if event["method"] == "turn/started" {
                self.active_turn = event["params"]["turn"]["id"].as_str().map(str::to_string);
            }
            if event["method"] == "turn/completed" {
                self.active_turn = None;
                self.lease = None;
                self.requests.clear();
                self.git_requests.clear();
            }
        }
        // Deliver buffered final output even if the process exits immediately afterwards.
        if events.is_empty() {
            if let Err(error) = self.session.ensure_alive() {
                self.active_turn = None;
                self.lease = None;
                self.requests.clear();
                self.git_requests.clear();
                return Err(error);
            }
        }
        Ok(events)
    }
    fn validate(&self, thread_id: &str) -> Result<(), String> {
        if self.handle.thread_id != thread_id {
            return Err("会话与 Agent 线程不匹配。".into());
        }
        Ok(())
    }
}

#[derive(Clone, Deserialize)]
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
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadHandle {
    #[serde(default)]
    pub experiment_id: Option<String>,
    pub thread_id: String,
    pub conversation_id: String,
    pub domain: String,
    pub project_id: String,
    pub cwd: String,
    pub model: String,
    pub model_provider: String,
    pub instruction_sources: Vec<String>,
    pub sandbox: String,
    #[serde(default)]
    pub turns: Vec<Value>,
    #[serde(default)]
    pub active_turn_id: Option<String>,
    #[serde(default)]
    pub fresh_thread: bool,
    #[serde(default)]
    pub events: Vec<Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnHandle {
    pub turn_id: String,
    pub status: Value,
    pub events: Vec<Value>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SandboxSetupHandle {
    pub started: bool,
    pub status: String,
}
fn valid_domain(domain: &str) -> Result<&'static str, String> {
    DOMAINS
        .into_iter()
        .find(|d| *d == domain)
        .ok_or_else(|| "未知的 Agent 作用域。".into())
}
fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
fn session_key(project: &str, conversation: &str) -> Result<String, String> {
    if !valid_key(project) || !valid_key(conversation) {
        return Err("项目或会话标识无效。".into());
    }
    Ok(format!("{project}:{conversation}"))
}
fn sandbox_type(response: &Value) -> String {
    response["sandbox"]["type"]
        .as_str()
        .unwrap_or("unknown")
        .to_string()
}
fn slot<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project: &str,
    conversation: &str,
) -> Result<SharedSession, String> {
    app.state::<AgentState>().slot(project, conversation)
}
impl AgentState {
    fn slot(&self, project: &str, conversation: &str) -> Result<SharedSession, String> {
        let key = session_key(project, conversation)?;
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        Ok(sessions
            .entry(key)
            .or_insert_with(|| Arc::new(Mutex::new(None)))
            .clone())
    }
    /// Metadata may be edited during execution, but a second window must not
    /// remove or rebind an active chat/project, or replace the entire database.
    pub fn protect(
        &self,
        current: Option<&Value>,
        next: Option<&Value>,
        project: Option<&str>,
    ) -> Result<(), String> {
        let sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        for (key, slot) in sessions.iter() {
            let (project_id, conversation) = key.split_once(':').ok_or("会话标识无效。")?;
            if project.is_some_and(|value| value != project_id) {
                continue;
            }
            if let (Some(current), Some(next)) = (current, next) {
                let find_project = |data: &Value| {
                    data["projects"]
                        .as_array()
                        .and_then(|items| items.iter().find(|item| item["id"] == project_id))
                        .cloned()
                };
                let before = find_project(current);
                let after = find_project(next);
                let keeps_chat = next["sessions"].as_array().is_some_and(|items| {
                    items
                        .iter()
                        .any(|item| item["project"] == project_id && item["id"] == conversation)
                });
                let experiment = slot.try_lock().ok().and_then(|guard| guard.as_ref().and_then(|entry| entry.handle.experiment_id.clone()))
                    .or_else(|| current["sessions"].as_array()
                        .and_then(|items| items.iter().find(|s| s["project"] == project_id && s["id"] == conversation))
                        .and_then(|s| s["experimentId"].as_str()).map(str::to_owned));
                if before.is_some()
                    && after.is_some()
                    && before.as_ref().map(|p| &p["path"]) == after.as_ref().map(|p| &p["path"])
                    && before.as_ref().map(|p| &p["repo"]) == after.as_ref().map(|p| &p["repo"])
                    && keeps_chat
                    && crate::experiments::catalog::keeps_binding(current, next, experiment.as_deref())
                {
                    continue;
                }
            }
            let busy = match slot.try_lock() {
                Ok(guard) => guard
                    .as_ref()
                    .is_some_and(|entry| entry.active_turn.is_some()),
                Err(_) => true,
            };
            if busy {
                return Err("请先结束 Agent 任务并保存结果，再删除会话、项目或更换工作区。".into());
            }
        }
        Ok(())
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}
fn codex_home(app: &tauri::AppHandle, domain: &str) -> Result<PathBuf, String> {
    let home = app
        .state::<AppState>()
        .storage
        .directory()
        .join("agent")
        .join(domain);
    std::fs::create_dir_all(&home).map_err(|e| e.to_string())?;
    Ok(home)
}
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

fn sandbox_gate(app: &tauri::AppHandle, domain: &str) -> Result<Arc<Mutex<()>>, String> {
    Ok(execution::gate(&codex_home(app, domain)?))
}
fn create_engine(
    app: &tauri::AppHandle,
    project: &str,
    domain: &str,
    conversation: &str,
    root: &std::path::Path,
    connection: &config::Connection<'_>,
) -> Result<EngineSession, String> {
    let args = config::arguments(connection)?;
    let app_copy = app.clone();
    let project = project.to_string();
    let domain_copy = domain.to_string();
    let conversation = conversation.to_string();
    let sink: process::EventSink = Arc::new(move |event| {
        if domain_copy == "code" && event["method"] == "turn/completed" {
            let _ = app_copy.emit("code-git-event", json!({"projectId":project}));
        }
        if event["kind"] == "request" && event["method"] == "item/tool/call" {
            tools::dispatch(
                app_copy.clone(),
                project.clone(),
                domain_copy.clone(),
                conversation.clone(),
                event,
            );
        }
        // Wake-up only: never duplicate model text or credentials in global events.
        let _ = app_copy.emit(
            "agent-event",
            json!({"projectId":project,"domain":domain_copy,"conversationId":conversation}),
        );
    });
    EngineSession::start_with_events(
        &process::engine_path()?,
        &args.iter().map(String::as_str).collect::<Vec<_>>(),
        &codex_home(app, domain)?,
        root,
        &config::environment(connection),
        Some(sink),
    )
}
#[tauri::command]
pub async fn agent_status(app: tauri::AppHandle) -> Result<EngineStatus, String> {
    blocking(move || {
        let path = process::engine_path().ok();
        let home = codex_home(&app, "status")?;
        let version = path.as_ref().and_then(|p| process::version(p, &home).ok());
        Ok(EngineStatus {
            available: version.is_some(),
            engine_path: path.map(|p| p.display().to_string()),
            version,
        })
    })
    .await
}
#[tauri::command]
pub async fn agent_handshake(app: tauri::AppHandle) -> Result<Value, String> {
    blocking(move || {
        process::exchange(
            &process::engine_path()?,
            &codex_home(&app, "handshake")?,
            protocol::initialize(1, "scientify", "Scientify", env!("CARGO_PKG_VERSION")),
            1,
            HANDSHAKE_BUDGET,
        )
    })
    .await
}
#[tauri::command]
pub async fn agent_domains(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
) -> Result<Vec<DomainBinding>, String> {
    super::library::trusted(&view)?;
    blocking(move || {
        if !valid_key(&project_id) {
            return Err("项目标识无效。".into());
        }
        Ok(DOMAINS
            .into_iter()
            .map(
                |domain| match resolve_root(&app, &app.state::<AppState>(), &project_id, domain) {
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
                },
            )
            .collect())
    })
    .await
}
#[tauri::command]
pub async fn agent_start_thread(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    domain: String,
    conversation_id: String,
    connection: ConnectionInput,
    workspace_root: Option<String>,
) -> Result<ThreadHandle, String> {
    super::library::trusted(&view)?;
    blocking(move || {
        let domain = valid_domain(&domain)?;
        let shared = slot(&app, &project_id, &conversation_id)?;
        let mut guard = shared.lock().map_err(|e| e.to_string())?;
        let data = app.state::<AppState>().storage.directory().to_path_buf();
        let bound = registry::bound_root(&data, &project_id, &conversation_id, domain)?;
        let root = if domain == "code" {
            let selected = bound
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned())
                .or(workspace_root);
            let state = app.state::<AppState>();
            crate::git::resolve(
                &state.storage,
                &state.files,
                &project_id,
                selected.as_deref(),
            )?
        } else {
            resolve_root(&app, &app.state::<AppState>(), &project_id, domain)?
        }
        .canonicalize()
        .map_err(|e| e.to_string())?;
        let record = registry::read(&data, &project_id, &conversation_id, domain, &root)?;
        let state = app.state::<AppState>();
        let experiment_id = if domain == "code" {
            crate::experiments::catalog::owner(&state.storage, &state.files, &project_id, &root)?
        } else { None };
        if record.as_ref().and_then(|r| r.experiment_id.as_ref())
            .is_some_and(|id| Some(id) != experiment_id.as_ref()) {
            return Err("该会话绑定的实验已移除或更换，请新建会话。".into());
        }
        let connection = connection.as_connection();
        config::prepare(&connection)?;
        let fp = fingerprint(&connection);
        if let Some(entry) = guard.as_mut() {
            if entry.handle.domain != domain || std::path::Path::new(&entry.handle.cwd) != root {
                return Err("该会话绑定的工作区已变化，请新建会话。".into());
            }
            if entry.session.ensure_alive().is_ok() {
                if entry.fingerprint == fp {
                    let mut handle = entry.handle.clone();
                    handle.fresh_thread = !entry.has_turns;
                    // Read before draining: the snapshot covers prior output and the
                    // following events complete anything that arrived during the read.
                    if entry.has_turns {
                        let response = match entry.session.call(
                            "thread/read",
                            json!({"threadId":handle.thread_id,"includeTurns":true}),
                            HANDSHAKE_BUDGET,
                        ) {
                            Ok(response) => response,
                            Err(error) => {
                                entry.session.terminate();
                                entry.active_turn = None;
                                entry.lease = None;
                                entry.requests.clear();
                                entry.git_requests.clear();
                                return Err(error);
                            }
                        };
                        handle.turns = response["thread"]["turns"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                    }
                    handle.events = entry.collect()?;
                    handle.active_turn_id = entry.active_turn.clone();
                    for request in entry.requests.values() {
                        if !handle
                            .events
                            .iter()
                            .any(|event| event["id"] == request["id"] && event["kind"] == "request")
                        {
                            handle.events.push(request.clone());
                        }
                    }
                    return Ok(handle);
                }
                if entry.active_turn.is_some() {
                    return Err("请等待此会话的当前任务结束后再切换模型。".into());
                }
            }
        }
        // Only this chat is restarted; other conversations retain their engines.
        *guard = None;
        // Shared SQLite/sandbox files must finish first-time initialization before
        // a second process opens this home. Task execution is outside this gate.
        let mut session = {
            let gate = sandbox_gate(&app, domain)?;
            let _setup = gate.lock().map_err(|e| e.to_string())?;
            let mut session = create_engine(
                &app,
                &project_id,
                domain,
                &conversation_id,
                &root,
                &connection,
            )?;
            execution::prepare(&mut session, &root)?;
            session
        };
        let plan = thread_plan(&root, connection.model, domain, record);
        let response = session.call(plan.method, plan.params, THREAD_BUDGET)?;
        let fresh_thread = plan.method == "thread/start";
        let managed_runs = plan.managed_runs;
        let git_tools = plan.git_tools;
        let thread_id = response["thread"]["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("Agent 返回了空线程标识。")?
            .to_string();
        let handle = ThreadHandle {
            experiment_id,
            thread_id,
            conversation_id: conversation_id.clone(),
            domain: domain.into(),
            project_id: project_id.clone(),
            cwd: root.display().to_string(),
            model: connection.model.into(),
            model_provider: "scientify".into(),
            instruction_sources: Vec::new(),
            sandbox: sandbox_type(&response),
            turns: response["thread"]["turns"]
                .as_array()
                .cloned()
                .unwrap_or_default(),
            active_turn_id: None,
            fresh_thread,
            events: Vec::new(),
        };
        registry::write(
            &data,
            &handle,
            !handle.turns.is_empty(),
            managed_runs,
            git_tools,
        )?;
        *guard = Some(SessionEntry {
            session,
            fingerprint: fp,
            has_turns: !handle.turns.is_empty(),
            handle: handle.clone(),
            active_turn: None,
            requests: HashMap::new(),
            lease: None,
            managed_runs,
            git_tools,
            git_requests: HashMap::new(),
            host_events: Vec::new(),
        });
        Ok(handle)
    })
    .await
}
struct ThreadPlan {
    method: &'static str,
    params: Value,
    managed_runs: bool,
    git_tools: bool,
}
fn thread_plan(
    root: &std::path::Path,
    model: &str,
    domain: &str,
    record: Option<registry::Binding>,
) -> ThreadPlan {
    let resumable = record.filter(|binding| binding.started);
    let managed_runs = domain == "code" && resumable.as_ref().is_none_or(|b| b.managed_runs);
    let git_tools = domain == "code" && resumable.as_ref().is_none_or(|b| b.git_tools);
    let mut params = json!({"cwd":root,"model":model,"modelProvider":"scientify","approvalPolicy":"on-request","sandbox":"workspace-write","developerInstructions":tools::instructions(domain, managed_runs, git_tools)});
    let method = if let Some(binding) = resumable {
        // Codex resumes the original tool registry along with the thread history.
        params["threadId"] = json!(binding.thread_id);
        "thread/resume"
    } else {
        if domain == "code" {
            params["dynamicTools"] = tools::specifications();
        }
        "thread/start"
    };
    ThreadPlan {
        method,
        params,
        managed_runs,
        git_tools,
    }
}
fn with_entry<R: tauri::Runtime, T>(
    app: &tauri::AppHandle<R>,
    project: &str,
    domain: &str,
    conversation: &str,
    action: impl FnOnce(&mut SessionEntry) -> Result<T, String>,
) -> Result<T, String> {
    valid_domain(domain)?;
    let shared = slot(app, project, conversation)?;
    let mut guard = shared.lock().map_err(|e| e.to_string())?;
    let entry = guard.as_mut().ok_or("该会话尚未启动，请重新连接。")?;
    if entry.handle.domain != domain {
        return Err("会话工作区不匹配。".into());
    }
    action(entry)
}
#[tauri::command]
pub async fn agent_start_turn(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    domain: String,
    conversation_id: String,
    thread_id: String,
    text: String,
) -> Result<TurnHandle, String> {
    super::library::trusted(&view)?;
    blocking(move || with_entry(&app,&project_id,&domain,&conversation_id,|entry| {
        entry.validate(&thread_id)?;
        if text.trim().is_empty() || text.len()>100_000 { return Err("任务内容无效或过长。".into()); }
        if entry.active_turn.is_some() { return Err("此会话已有任务正在运行。".into()); }
        let lease = crate::code::Lease::agent(std::path::Path::new(&entry.handle.cwd))?;
        // Protect against an uncertain turn/start outcome: do not retry this text automatically.
        registry::write(app.state::<AppState>().storage.directory(),&entry.handle,true,entry.managed_runs,entry.git_tools)?;
        entry.lease = Some(lease);
        entry.has_turns = true;
        entry.active_turn = Some("starting".into());
        let response = match entry.session.call("turn/start",json!({"threadId":thread_id,"sandboxPolicy":execution::policy(std::path::Path::new(&entry.handle.cwd),None),"input":[{"type":"text","text":text,"text_elements":[]}]}),TURN_BUDGET) {
            Ok(response) => response,
            Err(error) => {
                // The request may have reached Codex. Stop this process rather than
                // automatically sending a duplicate turn or leaving an invisible job.
                entry.session.terminate();
                entry.active_turn = None;
                entry.lease = None;
                entry.requests.clear();
                return Err(error);
            }
        };
        let Some(id) = response["turn"]["id"].as_str().filter(|s|!s.is_empty()).map(str::to_string) else {
            entry.session.terminate(); entry.active_turn=None; entry.lease=None;
            return Err("Agent 返回了空 turn 标识。".into());
        };
        entry.active_turn = Some(id.clone());
        let status = response["turn"]["status"].clone();
        if matches!(status.as_str(), Some("completed" | "failed" | "interrupted")) { entry.active_turn=None; entry.lease=None; }
        Ok(TurnHandle { turn_id:id,status,events:entry.collect()? })
    })).await
}
#[tauri::command]
pub async fn agent_events(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    domain: String,
    conversation_id: String,
    thread_id: String,
) -> Result<Vec<Value>, String> {
    super::library::trusted(&view)?;
    blocking(move || {
        with_entry(&app, &project_id, &domain, &conversation_id, |entry| {
            entry.validate(&thread_id)?;
            entry.collect()
        })
    })
    .await
}
#[tauri::command]
pub async fn agent_interrupt(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    domain: String,
    conversation_id: String,
    thread_id: String,
    turn_id: String,
) -> Result<(), String> {
    super::library::trusted(&view)?;
    blocking(move || {
        with_entry(&app, &project_id, &domain, &conversation_id, |entry| {
            entry.validate(&thread_id)?;
            if entry.active_turn.as_deref() != Some(turn_id.as_str()) {
                return Err("此任务已结束或 turn 标识不匹配。".into());
            }
            entry.session.call(
                "turn/interrupt",
                json!({"threadId":thread_id,"turnId":turn_id}),
                HANDSHAKE_BUDGET,
            )?;
            // Acknowledge only; turn/completed is the authoritative terminal event.
            Ok(())
        })
    })
    .await
}
#[tauri::command]
pub async fn agent_respond(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    domain: String,
    conversation_id: String,
    id: Value,
    result: Value,
) -> Result<(), String> {
    super::library::trusted(&view)?;
    blocking(move || {
        let pending = with_entry(&app, &project_id, &domain, &conversation_id, |entry| {
            if !result.is_object() || !entry.requests.contains_key(&id.to_string()) {
                return Err("审批请求已失效或不属于此会话。".into());
            }
            if let Some(event) = entry.git_requests.get(&id.to_string()).cloned() {
                if !matches!(
                    result["decision"].as_str(),
                    Some("accept" | "decline" | "cancel")
                ) {
                    return Err("Git 操作只能批准本次请求。".into());
                }
                entry.git_requests.remove(&id.to_string());
                entry.requests.remove(&id.to_string());
                return Ok(Some(event));
            }
            entry.session.respond(&id, result.clone())?;
            entry.requests.remove(&id.to_string());
            Ok(None)
        })?;
        if let Some(event) = pending {
            tools::complete_git(&app, &project_id, &domain, &conversation_id, event, &result)?;
        }
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn agent_release<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
    domain: String,
    conversation_id: String,
) -> Result<(), String> {
    super::library::trusted(&view)?;
    blocking(move || {
        valid_domain(&domain)?;
        let shared = app
            .state::<AgentState>()
            .slot(&project_id, &conversation_id)?;
        let mut guard = shared.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = guard.as_ref() {
            if entry.handle.domain != domain || entry.active_turn.is_some() {
                return Err("请先中止并等待此会话任务结束。".into());
            }
        }
        *guard = None;
        Ok(())
    })
    .await
}
#[tauri::command]
pub async fn agent_windows_sandbox_setup(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    domain: String,
    connection: ConnectionInput,
) -> Result<SandboxSetupHandle, String> {
    super::library::trusted(&view)?;
    blocking(move || {
        let domain = valid_domain(&domain)?;
        let root = resolve_root(&app, &app.state::<AppState>(), &project_id, domain)?;
        let gate = sandbox_gate(&app, domain)?;
        let _setup = gate.lock().map_err(|e| e.to_string())?;
        let mut session = create_engine(
            &app,
            &project_id,
            domain,
            "sandbox",
            &root,
            &connection.as_connection(),
        )?;
        execution::prepare(&mut session, &root)?;
        Ok(SandboxSetupHandle {
            started: true,
            status: "setupCompleted".into(),
        })
    })
    .await
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_code_threads_resume_history_without_advertising_new_tools() {
        let dir = tempfile::tempdir().unwrap();
        for (managed_runs, git_tools) in [(false, false), (true, false), (true, true)] {
            let binding: registry::Binding = serde_json::from_value(json!({
                "project_id":"p1", "conversation_id":"c1", "domain":"code",
                "root":dir.path(), "thread_id":"original-thread", "started":true,
                "managed_runs":managed_runs, "git_tools":git_tools
            }))
            .unwrap();
            let plan = thread_plan(dir.path(), "model", "code", Some(binding));
            assert_eq!(plan.method, "thread/resume");
            assert_eq!(plan.params["threadId"], "original-thread");
            assert!(plan.params.get("dynamicTools").is_none());
            assert_eq!(plan.managed_runs, managed_runs);
            assert_eq!(plan.git_tools, git_tools);
            let instructions = plan.params["developerInstructions"].as_str().unwrap();
            assert_eq!(instructions.contains("scientify_start_run"), managed_runs);
            assert_eq!(instructions.contains("scientify_git_action"), git_tools);
            assert_eq!(
                instructions.contains("新建代码会话"),
                !managed_runs || !git_tools
            );
        }
        let new_code = thread_plan(dir.path(), "model", "code", None);
        assert_eq!(new_code.method, "thread/start");
        assert!(new_code.managed_runs && new_code.git_tools);
        assert_eq!(new_code.params["dynamicTools"].as_array().unwrap().len(), 7);
        let literature = thread_plan(dir.path(), "model", "literature", None);
        assert!(!literature.managed_runs && !literature.git_tools);
        assert!(literature.params.get("dynamicTools").is_none());
    }

    #[test]
    fn one_chat_initializing_never_holds_the_registry_lock_for_another_chat() {
        let state = AgentState::default();
        let first = state.slot("p1", "c1").unwrap();
        let same = state.slot("p1", "c1").unwrap();
        assert!(Arc::ptr_eq(&first, &same));
        let _starting = first.lock().unwrap();
        let second = state.slot("p1", "c2").unwrap();
        assert!(second.try_lock().is_ok());
        let other_project = state.slot("p2", "c1").unwrap();
        assert!(other_project.try_lock().is_ok());
        let current = json!({"projects":[{"id":"p1","path":"C:/work"}],"sessions":[{"id":"c1","project":"p1"}]});
        assert!(state.protect(Some(&current), Some(&current), None).is_ok());
        let moved = json!({"projects":[{"id":"p1","path":"C:/other"}],"sessions":[{"id":"c1","project":"p1"}]});
        assert!(state.protect(Some(&current), Some(&moved), None).is_err());
        assert!(state.protect(None, None, Some("p2")).is_ok());
        assert!(state.protect(None, None, None).is_err());
    }

    #[test]
    fn initializing_chat_protects_its_experiment_but_allows_renames_and_other_experiments() {
        let state = AgentState::default();
        let slot = state.slot("p1", "chat").unwrap();
        let _starting = slot.lock().unwrap();
        let current = json!({"projects":[{"id":"p1"}],"sessions":[{"id":"chat","project":"p1","experimentId":"e1"}],"experiments":[{"id":"e1","project":"p1","source":"existing","root":"F:/a","name":"A"},{"id":"e2","project":"p1","source":"existing","root":"F:/b","name":"B"}]});
        let mut renamed = current.clone();
        renamed["experiments"][0]["name"] = json!("Renamed");
        renamed["experiments"].as_array_mut().unwrap().pop();
        assert!(state.protect(Some(&current), Some(&renamed), None).is_ok());
        let mut archived = current.clone();
        archived["experiments"][0]["archived"] = json!(true);
        assert!(state.protect(Some(&current), Some(&archived), None).is_err());
        let mut moved = current.clone();
        moved["experiments"][0]["root"] = json!("F:/c");
        assert!(state.protect(Some(&current), Some(&moved), None).is_err());
    }

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

    #[test]
    fn a_read_only_sandbox_is_detected_instead_of_presented_as_editable() {
        assert_eq!(
            sandbox_type(&serde_json::json!({
                "sandbox": { "type": "readOnly" }
            })),
            "readOnly"
        );
        assert_eq!(
            sandbox_type(&serde_json::json!({
                "sandbox": { "type": "workspaceWrite" }
            })),
            "workspaceWrite"
        );
    }
}
