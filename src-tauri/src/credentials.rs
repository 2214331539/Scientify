//! Plaintext credential storage for model providers.
//!
//! Keys live in one JSON file inside the application data directory: never in
//! `workspace.json`, never in the repository. This mirrors how comparable tools
//! store provider keys — a file the user can read, replace, or delete by hand —
//! and it is deliberately not encrypted, so the file must stay on this machine.

use super::AppState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;

const FILE: &str = "credentials.json";
const NOTE: &str = "本文件保存模型服务商的 API 密钥，未加密。请勿提交到版本库或分享给他人。";
const MAX_KEY: usize = 4096;
const MAX_ENTRIES: usize = 200;
static WRITES: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize)]
struct Store {
    version: u32,
    #[serde(default)]
    note: String,
    #[serde(default)]
    credentials: BTreeMap<String, String>,
}

impl Default for Store {
    fn default() -> Self {
        Self {
            version: 1,
            note: NOTE.to_string(),
            credentials: BTreeMap::new(),
        }
    }
}

/// One slot per provider endpoint, so switching away and back restores the key
/// instead of forcing it to be typed again.
fn slot(provider: &str, endpoint: &str) -> Result<String, String> {
    let provider = provider.trim();
    let endpoint = endpoint.trim().trim_end_matches('/');
    if provider.is_empty() || provider.len() > 64 || provider.chars().any(char::is_control) {
        return Err("模型服务商标识无效。".into());
    }
    if endpoint.is_empty() || endpoint.len() > 2048 || endpoint.chars().any(char::is_control) {
        return Err("模型服务地址无效。".into());
    }
    Ok(format!("{provider}|{endpoint}"))
}

fn path(directory: &Path) -> PathBuf {
    directory.join(FILE)
}

