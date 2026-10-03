use crate::AppState;
use scientify_core::{research::ResearchFiles, storage::Storage};
use serde_json::Value;
use std::{collections::BTreeSet, path::Path, sync::Mutex};
use tauri::State;

static WRITES: Mutex<()> = Mutex::new(());

pub(crate) fn context(
    storage: &Storage,
    files: &ResearchFiles,
    project: &str,
    id: &str,
) -> Result<(std::path::PathBuf, Value), String> {
    let data = storage.load()?.ok_or("项目不存在。")?;
    let experiment = data["experiments"]
        .as_array()
        .and_then(|items| {
            items
                .iter()
                .find(|e| e["id"] == id && e["project"] == project && e["archived"] != true)
        })
        .ok_or("实验不存在或已归档。")?;
    Ok((
        super::catalog::root_of(storage, files, &data, experiment)?,
        experiment.clone(),
    ))
}
fn read(storage: &Storage) -> Result<BTreeSet<String>, String> {
    let file = storage.directory().join("execution-trust.json");
    scientify_core::research::reject_links(&file)?;
    if !file.exists() {
        return Ok(BTreeSet::new());
    }
    if std::fs::metadata(&file).map_err(|e| e.to_string())?.len() > 1024 * 1024 {
        return Err("信任登记文件过大。".into());
    }
    serde_json::from_slice(&std::fs::read(file).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
pub(crate) fn trusted(storage: &Storage, root: &Path) -> Result<bool, String> {
    let managed = storage.directory().join("projects").canonicalize().ok();
    if managed.as_deref() == root.parent() {
        return Ok(true);
    }
    Ok(read(storage)?.contains(&root.display().to_string()))
}
pub(crate) fn require(storage: &Storage, root: &Path) -> Result<(), String> {
    if trusted(storage, root)? {
        Ok(())
    } else {
        Err("请先信任此实验目录，再启动终端、Python 检测或运行。".into())
    }
}
#[tauri::command]
pub async fn experiment_trust<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    experiment_id: String,
    allow: Option<bool>,
) -> Result<bool, String> {
    crate::library::trusted(&view)?;
    let storage = state.storage.clone();
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let (root, _) = context(&storage, &files, &project_id, &experiment_id)?;
        if let Some(allow) = allow {
            let _guard = WRITES.lock().map_err(|e| e.to_string())?;
            let mut entries = read(&storage)?;
            if allow {
                entries.insert(root.display().to_string());
            } else {
                entries.remove(&root.display().to_string());
            }
            let temporary = storage.directory().join("execution-trust.tmp");
            scientify_core::research::reject_links(&temporary)?;
            std::fs::write(
                &temporary,
                serde_json::to_vec(&entries).map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            std::fs::rename(temporary, storage.directory().join("execution-trust.json"))
                .map_err(|e| e.to_string())?;
        }
        trusted(&storage, &root)
    })
    .await
    .map_err(|e| e.to_string())?
}
