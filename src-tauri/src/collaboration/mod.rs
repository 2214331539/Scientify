//! Collaboration: phone sign-in, remote projects and members, and project sync.
//!
//! The server address and sign-in tokens live in the data folder. `sync.rs`
//! keeps each synced project's files and records the same on every device.

pub(crate) mod permissions;
mod sync;

use crate::{library::trusted, AppState};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::OnceLock};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use uuid::Uuid;

const FILE_NAME: &str = "collaboration.json";
const AUTH_FILE_NAME: &str = "collaboration-auth.json";
pub(crate) const DEFAULT_ENDPOINT: &str = match option_env!("SCIENTIFY_COLLAB_ENDPOINT") {
    Some(endpoint) => endpoint,
    None => "https://124.221.115.83:8443",
};
/// Addresses of earlier builds; saved settings that still use one move to the default.
const LEGACY_ENDPOINTS: &[&str] = &["https://collab.example.com", "https://47.79.122.59"];

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CollaborationState {
    pub client_id: String,
    pub enabled: bool,
    pub endpoint: String,
    pub authenticated: bool,
    pub user_id: Option<String>,
    pub phone: Option<String>,
}

impl Default for CollaborationState {
    fn default() -> Self {
        Self {
            client_id: String::new(),
            enabled: true,
            endpoint: DEFAULT_ENDPOINT.into(),
            authenticated: false,
            user_id: None,
            phone: None,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthTokens {
    access_token: String,
    refresh_token: String,
    user_id: String,
    phone: String,
}

fn path(state: &AppState) -> PathBuf {
    state.storage.directory().join(FILE_NAME)
}

fn auth_path(state: &AppState) -> PathBuf {
    state.storage.directory().join(AUTH_FILE_NAME)
}

fn read(state: &AppState) -> Result<CollaborationState, String> {
    let file = path(state);
    if !file.is_file() {
        return Ok(CollaborationState::default());
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    let mut current: CollaborationState =
        serde_json::from_slice(&bytes).map_err(|_| "协作配置文件格式无效。".to_string())?;
    if current.endpoint.is_empty() || LEGACY_ENDPOINTS.contains(&current.endpoint.as_str()) {
        current.endpoint = DEFAULT_ENDPOINT.into();
        current.enabled = true;
    }
    Ok(current)
}

fn write(state: &AppState, value: &CollaborationState) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    scientify_core::storage::write_atomic_bytes(&path(state), &bytes)
}

fn read_auth(state: &AppState) -> Result<Option<AuthTokens>, String> {
    let file = auth_path(state);
    if !file.is_file() {
        return Ok(None);
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "协作登录状态格式无效。".into())
}

fn write_auth(state: &AppState, value: &AuthTokens) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    scientify_core::storage::write_atomic_bytes(&auth_path(state), &bytes)
}

fn clear_auth(state: &AppState) -> Result<(), String> {
    match fs::remove_file(auth_path(state)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn normalize_endpoint(value: &str) -> Result<String, String> {
    let endpoint = value.trim().trim_end_matches('/');
    if endpoint.len() > 2048 {
        return Err("协作服务器地址过长。".into());
    }
    let parsed = tauri::Url::parse(endpoint).map_err(|_| "协作服务器地址格式无效。")?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host().is_none() {
        return Err("协作服务器地址必须使用 http 或 https。".into());
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("协作服务器地址不能包含账号或密码。".into());
    }
    Ok(endpoint.to_string())
}

fn valid_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn snapshot(state: &AppState) -> Result<CollaborationState, String> {
    let mut current = read(state)?;
    if current.client_id.is_empty() {
        current.client_id = Uuid::new_v4().to_string();
        write(state, &current)?;
    }
    match read_auth(state)? {
        Some(auth) => {
            current.authenticated = true;
            current.user_id = Some(auth.user_id);
            current.phone = Some(auth.phone);
        }
        None => {
            current.authenticated = false;
            current.user_id = None;
            current.phone = None;
        }
    }
    Ok(current)
}

async fn request_json(
    endpoint: &str,
    path: &str,
    method: reqwest::Method,
    token: Option<&str>,
    payload: Option<Value>,
) -> Result<Value, String> {
    let url = format!("{}/v1{}", endpoint.trim_end_matches('/'), path);
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.request(method, url);
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    if let Some(payload) = payload {
        request = request.json(&payload);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("协作服务器连接失败：{error}"))?;
    let status = response.status();
    let text = response.text().await.map_err(|error| error.to_string())?;
    let value: Value = serde_json::from_str(&text).unwrap_or_else(|_| json!({"error": text}));
    if !status.is_success() {
        return Err(value["error"]
            .as_str()
            .map(|message| format!("协作服务器请求失败（HTTP {status}）：{message}"))
            .unwrap_or_else(|| format!("协作服务器请求失败（HTTP {status}）。")));
    }
    Ok(value)
}

async fn refresh_auth(
    state: &AppState,
    endpoint: &str,
    current: &AuthTokens,
) -> Result<AuthTokens, String> {
    let result = request_json(
        endpoint,
        "/auth/refresh",
        reqwest::Method::POST,
        None,
        Some(json!({"refreshToken": current.refresh_token})),
    )
    .await?;
    let user = result.get("user").ok_or("刷新登录状态缺少用户信息。")?;
    let next = AuthTokens {
        access_token: result["accessToken"]
            .as_str()
            .ok_or("刷新登录状态缺少访问令牌。")?
            .to_string(),
        refresh_token: result["refreshToken"]
            .as_str()
            .ok_or("刷新登录状态缺少刷新令牌。")?
            .to_string(),
        user_id: user["id"]
            .as_str()
            .ok_or("刷新登录状态缺少用户 ID。")?
            .to_string(),
        phone: user["phone"]
            .as_str()
            .ok_or("刷新登录状态缺少手机号。")?
            .to_string(),
    };
    write_auth(state, &next)?;
    Ok(next)
}

/// Refresh tokens rotate on use: two concurrent refreshes would leave the
/// second with a revoked token and sign the device out, so they take turns.
fn refresh_gate() -> &'static tokio::sync::Mutex<()> {
    static GATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// A valid access token, refreshing `stale` unless another request already did.
async fn fresh_token(state: &AppState, endpoint: &str, stale: &str) -> Result<String, String> {
    let _turn = refresh_gate().lock().await;
    let current = read_auth(state)?.ok_or("请先登录协作服务器。")?;
    if current.access_token != stale {
        return Ok(current.access_token);
    }
    Ok(refresh_auth(state, endpoint, &current).await?.access_token)
}

async fn auth_request(
    state: &AppState,
    endpoint: &str,
    path: &str,
    method: reqwest::Method,
    payload: Option<Value>,
) -> Result<Value, String> {
    let auth = read_auth(state)?.ok_or("请先登录协作服务器。")?;
    match request_json(
        endpoint,
        path,
        method.clone(),
        Some(&auth.access_token),
        payload.clone(),
    )
    .await
    {
        Err(error) if error.contains("HTTP 401") => {
            let token = fresh_token(state, endpoint, &auth.access_token).await?;
            request_json(endpoint, path, method, Some(&token), payload).await
        }
        result => result,
    }
}

async fn download_blob(state: &AppState, endpoint: &str, blob_id: &str) -> Result<Vec<u8>, String> {
    let response = auth_request(
        state,
        endpoint,
        &format!("/blobs/{blob_id}"),
        reqwest::Method::GET,
        None,
    )
    .await?;
    let url = response["downloadUrl"]
        .as_str()
        .ok_or("服务器没有返回 OSS 下载地址。")?;
    let response = reqwest::get(url)
        .await
        .map_err(|error| format!("OSS 下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("OSS 下载失败（HTTP {}）。", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > sync::MAX_FILE_BYTES {
        return Err("协作文件超过 200 MiB 限制。".into());
    }
    Ok(bytes.to_vec())
}

fn content_type_for_path(path: &str) -> &'static str {
    match path
        .rsplit_once('.')
        .map(|(_, extension)| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("pdf") => "application/pdf",
        Some("md") | Some("markdown") => "text/markdown; charset=utf-8",
        Some("txt") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
pub fn collaboration_status<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    snapshot(&state)
}

#[tauri::command]
pub fn collaboration_configure<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    endpoint: String,
    enabled: bool,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    let mut current = snapshot(&state)?;
    current.endpoint = normalize_endpoint(&endpoint)?;
    current.enabled = enabled;
    write(&state, &current)?;
    snapshot(&state)
}

#[tauri::command]
pub async fn collaboration_health<R: tauri::Runtime>(
    view: Webview<R>,
    endpoint: String,
) -> Result<Value, String> {
    trusted(&view)?;
    let endpoint = normalize_endpoint(&endpoint)?;
    request_json(&endpoint, "/health", reqwest::Method::GET, None, None).await
}

#[tauri::command]
pub async fn collaboration_send_code<R: tauri::Runtime>(
    view: Webview<R>,
    endpoint: String,
    phone: String,
) -> Result<Value, String> {
    trusted(&view)?;
    let endpoint = normalize_endpoint(&endpoint)?;
    request_json(
        &endpoint,
        "/auth/send-code",
        reqwest::Method::POST,
        None,
        Some(json!({"phone": phone.trim()})),
    )
    .await
}

#[tauri::command]
pub async fn collaboration_login<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    endpoint: String,
    phone: String,
    code: String,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    let endpoint = normalize_endpoint(&endpoint)?;
    let result = request_json(
        &endpoint,
        "/auth/login",
        reqwest::Method::POST,
        None,
        Some(json!({"phone": phone.trim(), "code": code.trim()})),
    )
    .await?;
    let user = result.get("user").ok_or("登录响应缺少用户信息。")?;
    let auth = AuthTokens {
        access_token: result["accessToken"]
            .as_str()
            .ok_or("登录响应缺少访问令牌。")?
            .to_string(),
        refresh_token: result["refreshToken"]
            .as_str()
            .ok_or("登录响应缺少刷新令牌。")?
            .to_string(),
        user_id: user["id"]
            .as_str()
            .ok_or("登录响应缺少用户 ID。")?
            .to_string(),
        phone: user["phone"]
            .as_str()
            .ok_or("登录响应缺少手机号。")?
            .to_string(),
    };
    write_auth(&state, &auth)?;
    let mut current = read(&state)?;
    current.endpoint = endpoint;
    current.enabled = true;
    write(&state, &current)?;
    snapshot(&state)
}

#[tauri::command]
pub async fn collaboration_logout<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    if let Some(auth) = read_auth(&state)? {
        let current = read(&state)?;
        let _ = request_json(
            &current.endpoint,
            "/auth/logout",
            reqwest::Method::POST,
            Some(&auth.access_token),
            Some(json!({"refreshToken": auth.refresh_token})),
        )
        .await;
    }
    clear_auth(&state)?;
    snapshot(&state)
}

fn token_expires_at(token: &str) -> Option<i64> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    serde_json::from_slice::<Value>(&bytes)
        .ok()?
        .get("exp")?
        .as_i64()
}

#[tauri::command]
pub async fn collaboration_access_token<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<String, String> {
    trusted(&view)?;
    let auth = read_auth(&state)?.ok_or("请先登录协作服务器。")?;
    let expires_at = token_expires_at(&auth.access_token).unwrap_or_default();
    if expires_at > chrono::Utc::now().timestamp() + 60 {
        return Ok(auth.access_token);
    }
    fresh_token(&state, &read(&state)?.endpoint, &auth.access_token).await
}

#[tauri::command]
pub async fn collaboration_projects<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    trusted(&view)?;
    let current = read(&state)?;
    auth_request(
        &state,
        &current.endpoint,
        "/projects",
        reqwest::Method::GET,
        None,
    )
    .await
}

