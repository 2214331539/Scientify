//! Local collaboration configuration and sync bookkeeping.
//!
//! This first slice is transport-neutral. It stores the remote endpoint and an
//! offline-safe outbox; the HTTP/WebSocket client will consume these records
//! when the collaboration server is available.

use crate::{library::trusted, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{fs, path::PathBuf};
use tauri::{State, Webview};
use uuid::Uuid;

const FILE_NAME: &str = "collaboration.json";
const OUTBOX_FILE_NAME: &str = "collaboration-outbox.json";
const MAX_OUTBOX_ITEMS: usize = 10_000;
const MAX_OPERATION_BYTES: usize = 4 * 1024 * 1024;

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
    Ok(current)
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
        counts, normalize_endpoint, validate_operation, CollaborationOperation, OperationStatus,
        Outbox,
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
}