fn read(directory: &Path) -> Result<Store, String> {
    scientify_core::research::reject_links(&path(directory))?;
    match std::fs::read(path(directory)) {
        Ok(bytes) => {
            let mut store: Store = serde_json::from_slice(&bytes)
                .map_err(|_| "凭据文件无法解析，请保留原文件并重新配置模型。".to_string())?;
            store.note = NOTE.to_string();
            Ok(store)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(error) => Err(format!("无法读取凭据文件：{error}")),
    }
}

fn write(directory: &Path, store: &Store) -> Result<(), String> {
    scientify_core::research::reject_links(directory)?;
    std::fs::create_dir_all(directory).map_err(|e| format!("无法创建数据目录：{e}"))?;
    let target = path(directory);
    let pending = target.with_extension("pending.json");
    scientify_core::research::reject_links(&target)?;
    scientify_core::research::reject_links(&pending)?;
    let text = serde_json::to_vec_pretty(store).map_err(|e| format!("无法写入凭据：{e}"))?;
    std::fs::write(&pending, text).map_err(|e| format!("无法写入凭据：{e}"))?;
    std::fs::rename(&pending, &target).map_err(|e| format!("无法写入凭据：{e}"))
}

// Serialize the entire read-modify-write operation across both native windows.
fn update(
    directory: &Path,
    edit: impl FnOnce(&mut Store) -> Result<bool, String>,
) -> Result<(), String> {
    let _guard = WRITES.lock().map_err(|e| e.to_string())?;
    let mut data = read(directory)?;
    if edit(&mut data)? {
        write(directory, &data)?;
    }
    Ok(())
}

fn store(project: &State<'_, AppState>) -> Result<PathBuf, String> {
    Ok(project.storage.directory().to_path_buf())
}

#[tauri::command]
pub async fn secret_save(
    view: tauri::Webview,
    state: State<'_, AppState>,
    provider: String,
    endpoint: String,
    api_key: String,
) -> Result<(), String> {
    super::library::trusted(&view)?;
    let key = api_key.trim();
    if key.is_empty() || key.len() > MAX_KEY || key.chars().any(char::is_control) {
        return Err("API 密钥无效。".into());
    }
    let slot = slot(&provider, &endpoint)?;
    let directory = store(&state)?;
    update(&directory, |data| {
        if data.credentials.len() >= MAX_ENTRIES && !data.credentials.contains_key(&slot) {
            return Err("已保存的模型凭据过多，请先清理不再使用的服务商。".into());
        }
        data.credentials.insert(slot, key.to_string());
        Ok(true)
    })
}

#[tauri::command]
pub async fn secret_load(
    view: tauri::Webview,
    state: State<'_, AppState>,
    provider: String,
    endpoint: String,
) -> Result<Option<String>, String> {
    super::library::trusted(&view)?;
    let slot = slot(&provider, &endpoint)?;
    Ok(read(&store(&state)?)?.credentials.remove(&slot))
}

#[tauri::command]
pub async fn secret_clear(
    view: tauri::Webview,
    state: State<'_, AppState>,
    provider: String,
    endpoint: String,
) -> Result<(), String> {
    super::library::trusted(&view)?;
    let slot = slot(&provider, &endpoint)?;
    let directory = store(&state)?;
    update(&directory, |data| {
        Ok(data.credentials.remove(&slot).is_some())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary() -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "scientify-credentials-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&directory);
        directory
    }

    #[test]
    fn a_slot_ignores_a_trailing_slash_and_surrounding_space() {
        assert_eq!(
            slot("openai", "https://api.openai.com/v1/").unwrap(),
            slot(" openai ", " https://api.openai.com/v1").unwrap()
        );
        // The endpoint identifies the account, so a different host is a different slot.
        assert_ne!(
            slot("openai", "https://api.openai.com/v1").unwrap(),
            slot("openai", "https://gateway.example/v1").unwrap()
        );
        assert!(slot("", "https://api.openai.com/v1").is_err());
        assert!(slot("openai", "").is_err());
    }

    #[test]
    fn keys_round_trip_per_endpoint_and_survive_a_later_write_to_another_slot() {
        let directory = temporary();
        let mut data = Store::default();
        data.credentials
            .insert(slot("openai", "https://a/v1").unwrap(), "sk-a".into());
        data.credentials
            .insert(slot("openai", "https://b/v1").unwrap(), "sk-b".into());
        write(&directory, &data).unwrap();

        let loaded = read(&directory).unwrap();
        assert_eq!(
            loaded
                .credentials
                .get(&slot("openai", "https://a/v1").unwrap()),
            Some(&"sk-a".to_string())
        );
        // Two endpoints of the same vendor are different accounts, so they keep
        // separate keys and switching back restores the right one.
        assert_eq!(
            loaded
                .credentials
                .get(&slot("openai", "https://b/v1").unwrap()),
            Some(&"sk-b".to_string())
        );
        // Removing the note the file already carries keeps the payload stable.
        assert_eq!(loaded.note, NOTE);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn a_missing_file_reads_as_empty_and_a_corrupt_one_is_reported() {
        let directory = temporary();
        assert!(read(&directory).unwrap().credentials.is_empty());
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(path(&directory), "{not json").unwrap();
        // A damaged file must be surfaced rather than silently overwritten.
        match read(&directory) {
            Ok(_) => panic!("a damaged file must not read as an empty store"),
            Err(message) => assert!(message.contains("无法解析")),
        }
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn simultaneous_window_updates_keep_all_provider_keys_and_clear_only_the_requested_slot() {
        let directory = tempfile::tempdir().unwrap();
        let barrier = std::sync::Barrier::new(8);
        std::thread::scope(|scope| {
            for index in 0..8 {
                let barrier = &barrier;
                let root = directory.path();
                scope.spawn(move || {
                    barrier.wait();
                    update(root, |data| {
                        data.credentials
                            .insert(format!("provider-{index}"), format!("test-{index}"));
                        Ok(true)
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(read(directory.path()).unwrap().credentials.len(), 8);
        update(directory.path(), |data| {
            Ok(data.credentials.remove("provider-3").is_some())
        })
        .unwrap();
        let remaining = read(directory.path()).unwrap();
        assert_eq!(remaining.credentials.len(), 7);
        assert!(!remaining.credentials.contains_key("provider-3"));
    }
}
