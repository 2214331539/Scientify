//! Local collaboration configuration and sync bookkeeping.
//!
//! This first slice is transport-neutral. It stores the remote endpoint and an
//! offline-safe status snapshot; the HTTP/WebSocket client will consume this
//! contract when the collaboration server is available.

use crate::{library::trusted, AppState};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{State, Webview};

const FILE_NAME: &str = "collaboration.json";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CollaborationState {
    pub enabled: bool,
    pub endpoint: String,
    pub workspace_id: Option<String>,
    pub last_sync_at: Option<String>,
    pub pending_changes: u64,
    pub conflicts: u64,
}

fn path(state: &AppState) -> PathBuf {
    state.storage.directory().join(FILE_NAME)
}

fn read(state: &AppState) -> Result<CollaborationState, String> {
    let file = path(state);
    if !file.is_file() {
        return Ok(CollaborationState::default());
    }
    let bytes = fs::read(file).map_err(|error| error.to_string())?;
    serde_json::from_slice(&bytes).map_err(|_| "协作配置文件格式无效。".into())
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

#[tauri::command]
pub fn collaboration_status<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    read(&state)
}

#[tauri::command]
pub fn collaboration_configure<R: tauri::Runtime>(
    view: Webview<R>,
    state: State<'_, AppState>,
    endpoint: String,
    enabled: bool,
) -> Result<CollaborationState, String> {
    trusted(&view)?;
    let mut current = read(&state)?;
    current.endpoint = normalize_endpoint(&endpoint)?;
    current.enabled = enabled;
    write(&state, &current)?;
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::normalize_endpoint;

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
}
