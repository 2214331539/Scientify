//! Files attached to documents, of any kind: kept per project under
//! `note-assets/<project>/attachments/<id>/<name>`, which syncs with the
//! project's other note assets, and previewed in the center like project files.

use super::AppState;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// Larger files belong in the project's folders, not in a document.
const LIMIT: u64 = 200 * 1024 * 1024;
/// Pasted or dropped files travel through the page as base64.
const INLINE_LIMIT: usize = 50 * 1024 * 1024;

fn valid_project(project: &str) -> Result<(), String> {
    if project.is_empty()
        || !project
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_-".contains(&c))
    {
        return Err("项目标识无效。".into());
    }
    Ok(())
}

/// The project's attachments folder, created on first use.
pub(crate) fn root(
    storage: &scientify_core::storage::Storage,
    project: &str,
) -> Result<PathBuf, String> {
    valid_project(project)?;
    let root = storage
        .directory()
        .join("note-assets")
        .join(project)
        .join("attachments");
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    root.canonicalize().map_err(|e| e.to_string())
}

/// A name safe on every system, keeping the extension.
fn clean_name(name: &str) -> String {
    let name = Path::new(name)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let cleaned: String = name
        .chars()
        .map(|c| {
            if "<>:\"/\\|?*".contains(c) || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "file".into()
    } else {
        cleaned.chars().take(120).collect()
    }
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attached {
    /// Its path under the project's note assets, stored in the document.
    asset: String,
    name: String,
    size: u64,
}

fn place(root: &Path, name: &str) -> Result<(PathBuf, String), String> {
    let id = uuid::Uuid::new_v4().simple().to_string();
    let name = clean_name(name);
    let folder = root.join(&id);
    std::fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    Ok((folder.join(&name), format!("attachments/{id}/{name}")))
}

fn copy_in(root: &Path, source: &Path) -> Result<Attached, String> {
    let size = std::fs::metadata(source).map_err(|e| e.to_string())?.len();
    if size > LIMIT {
        return Err("文件超过 200 MB，请放进项目文件夹再引用。".into());
    }
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let (target, asset) = place(root, &name)?;
    std::fs::copy(source, &target).map_err(|e| e.to_string())?;
    Ok(Attached {
        asset,
        name: clean_name(&name),
        size,
    })
}

fn write_in(root: &Path, name: &str, bytes: &[u8]) -> Result<Attached, String> {
    let (target, asset) = place(root, name)?;
    std::fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(Attached {
        asset,
        name: clean_name(name),
        size: bytes.len() as u64,
    })
}

/// The folder and the path inside it of a stored attachment, for previews.
fn locate(root: &Path, asset: &str) -> Result<(String, String), String> {
    let inner = asset.strip_prefix("attachments/").ok_or("附件路径无效。")?;
    let path = Path::new(inner);
    if !path
        .components()
        .all(|part| matches!(part, std::path::Component::Normal(_)))
    {
        return Err("附件路径无效。".into());
    }
    if !root.join(path).is_file() {
        return Err("附件不存在，可能还没有同步到这台设备。".into());
    }
    Ok((root.display().to_string(), inner.replace('\\', "/")))
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Operation {
    /// Choose files with the system dialog and attach them.
    Pick,
    /// A pasted or dropped file.
    Save { name: String, data: String },
    /// Where an attachment is, as `{ root, path }`.
    Locate { asset: String },
}

#[tauri::command]
pub async fn doc_attachment(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    operation: Operation,
) -> Result<serde_json::Value, String> {
    crate::library::trusted(&view)?;
    if !matches!(operation, Operation::Locate { .. }) {
        crate::collaboration::permissions::require_write(&state.storage, &project_id, "asset")?;
    }
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = root(&storage, &project_id)?;
        match operation {
            Operation::Pick => {
                let Some(files) = app.dialog().file().blocking_pick_files() else {
                    return Ok(serde_json::json!([]));
                };
                let mut attached = Vec::new();
                for file in files {
                    let path = file.into_path().map_err(|e| e.to_string())?;
                    attached.push(copy_in(&root, &path)?);
                }
                serde_json::to_value(attached).map_err(|e| e.to_string())
            }
            Operation::Save { name, data } => {
                if data.len() > INLINE_LIMIT * 4 / 3 + 4 {
                    return Err("拖入的文件超过 50 MB，请用“/文件”选择。".into());
                }
                let bytes = STANDARD
                    .decode(data.as_bytes())
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(write_in(&root, &name, &bytes)?).map_err(|e| e.to_string())
            }
            Operation::Locate { asset } => {
                let (root, path) = locate(&root, &asset)?;
                Ok(serde_json::json!({ "root": root, "path": path }))
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attachments_keep_their_name_in_a_folder_of_their_own() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let first = write_in(root, "结果 v1.xlsx", b"xlsx").unwrap();
        let second = write_in(root, "结果 v1.xlsx", b"again").unwrap();
        assert_ne!(first.asset, second.asset);
        assert!(first.asset.starts_with("attachments/") && first.asset.ends_with("/结果 v1.xlsx"));
        let (_, path) = locate(root, &first.asset).unwrap();
        assert_eq!(std::fs::read(root.join(&path)).unwrap(), b"xlsx");
        assert_eq!(clean_name("../../etc/pass:wd"), "pass_wd");
        assert_eq!(clean_name(""), "file");
        assert!(locate(root, "attachments/../secret").is_err());
        assert!(locate(root, "images/a.png").is_err());
        let source = temp.path().join("paper.pdf");
        std::fs::write(&source, b"%PDF").unwrap();
        let copied = copy_in(root, &source).unwrap();
        assert_eq!((copied.name.as_str(), copied.size), ("paper.pdf", 4));
    }
}