/// Create a cloud project. Passing a local project's id publishes that project,
/// so its files and records stay linked to it on every device.
#[tauri::command]
pub async fn collaboration_create_project<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    name: String,
    project_id: Option<String>,
) -> Result<Value, String> {
    trusted(&view)?;
    let name = name.trim();
    if name.is_empty() || name.len() > 160 {
        return Err("协作项目名称无效。".into());
    }
    let mut payload = json!({"name": name});
    if let Some(id) = project_id {
        if !valid_token(&id, 80) || id.len() < 8 {
            return Err("协作项目标识无效。".into());
        }
        payload["id"] = json!(id);
    }
    let current = read(&state)?;
    auth_request(
        &state,
        &current.endpoint,
        "/projects",
        reqwest::Method::POST,
        Some(payload),
    )
    .await
}

#[tauri::command]
pub async fn collaboration_project_members<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Value, String> {
    trusted(&view)?;
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    let current = read(&state)?;
    auth_request(
        &state,
        &current.endpoint,
        &format!("/projects/{project_id}/members"),
        reqwest::Method::GET,
        None,
    )
    .await
}

#[tauri::command]
pub async fn collaboration_invite_member<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    phone: String,
    role: String,
) -> Result<Value, String> {
    trusted(&view)?;
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    let phone = phone.trim();
    if phone.is_empty() || phone.len() > 40 {
        return Err("手机号无效。".into());
    }
    if !matches!(role.as_str(), "editor" | "reviewer" | "viewer") {
        return Err("成员权限无效。".into());
    }
    let current = read(&state)?;
    auth_request(
        &state,
        &current.endpoint,
        &format!("/projects/{project_id}/members"),
        reqwest::Method::POST,
        Some(json!({"phone": phone, "role": role})),
    )
    .await
}

