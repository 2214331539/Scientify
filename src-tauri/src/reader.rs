use crate::AppState;
use scientify_core::storage::write_atomic_bytes;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{fs, path::Path, sync::Mutex};
use tauri::State;

// Serializes the short read/compare/atomic-replace transaction across app windows.
static METADATA_GATE: Mutex<()> = Mutex::new(());

#[derive(Deserialize, Serialize)]
pub(crate) struct OutlineRecord {
    outline: Option<Value>,
    revision: Option<String>,
}

fn metadata(
    directory: &Path,
    fingerprint: &str,
    outline: Option<Value>,
    expected: Option<&str>,
) -> Result<OutlineRecord, String> {
    if !(16..=128).contains(&fingerprint.len())
        || !fingerprint.bytes().all(|c| c.is_ascii_hexdigit())
    {
        return Err("PDF 指纹无效。".into());
    }
    // The gate guards no data, so a panic elsewhere must not lock outlines forever.
    let _guard = METADATA_GATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let root = directory.join("reader").join("outlines");
    let path = root.join(format!("{fingerprint}.json"));
    let bytes = match fs::read(&path) {
        Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => Some(bytes),
        Ok(_) => return Err("PDF 目录数据超过大小限制。".into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let revision = bytes.as_ref().map(|b| format!("{:x}", Sha256::digest(b)));
    if let Some(outline) = outline {
        if revision.as_deref() != expected {
            return Err("目录已在其他窗口更新，请重新载入。".into());
        }
        let entries = outline["entries"].as_array().ok_or("PDF 目录格式无效。")?;
        if outline["version"] != 1
            || entries.len() > 10000
            || entries.iter().any(|entry| {
                entry["title"]
                    .as_str()
                    .is_none_or(|s| s.trim().is_empty() || s.len() > 4096)
                    || entry["page"].as_u64().is_none_or(|p| p == 0 || p > 100000)
                    || entry["level"].as_u64().is_none_or(|l| l > 32)
                    || entry["id"]
                        .as_str()
                        .is_none_or(|s| s.is_empty() || s.len() > 256)
            })
        {
            return Err("PDF 目录格式无效。".into());
        }
        let bytes = serde_json::to_vec(&outline).map_err(|e| e.to_string())?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("PDF 目录数据超过大小限制。".into());
        }
        fs::create_dir_all(root).map_err(|e| e.to_string())?;
        write_atomic_bytes(&path, &bytes)?;
        return Ok(OutlineRecord {
            outline: Some(outline),
            revision: Some(format!("{:x}", Sha256::digest(bytes))),
        });
    }
    // A damaged file reads as missing; its revision still lets a rebuild replace it.
    Ok(OutlineRecord {
        outline: bytes.and_then(|b| serde_json::from_slice(&b).ok()),
        revision,
    })
}

#[tauri::command]
pub(crate) async fn reader_outline(
    state: State<'_, AppState>,
    fingerprint: String,
    outline: Option<Value>,
    expected_revision: Option<String>,
) -> Result<OutlineRecord, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        metadata(
            storage.directory(),
            &fingerprint,
            outline,
            expected_revision.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_corrections_and_rejects_stale_writes_and_path_traversal() {
        let dir = tempfile::tempdir().unwrap();
        let fingerprint = "0123456789abcdef";
        let outline = serde_json::json!({"version":1,"source":"manual","customized":true,"entries":[{"id":"1","title":"Introduction","page":1,"level":0}]});
        let first = metadata(dir.path(), fingerprint, Some(outline.clone()), None).unwrap();
        assert_eq!(
            metadata(dir.path(), fingerprint, None, None)
                .unwrap()
                .outline,
            Some(outline.clone())
        );
        assert!(metadata(dir.path(), fingerprint, Some(outline.clone()), None).is_err());
        assert!(metadata(
            dir.path(),
            fingerprint,
            Some(outline),
            first.revision.as_deref()
        )
        .is_ok());
        assert!(metadata(dir.path(), "../../workspace", None, None).is_err());
        let path = dir.path().join("reader/outlines/0123456789abcdef.json");
        fs::write(&path, b"{damaged").unwrap();
        let damaged = metadata(dir.path(), fingerprint, None, None).unwrap();
        assert!(damaged.outline.is_none());
        assert!(metadata(
            dir.path(),
            fingerprint,
            Some(
                serde_json::json!({"version":1,"source":"detected","customized":false,"entries":[]})
            ),
            damaged.revision.as_deref()
        )
        .is_ok());
        assert!(dir
            .path()
            .join("reader/outlines/0123456789abcdef.json")
            .is_file());
    }
}
