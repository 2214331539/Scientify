//! Local collaboration configuration and sync bookkeeping.
//!
//! This first slice is transport-neutral. It stores the remote endpoint and an
//! offline-safe outbox; the HTTP/WebSocket client will consume these records
//! when the collaboration server is available.

use crate::{library::trusted, AppState};
use base64::Engine;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager, State, Webview};
use uuid::Uuid;

const FILE_NAME: &str = "collaboration.json";
const AUTH_FILE_NAME: &str = "collaboration-auth.json";
const OUTBOX_FILE_NAME: &str = "collaboration-outbox.json";
const INBOX_FILE_NAME: &str = "collaboration-inbox.json";
const MAX_OUTBOX_ITEMS: usize = 10_000;
const MAX_OPERATION_BYTES: usize = 4 * 1024 * 1024;
const MAX_BLOB_BYTES: u64 = 200 * 1024 * 1024;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct CollaborationState {
    pub client_id: String,
    pub enabled: bool,
    pub endpoint: String,
    pub workspace_id: Option<String>,
    pub last_sync_at: Option<String>,
    pub pending_changes: u64,
    pub conflicts: u64,
    pub sync_cursor: u64,
    pub authenticated: bool,
    pub user_id: Option<String>,
    pub phone: Option<String>,
    pub literature_bootstrapped: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthTokens {
    access_token: String,
    refresh_token: String,
    user_id: String,
    phone: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationOperation {
    pub operation_id: String,
    pub client_id: String,
    pub project_id: String,
    pub domain: String,
    pub entity_id: String,
    pub base_revision: u64,
    pub kind: String,
    pub payload: Value,
    pub created_at: String,
    #[serde(default)]
    pub status: OperationStatus,
    #[serde(default)]
    pub attempt_count: u32,
    #[serde(default)]
    pub conflict_revision: Option<u64>,
    pub last_error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum OperationStatus {
    #[default]
    Pending,
    Conflict,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Outbox {
    operations: Vec<CollaborationOperation>,
}

fn path(state: &AppState) -> PathBuf {
    state.storage.directory().join(FILE_NAME)
}

fn outbox_path(state: &AppState) -> PathBuf {
    state.storage.directory().join(OUTBOX_FILE_NAME)
}

fn auth_path(state: &AppState) -> PathBuf {
    state.storage.directory().join(AUTH_FILE_NAME)
}
fn inbox_path(state: &AppState) -> PathBuf {
    state.storage.directory().join(INBOX_FILE_NAME)
}

fn read(state: &AppState) -> Result<CollaborationState, String> {
    let file = path(state);
    if !file.is_file() {
        return Ok(CollaborationState::default());
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "协作配置文件格式无效。".into())
}

fn read_outbox(state: &AppState) -> Result<Outbox, String> {
    let file = outbox_path(state);
    if !file.is_file() {
        return Ok(Outbox::default());
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    let outbox: Outbox =
        serde_json::from_slice(&bytes).map_err(|_| "协作待同步队列格式无效。".to_string())?;
    if outbox.operations.len() > MAX_OUTBOX_ITEMS {
        return Err("协作待同步队列超过上限。".into());
    }
    Ok(outbox)
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

fn write_outbox(state: &AppState, outbox: &Outbox) -> Result<(), String> {
    if outbox.operations.len() > MAX_OUTBOX_ITEMS {
        return Err("协作待同步队列超过上限。".into());
    }
    let bytes = serde_json::to_vec_pretty(outbox).map_err(|error| error.to_string())?;
    scientify_core::storage::write_atomic_bytes(&outbox_path(state), &bytes)
}

fn write(state: &AppState, value: &CollaborationState) -> Result<(), String> {
    let target = path(state);
    let bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    scientify_core::storage::write_atomic_bytes(&target, &bytes)
}

fn read_inbox(state: &AppState) -> Result<Vec<Value>, String> {
    let file = inbox_path(state);
    if !file.is_file() {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&fs::read(file).map_err(|error| error.to_string())?)
        .map_err(|_| "协作远端变更缓存格式无效。".into())
}

fn write_inbox(state: &AppState, changes: &[Value]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(changes).map_err(|error| error.to_string())?;
    scientify_core::storage::write_atomic_bytes(&inbox_path(state), &bytes)
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
    if bytes.len() as u64 > MAX_BLOB_BYTES {
        return Err("协作文件超过 200 MiB 限制。".into());
    }
    Ok(bytes.to_vec())
}

fn change_error(change: &Value, message: impl Into<String>) -> Value {
    json!({
        "operationId": change["operationId"],
        "clientId": change["clientId"],
        "domain": change["domain"],
        "entityId": change["entityId"],
        "kind": change["kind"],
        "payload": change["payload"],
        "error": message.into(),
    })
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

fn validate_operation(operation: &CollaborationOperation) -> Result<(), String> {
    if !valid_token(&operation.operation_id, 80)
        || !valid_token(&operation.client_id, 80)
        || !valid_token(&operation.project_id, 80)
        || !valid_token(&operation.domain, 40)
        || !valid_token(&operation.entity_id, 160)
        || !valid_token(&operation.kind, 80)
        || operation.created_at.trim().is_empty()
        || operation.created_at.len() > 120
    {
        return Err("协作变更标识无效。".into());
    }
    let bytes = serde_json::to_vec(&operation.payload).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_OPERATION_BYTES {
        return Err("单条协作变更过大。".into());
    }
    Ok(())
}

fn counts(outbox: &Outbox) -> (u64, u64) {
    outbox
        .operations
        .iter()
        .fold((0, 0), |(pending, conflicts), operation| {
            match operation.status {
                OperationStatus::Pending => (pending + 1, conflicts),
                OperationStatus::Conflict => (pending, conflicts + 1),
            }
        })
}

fn snapshot(state: &AppState) -> Result<CollaborationState, String> {
    let mut current = read(state)?;
    if current.client_id.is_empty() {
        current.client_id = Uuid::new_v4().to_string();
        write(state, &current)?;
    }
    let outbox = read_outbox(state)?;
    let (pending_changes, conflicts) = counts(&outbox);
    current.pending_changes = pending_changes;
    current.conflicts = conflicts;
    if let Some(auth) = read_auth(state)? {
        current.authenticated = true;
        current.user_id = Some(auth.user_id);
        current.phone = Some(auth.phone);
    } else {
        current.authenticated = false;
        current.user_id = None;
        current.phone = None;
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
    let client = reqwest::Client::new();
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
        Ok(value) => Ok(value),
        Err(error) if error.contains("HTTP 401") => {
            let refreshed = refresh_auth(state, endpoint, &auth).await?;
            request_json(
                endpoint,
                path,
                method,
                Some(&refreshed.access_token),
                payload,
            )
            .await
        }
        Err(error) => Err(error),
    }
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

async fn upload_blob(
    state: &AppState,
    endpoint: &str,
    project_id: &str,
    bytes: Vec<u8>,
    content_type: &str,
) -> Result<Value, String> {
    if bytes.len() as u64 > MAX_BLOB_BYTES {
        return Err("协作文件超过 200 MiB 限制。".into());
    }
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let presign = auth_request(
        state,
        endpoint,
        &format!("/projects/{project_id}/blobs/presign-upload"),
        reqwest::Method::POST,
        Some(json!({"sha256": sha256, "size": bytes.len(), "contentType": content_type})),
    )
    .await?;
    if presign["existing"] == true {
        return Ok(presign);
    }
    let upload_url = presign["uploadUrl"]
        .as_str()
        .ok_or("服务器没有返回 OSS 上传地址。")?;
    let response = reqwest::Client::new()
        .put(upload_url)
        .header("content-type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|error| format!("OSS 上传失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("OSS 上传失败（HTTP {}）。", response.status()));
    }
    let blob_id = presign["blob"]["id"]
        .as_str()
        .ok_or("服务器没有返回文件标识。")?;
    let completed = auth_request(
        state,
        endpoint,
        &format!("/blobs/{blob_id}/complete"),
        reqwest::Method::POST,
        None,
    )
    .await?;
    Ok(json!({"path": "", "blob": completed["blob"], "sha256": sha256}))
}

fn has_queued_operation(outbox: &Outbox, kind: &str, path: &str) -> bool {
    outbox
        .operations
        .iter()
        .any(|operation| operation.kind == kind && operation.payload["path"].as_str() == Some(path))
}

fn pending_operation(
    current: &CollaborationState,
    project_id: &str,
    entity_id: String,
    kind: &str,
    payload: Value,
) -> CollaborationOperation {
    CollaborationOperation {
        operation_id: Uuid::new_v4().to_string(),
        client_id: current.client_id.clone(),
        project_id: project_id.into(),
        domain: "literature".into(),
        entity_id,
        base_revision: 0,
        kind: kind.into(),
        payload,
        created_at: Utc::now().to_rfc3339(),
        status: OperationStatus::Pending,
        attempt_count: 0,
        conflict_revision: None,
        last_error: None,
    }
}

fn retry_operation(operation: &mut CollaborationOperation) -> Result<(), String> {
    if operation.status != OperationStatus::Conflict {
        return Err("只有冲突变更可以重试。".into());
    }
    let revision = operation
        .conflict_revision
        .ok_or("冲突缺少远端版本，无法安全重试。")?;
    operation.base_revision = revision;
    operation.status = OperationStatus::Pending;
    operation.conflict_revision = None;
    operation.last_error = None;
    Ok(())
}

fn remote_project(state: &AppState) -> Result<(CollaborationState, String), String> {
    let current = read(state)?;
    let project_id = current
        .workspace_id
        .clone()
        .ok_or("尚未绑定协作项目。".to_string())?;
    Ok((current, project_id))
}

#[tauri::command]
pub async fn collaboration_upload_file<R: tauri::Runtime>(
    app: AppHandle<R>,
    view: Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<Value, String> {
    trusted(&view)?;
    let (current, remote_id) = remote_project(&state)?;
    let file_path = app
        .state::<crate::library::LibraryState>()
        .service
        .external_path(&project_id, &path)?;
    let bytes = tokio::fs::read(&file_path)
        .await
        .map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BLOB_BYTES {
        return Err("协作文件超过 200 MiB 限制。".into());
    }
    let content_type = content_type_for_path(&path);
    let mut uploaded =
        upload_blob(&state, &current.endpoint, &remote_id, bytes, content_type).await?;
    uploaded["path"] = Value::String(path);
    Ok(uploaded)
}

#[tauri::command]
pub async fn collaboration_download_blob<R: tauri::Runtime>(
    app: AppHandle<R>,
    view: Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    blob_id: String,
    path: String,
) -> Result<(), String> {
    trusted(&view)?;
    let (current, _) = remote_project(&state)?;
    let url = auth_request(
        &state,
        &current.endpoint,
        &format!("/blobs/{blob_id}"),
        reqwest::Method::GET,
        None,
    )
    .await?;
    let download_url = url["downloadUrl"]
        .as_str()
        .ok_or("服务器没有返回 OSS 下载地址。")?;
    let response = reqwest::get(download_url)
        .await
        .map_err(|error| format!("OSS 下载失败：{error}"))?;
    if !response.status().is_success() {
        return Err(format!("OSS 下载失败（HTTP {}）。", response.status()));
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BLOB_BYTES {
        return Err("协作文件超过 200 MiB 限制。".into());
    }
    let target = app
        .state::<crate::library::LibraryState>()
        .service
        .external_path(&project_id, &path)?;
    if let Some(parent) = target.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    tokio::fs::write(target, bytes)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn collaboration_delete_blob<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    blob_id: String,
) -> Result<Value, String> {
    trusted(&view)?;
    let (current, _) = remote_project(&state)?;
    auth_request(
        &state,
        &current.endpoint,
        &format!("/blobs/{blob_id}"),
        reqwest::Method::DELETE,
        None,
    )
    .await
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
pub fn collaboration_logout<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
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
    let current = read(&state)?;
    let expires_at = token_expires_at(&auth.access_token).unwrap_or_default();
    if expires_at > chrono::Utc::now().timestamp() + 60 {
        return Ok(auth.access_token);
    }
    Ok(refresh_auth(&state, &current.endpoint, &auth)
        .await?
        .access_token)
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

#[tauri::command]
pub fn collaboration_bind_project<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    if !valid_token(&project_id, 80) {
        return Err("协作项目标识无效。".into());
    }
    let mut current = read(&state)?;
    if current.workspace_id.as_deref() != Some(&project_id) {
        current.literature_bootstrapped = false;
    }
    current.workspace_id = Some(project_id);
    current.sync_cursor = 0;
    write(&state, &current)?;
    snapshot(&state)
}

/// Upload the existing local literature tree once after a project is bound.
/// Each operation is persisted immediately so closing the app is safe and a
/// later retry only processes the remaining files.
#[tauri::command]
pub async fn collaboration_bootstrap_literature<R: tauri::Runtime>(
    app: AppHandle<R>,
    view: Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Value, String> {
    trusted(&view)?;
    let (mut current, remote_id) = remote_project(&state)?;
    if current.literature_bootstrapped {
        return Ok(json!({"uploaded": 0, "queued": 0, "skipped": 0, "complete": true}));
    }
    let service = app.state::<crate::library::LibraryState>().service.clone();
    let initial = {
        let service = service.clone();
        let project_id = project_id.clone();
        tauri::async_runtime::spawn_blocking(move || service.scan(&project_id))
            .await
            .map_err(|error| error.to_string())??
    };
    if initial.root.is_none() {
        return Err("请先打开文献文件夹，再初始化协作同步。".into());
    }
    let unbound: Vec<String> = initial
        .entries
        .iter()
        .filter(|entry| entry.pdf && entry.paper_id.is_none())
        .map(|entry| entry.path.clone())
        .collect();
    for path in unbound {
        let service = service.clone();
        let project_id = project_id.clone();
        tauri::async_runtime::spawn_blocking(move || service.open(&project_id, &path))
            .await
            .map_err(|error| error.to_string())??;
    }
    let scan = {
        let service = service.clone();
        let project_id = project_id.clone();
        tauri::async_runtime::spawn_blocking(move || service.scan(&project_id))
            .await
            .map_err(|error| error.to_string())??
    };
    let mut outbox = read_outbox(&state)?;
    let mut uploaded = 0u64;
    let mut queued = 0u64;
    let mut skipped = 0u64;
    for binding in scan.papers {
        let paper_path = binding.path.clone();
        let file_path = service.external_path(&project_id, &paper_path)?;
        let bytes = tokio::fs::read(&file_path)
            .await
            .map_err(|error| error.to_string())?;
        let upload = upload_blob(
            &state,
            &current.endpoint,
            &remote_id,
            bytes,
            content_type_for_path(&paper_path),
        )
        .await?;
        let blob_id = upload["blob"]["id"]
            .as_str()
            .ok_or("服务器没有返回文件标识。")?
            .to_string();
        uploaded += 1;
        if has_queued_operation(&outbox, "import", &paper_path) {
            skipped += 1;
        } else {
            outbox.operations.push(pending_operation(
                &current,
                &remote_id,
                binding.id.clone(),
                "import",
                json!({
                    "path": paper_path,
                    "name": PathBuf::from(&binding.path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .unwrap_or("paper.pdf"),
                    "blobId": blob_id,
                }),
            ));
            write_outbox(&state, &outbox)?;
            queued += 1;
        }
        let note = {
            let service = service.clone();
            let project_id = project_id.clone();
            let id = binding.id.clone();
            tauri::async_runtime::spawn_blocking(move || service.note(&project_id, &id))
                .await
                .map_err(|error| error.to_string())??
        };
        if !note.content.is_empty() && !has_queued_operation(&outbox, "note-upsert", &binding.id) {
            outbox.operations.push(pending_operation(
                &current,
                &remote_id,
                binding.id.clone(),
                "note-upsert",
                json!({
                    "path": binding.id,
                    "content": note.content,
                    "revision": note.revision,
                }),
            ));
            write_outbox(&state, &outbox)?;
            queued += 1;
        }
    }
    current.literature_bootstrapped = true;
    write(&state, &current)?;
    snapshot(&state).map(|_| {
        json!({
            "uploaded": uploaded,
            "queued": queued,
            "skipped": skipped,
            "complete": true,
        })
    })
}

#[tauri::command]
pub async fn collaboration_sync<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    let mut current = read(&state)?;
    let project_id = current.workspace_id.clone().ok_or("尚未绑定协作项目。")?;
    let outbox = read_outbox(&state)?;
    let operations: Vec<_> = outbox
        .operations
        .iter()
        .filter(|operation| operation.status == OperationStatus::Pending)
        .cloned()
        .collect();
    let result = auth_request(
        &state,
        &current.endpoint,
        &format!("/projects/{project_id}/sync"),
        reqwest::Method::POST,
        Some(json!({"cursor": current.sync_cursor, "operations": operations})),
    )
    .await?;
    let mut next_outbox = outbox;
    if let Some(accepted) = result["accepted"].as_array() {
        for item in accepted {
            if let Some(id) = item["operationId"].as_str() {
                next_outbox
                    .operations
                    .retain(|operation| operation.operation_id != id);
            }
        }
    }
    if let Some(conflicts) = result["conflicts"].as_array() {
        for item in conflicts {
            if let Some(id) = item["operationId"].as_str() {
                if let Some(operation) = next_outbox
                    .operations
                    .iter_mut()
                    .find(|operation| operation.operation_id == id)
                {
                    operation.status = OperationStatus::Conflict;
                    operation.conflict_revision = item["serverRevision"].as_u64();
                    operation.last_error = item["message"].as_str().map(str::to_string);
                }
            }
        }
    }
    write_outbox(&state, &next_outbox)?;
    if let Some(changes) = result["changes"].as_array() {
        let mut inbox = read_inbox(&state)?;
        for change in changes {
            let operation_id = change["operationId"].as_str();
            if operation_id.is_none()
                || !inbox
                    .iter()
                    .any(|existing| existing["operationId"].as_str() == operation_id)
            {
                inbox.push(change.clone());
            }
        }
        write_inbox(&state, &inbox)?;
    }
    current.sync_cursor = result["nextCursor"].as_u64().unwrap_or(current.sync_cursor);
    current.last_sync_at = Some(Utc::now().to_rfc3339());
    write(&state, &current)?;
    snapshot(&state)
}

#[tauri::command]
pub fn collaboration_inbox<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<Vec<Value>, String> {
    trusted(&view)?;
    read_inbox(&state)
}

#[tauri::command]
pub fn collaboration_discard_inbox<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    if !valid_token(&operation_id, 80) {
        return Err("协作变更标识无效。".into());
    }
    let mut changes = read_inbox(&state)?;
    let original_len = changes.len();
    changes.retain(|change| change["operationId"].as_str() != Some(&operation_id));
    if changes.len() == original_len {
        return Err("远端延期变更不存在。".into());
    }
    write_inbox(&state, &changes)?;
    snapshot(&state)
}

#[tauri::command]
pub async fn collaboration_apply_inbox<R: tauri::Runtime>(
    app: AppHandle<R>,
    view: Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Value, String> {
    trusted(&view)?;
    let (current, _) = remote_project(&state)?;
    let changes = read_inbox(&state)?;
    if changes.is_empty() {
        return Ok(json!({"applied": 0, "deferred": 0}));
    }
    let service = app.state::<crate::library::LibraryState>().service.clone();
    let mut deferred = Vec::new();
    let mut applied = 0u64;
    let mut changed_files = false;
    for change in changes {
        if change["domain"] != "literature" {
            deferred.push(change_error(&change, "暂不支持此协作领域。"));
            continue;
        }
        // A client already applied its own operation locally. Removing it from
        // the inbox is safe and prevents a second application after restart.
        if change["clientId"].as_str() == Some(&current.client_id) {
            applied += 1;
            continue;
        }
        let payload = &change["payload"];
        let result = match change["kind"].as_str().unwrap_or_default() {
            "note-upsert" => {
                let id = payload["path"].as_str().ok_or("远端笔记缺少文献标识。")?;
                let content = payload["content"].as_str().ok_or("远端笔记缺少正文。")?;
                let local = service.note(&project_id, id)?;
                if local.content == content {
                    Ok(())
                } else if local.content.is_empty() {
                    service
                        .save_note(&project_id, id, content, local.revision.as_deref(), None)
                        .map(|_| ())
                } else {
                    Err("本地笔记已有不同内容，已保留本地版本。".into())
                }
            }
            "import" => {
                let path = payload["path"].as_str().ok_or("远端文件缺少路径。")?;
                let blob_id = payload["blobId"]
                    .as_str()
                    .ok_or("远端文件缺少 OSS 标识。")?;
                let target = service.external_path(&project_id, path)?;
                if target.exists() {
                    Err("本地已存在同名文件，已保留本地文件。".into())
                } else {
                    let bytes = download_blob(&state, &current.endpoint, blob_id).await?;
                    if let Some(parent) = target.parent() {
                        tokio::fs::create_dir_all(parent)
                            .await
                            .map_err(|error| error.to_string())?;
                    }
                    tokio::fs::write(target, bytes)
                        .await
                        .map_err(|error| error.to_string())?;
                    changed_files = true;
                    Ok(())
                }
            }
            "mkdir" | "move" | "copy" | "delete" | "relink" => {
                let operation: scientify_core::library::Operation =
                    serde_json::from_value(payload.clone())
                        .map_err(|_| "远端文献操作格式无效。")?;
                service.operate(&project_id, operation).map(|_| ())
            }
            _ => Err("暂不支持此文献变更类型。".into()),
        };
        match result {
            Ok(()) => applied += 1,
            Err(error) => deferred.push(change_error(&change, error)),
        }
    }
    if changed_files {
        service.operate(&project_id, scientify_core::library::Operation::Scan)?;
    }
    write_inbox(&state, &deferred)?;
    Ok(json!({"applied": applied, "deferred": deferred.len()}))
}

#[tauri::command]
pub fn collaboration_enqueue<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    mut operation: CollaborationOperation,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    validate_operation(&operation)?;
    let mut outbox = read_outbox(&state)?;
    if outbox
        .operations
        .iter()
        .any(|item| item.operation_id == operation.operation_id)
    {
        return snapshot(&state);
    }
    operation.status = OperationStatus::Pending;
    operation.attempt_count = 0;
    operation.conflict_revision = None;
    operation.last_error = None;
    outbox.operations.push(operation);
    write_outbox(&state, &outbox)?;
    snapshot(&state)
}

#[tauri::command]
pub fn collaboration_outbox<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<Vec<CollaborationOperation>, String> {
    trusted(&view)?;
    Ok(read_outbox(&state)?.operations)
}

#[tauri::command]
pub fn collaboration_acknowledge<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    if !valid_token(&operation_id, 80) {
        return Err("协作变更标识无效。".into());
    }
    let mut outbox = read_outbox(&state)?;
    outbox
        .operations
        .retain(|operation| operation.operation_id != operation_id);
    write_outbox(&state, &outbox)?;
    snapshot(&state)
}

#[tauri::command]
pub fn collaboration_retry_conflict<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    if !valid_token(&operation_id, 80) {
        return Err("协作变更标识无效。".into());
    }
    let mut outbox = read_outbox(&state)?;
    let operation = outbox
        .operations
        .iter_mut()
        .find(|operation| operation.operation_id == operation_id)
        .ok_or("协作冲突不存在。")?;
    retry_operation(operation)?;
    write_outbox(&state, &outbox)?;
    snapshot(&state)
}

#[tauri::command]
pub fn collaboration_mark_conflict<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    operation_id: String,
    message: String,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    if !valid_token(&operation_id, 80) {
        return Err("协作变更标识无效。".into());
    }
    if message.trim().is_empty() || message.len() > 2000 {
        return Err("协作冲突说明无效。".into());
    }
    let mut outbox = read_outbox(&state)?;
    let operation = outbox
        .operations
        .iter_mut()
        .find(|operation| operation.operation_id == operation_id)
        .ok_or("协作变更不存在。")?;
    operation.status = OperationStatus::Conflict;
    operation.last_error = Some(message);
    write_outbox(&state, &outbox)?;
    snapshot(&state)
}

#[cfg(test)]
mod tests {
    use super::{
        content_type_for_path, counts, has_queued_operation, normalize_endpoint, retry_operation,
        validate_operation, CollaborationOperation, OperationStatus, Outbox,
    };
    use serde_json::json;

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

    fn operation() -> CollaborationOperation {
        CollaborationOperation {
            operation_id: "op-1".into(),
            client_id: "client-1".into(),
            project_id: "project-1".into(),
            domain: "literature".into(),
            entity_id: "paper-1".into(),
            base_revision: 4,
            kind: "upsert".into(),
            payload: json!({"title": "A paper"}),
            created_at: "2026-10-29T00:00:00Z".into(),
            status: OperationStatus::Pending,
            attempt_count: 0,
            conflict_revision: None,
            last_error: None,
        }
    }

    #[test]
    fn operation_validation_rejects_path_like_identifiers() {
        let mut value = operation();
        value.entity_id = "C:\\secret\\file".into();
        assert!(validate_operation(&value).is_err());
    }

    #[test]
    fn outbox_counts_pending_and_conflict_operations() {
        let mut conflict = operation();
        conflict.operation_id = "op-2".into();
        conflict.status = OperationStatus::Conflict;
        let outbox = Outbox {
            operations: vec![operation(), conflict],
        };
        assert_eq!(counts(&outbox), (1, 1));
    }

    #[test]
    fn bootstrap_deduplicates_by_operation_kind_and_path() {
        let mut value = operation();
        value.kind = "import".into();
        value.payload = json!({"path": "papers/a.pdf"});
        let outbox = Outbox {
            operations: vec![value],
        };
        assert!(has_queued_operation(&outbox, "import", "papers/a.pdf"));
        assert!(!has_queued_operation(
            &outbox,
            "note-upsert",
            "papers/a.pdf"
        ));
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

    #[test]
    fn retry_conflict_rebases_to_the_server_revision() {
        let mut value = operation();
        value.status = OperationStatus::Conflict;
        value.conflict_revision = Some(7);
        value.base_revision = 3;
        value.last_error = Some("changed remotely".into());
        retry_operation(&mut value).unwrap();
        assert_eq!(value.base_revision, 7);
        assert_eq!(value.status, OperationStatus::Pending);
        assert!(value.conflict_revision.is_none());
        assert!(value.last_error.is_none());
    }
}