/// Remove a member or a pending invitation (`invite:<phone>`); members may remove themselves.
#[tauri::command]
pub async fn collaboration_remove_member<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    member_id: String,
) -> Result<Value, String> {
    trusted(&view)?;
    let target = match member_id.strip_prefix("invite:") {
        Some(phone)
            if !phone.is_empty()
                && phone.len() <= 20
                && phone.bytes().all(|b| b.is_ascii_digit()) =>
        {
            format!("invite%3A{phone}")
        }
        None if valid_token(&member_id, 80) => member_id.clone(),
        _ => return Err("成员标识无效。".into()),
    };
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    let current = read(&state)?;
    auth_request(
        &state,
        &current.endpoint,
        &format!("/projects/{project_id}/members/{target}"),
        reqwest::Method::DELETE,
        None,
    )
    .await
}

/// Bring one synced project up to date with the server, both ways.
#[tauri::command]
pub async fn collaboration_sync_project<R: tauri::Runtime>(
    view: Webview<R>,
    app: AppHandle<R>,
    project_id: String,
) -> Result<sync::Outcome, String> {
    trusted(&view)?;
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    let state = app.state::<AppState>();
    let config = snapshot(&state)?;
    if !config.enabled {
        return Err("协作同步已关闭。".into());
    }
    if !config.authenticated {
        return Err("请先登录协作账号。".into());
    }
    let _running = sync::Running::start(&project_id)?;
    if sync::load_state(state.storage.directory(), &project_id)?.paused {
        return Err("此设备上的项目同步已关闭。".into());
    }
    let _ = app.emit("collaboration-updated", json!({"projectId": project_id}));
    let library = app.state::<crate::library::LibraryState>();
    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|error| error.to_string())?;
    let device = sync::Device {
        storage: &state.storage,
        files: &state.files,
        library: &library.service,
        device_id: config.client_id.clone(),
        documents,
    };
    let remote = sync::Remote::Http {
        state: &state,
        endpoint: config.endpoint.clone(),
    };
    let result = async {
        let projects = auth_request(
            &state,
            &config.endpoint,
            "/projects",
            reqwest::Method::GET,
            None,
        )
        .await?;
        let member = projects["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| p["id"] == project_id);
        let role = member.and_then(|p| p["role"].as_str()).unwrap_or("viewer");
        if permissions::remember_role(&state.storage, &project_id, role)? {
            let _ = app.emit(
                "collaboration-synced",
                json!({"projectId": project_id, "changed":["project"]}),
            );
        }
        if member.is_none() {
            return Err("你已不再是此云端项目的成员。本机副本保留为只读。".into());
        }
        sync::sync(&device, &remote, &project_id).await
    }
    .await;
    if let Err(error) = &result {
        sync::record_error(state.storage.directory(), &project_id, error);
    }
    drop(_running);
    let _ = app.emit("collaboration-updated", json!({"projectId": project_id}));
    match result {
        Ok(outcome) => {
            let _ = app.emit(
                "collaboration-synced",
                json!({"projectId": project_id, "changed": outcome.changed}),
            );
            if outcome.changed.contains("library") {
                let _ = app.emit("library-changed", json!({"projectId": project_id}));
            }
            Ok(outcome)
        }
        Err(error) => Err(error),
    }
}

/// Local inspection shares the device mapping with the sync engine.
fn with_device<R: tauri::Runtime, T>(
    app: &AppHandle<R>,
    action: impl FnOnce(&sync::Device<'_>) -> Result<T, String>,
) -> Result<T, String> {
    let state = app.state::<AppState>();
    let library = app.state::<crate::library::LibraryState>();
    let device = sync::Device {
        storage: &state.storage,
        files: &state.files,
        library: &library.service,
        device_id: String::new(),
        documents: PathBuf::new(),
    };
    action(&device)
}

#[tauri::command]
pub async fn collaboration_sync_state<R: tauri::Runtime>(
    view: Webview<R>,
    app: AppHandle<R>,
    project_id: String,
) -> Result<Value, String> {
    trusted(&view)?;
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        with_device(&app, |device| {
            let current = sync::load_state(device.storage.directory(), &project_id)?;
            let pending = sync::resolution::pending(device, &project_id, &current);
            Ok(json!({
                "lastSyncAt": current.last_sync_at,
                "lastError": current.last_error.as_ref().or_else(|| pending.as_ref().err()),
                "conflicts": current.conflicts,
                "paused": current.paused,
                "syncing": sync::Running::contains(&project_id),
                "pending": pending.as_ref().ok(),
                "skipped": current.skipped,
                "deferred": current.deferred,
                "tracked": current.entries.values().filter(|entry| entry.hash.is_some()).count(),
                "libraryRoot": device.library.root(&project_id).ok().flatten().map(|p| p.display().to_string()),
            }))
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn collaboration_set_project_sync<R: tauri::Runtime>(
    view: Webview<R>,
    app: AppHandle<R>,
    project_id: String,
    enabled: bool,
) -> Result<(), String> {
    trusted(&view)?;
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _running = sync::Running::start(&project_id)?;
        sync::resolution::set_paused(
            app.state::<AppState>().storage.directory(),
            &project_id,
            !enabled,
        )?;
        drop(_running);
        let _ = app.emit("collaboration-updated", json!({"projectId": project_id}));
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn collaboration_conflict_preview<R: tauri::Runtime>(
    view: Webview<R>,
    app: AppHandle<R>,
    project_id: String,
    conflict: sync::resolution::ConflictKey,
) -> Result<sync::resolution::Preview, String> {
    trusted(&view)?;
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _running = sync::Running::start(&project_id)?;
        with_device(&app, |device| {
            sync::resolution::preview(device, &project_id, &conflict)
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn collaboration_resolve_conflict<R: tauri::Runtime>(
    view: Webview<R>,
    app: AppHandle<R>,
    project_id: String,
    conflict: sync::resolution::ConflictKey,
    token: String,
    choice: sync::resolution::Choice,
) -> Result<(), String> {
    trusted(&view)?;
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let _running = sync::Running::start(&project_id)?;
        with_device(&app, |device| {
            sync::resolution::resolve(device, &project_id, &conflict, &token, choice)
        })?;
        drop(_running);
        let _ = app.emit("collaboration-updated", json!({"projectId": project_id}));
        let _ = app.emit("library-changed", json!({"projectId": project_id}));
        let _ = app.emit(
            "collaboration-synced",
            json!({"projectId": project_id, "changed":[conflict.domain]}),
        );
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::{content_type_for_path, normalize_endpoint, CollaborationState, DEFAULT_ENDPOINT};

    #[test]
    fn endpoint_validation_keeps_a_clean_base_url() {
        assert_eq!(
            normalize_endpoint(" https://collab.example/ ").unwrap(),
            "https://collab.example"
        );
        assert_eq!(
            normalize_endpoint("http://127.0.0.1:8080///").unwrap(),
            "http://127.0.0.1:8080"
        );
        assert!(normalize_endpoint("ftp://collab.example").is_err());
        assert!(normalize_endpoint("https://user:pass@collab.example").is_err());
        assert!(normalize_endpoint("not a url").is_err());
    }

    #[test]
    fn new_installs_use_the_managed_endpoint() {
        let current = CollaborationState::default();
        assert!(current.enabled);
        assert_eq!(current.endpoint, DEFAULT_ENDPOINT);
        assert!(!current.authenticated);
    }

    #[test]
    fn content_type_uses_a_safe_default() {
        assert_eq!(content_type_for_path("paper.PDF"), "application/pdf");
        assert_eq!(
            content_type_for_path("notes.md"),
            "text/markdown; charset=utf-8"
        );
        assert_eq!(
            content_type_for_path("data.bin"),
            "application/octet-stream"
        );
    }
}
