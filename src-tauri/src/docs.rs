//! Project documents: one JSON file per page in `workspace/docs/<project>/<page>.json`. The page
//! format belongs to the frontend (`src/workspaces/docs/model.ts`); this side stores pages with a
//! version check, keeps a local history, searches them, and passes the AI's document tools to
//! the window, which reads and writes pages in their own format.
use crate::AppState;
use scientify_core::{storage::Storage, workspace::valid_id};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, State};

const PAGE_LIMIT: usize = 8 * 1024 * 1024;
/// A snapshot of the previous version is kept when the last one is older than this.
const SNAPSHOT_EVERY_MS: u128 = 10 * 60 * 1000;
const SNAPSHOT_DAYS: u128 = 30;
const SNAPSHOTS_KEPT: usize = 200;

pub(crate) fn folder(data: &Path, project: &str) -> Result<PathBuf, String> {
    if !valid_id(project) {
        return Err("项目标识无效。".into());
    }
    Ok(data.join("docs").join(project))
}
fn file(data: &Path, project: &str, id: &str) -> Result<PathBuf, String> {
    if !valid_id(id) {
        return Err("页面标识无效。".into());
    }
    Ok(folder(data, project)?.join(format!("{id}.json")))
}
fn history(data: &Path, project: &str, id: &str) -> Result<PathBuf, String> {
    file(data, project, id)?;
    Ok(data.join("docs-history").join(project).join(id))
}
pub(crate) fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis())
}
/// Writes are serialized so a version check and the write that follows it are one step.
fn write_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(Mutex::default)
}

pub(crate) fn summary(page: &Value) -> Value {
    let mut out = serde_json::Map::new();
    for field in [
        "id",
        "title",
        "icon",
        "parent",
        "order",
        "createdAt",
        "createdBy",
        "updatedAt",
        "updatedBy",
        "deletedAt",
        "width",
    ] {
        if let Some(value) = page.get(field) {
            out.insert(field.into(), value.clone());
        }
    }
    Value::Object(out)
}

pub(crate) fn list(data: &Path, project: &str) -> Result<Vec<Value>, String> {
    let dir = folder(data, project)?;
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.to_string()),
    };
    let mut pages = vec![];
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Some(id) = name.strip_suffix(".json") else {
            continue;
        };
        if !valid_id(id) {
            continue;
        }
        // A page another device is still writing, or a damaged one, is skipped, not fatal.
        if let Ok(page) = std::fs::read(entry.path())
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .filter(|page| page["id"] == id)
            .ok_or(())
        {
            pages.push(summary(&page));
        }
    }
    Ok(pages)
}

pub(crate) fn read(data: &Path, project: &str, id: &str) -> Result<(Value, String), String> {
    let bytes = std::fs::read(file(data, project, id)?).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "页面不存在或已被彻底删除。".to_string()
        } else {
            e.to_string()
        }
    })?;
    let page = serde_json::from_slice(&bytes).map_err(|e| format!("页面文件损坏：{e}"))?;
    Ok((page, version(&bytes)))
}

fn snapshot(data: &Path, project: &str, id: &str, previous: &[u8]) -> Result<(), String> {
    let dir = history(data, project, id)?;
    let mut taken: Vec<u128> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| e.file_name().to_str()?.strip_suffix(".json")?.parse().ok())
                .collect()
        })
        .unwrap_or_default();
    taken.sort_unstable();
    let now = now_ms();
    if taken
        .last()
        .is_some_and(|last| now.saturating_sub(*last) < SNAPSHOT_EVERY_MS)
    {
        return Ok(());
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(dir.join(format!("{now}.json")), previous).map_err(|e| e.to_string())?;
    taken.push(now);
    let limit = now.saturating_sub(SNAPSHOT_DAYS * 24 * 3600 * 1000);
    let excess = taken.len().saturating_sub(SNAPSHOTS_KEPT);
    for (i, at) in taken.iter().enumerate() {
        if i < excess || *at < limit {
            let _ = std::fs::remove_file(dir.join(format!("{at}.json")));
        }
    }
    Ok(())
}

/// Saves a page if `expected` matches what is on disk (`None` creates a new page).
pub(crate) fn write(
    data: &Path,
    project: &str,
    page: &Value,
    expected: Option<&str>,
) -> Result<String, String> {
    let id = page["id"].as_str().ok_or("页面缺少标识。")?;
    let path = file(data, project, id)?;
    if page["schema"] != 1 || !page["blocks"].is_array() || !page["title"].is_string() {
        return Err("页面格式无效。".into());
    }
    let bytes = serde_json::to_vec(page).map_err(|e| e.to_string())?;
    if bytes.len() > PAGE_LIMIT {
        return Err("页面超过 8 MB，请把内容拆到子页面。".into());
    }
    let _guard = write_lock().lock().map_err(|e| e.to_string())?;
    let current = match std::fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    match (&current, expected) {
        (None, None) => {}
        (Some(bytes), Some(expected)) if version(bytes) == expected => {}
        (Some(_), None) => return Err("页面已存在。".into()),
        (None, Some(_)) => return Err("页面不存在或已被彻底删除。".into()),
        (Some(_), Some(_)) => return Err("页面已在别处修改，请重新打开后再保存。".into()),
    }
    if let Some(previous) = &current {
        if previous == &bytes {
            return Ok(version(&bytes));
        }
        snapshot(data, project, id, previous)?;
    }
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = path.with_extension("saving");
    std::fs::write(&temporary, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, &path).map_err(|e| e.to_string())?;
    Ok(version(&bytes))
}

/// Removes a page from the recycle bin for good.
pub(crate) fn purge(data: &Path, project: &str, id: &str) -> Result<(), String> {
    let _guard = write_lock().lock().map_err(|e| e.to_string())?;
    let (page, _) = read(data, project, id)?;
    if page["deletedAt"].as_str().is_none_or(str::is_empty) {
        return Err("只能彻底删除回收站里的页面。".into());
    }
    std::fs::remove_file(file(data, project, id)?).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_dir_all(history(data, project, id)?);
    Ok(())
}

fn collect_text(value: &Value, out: &mut String) {
    match value {
        Value::Object(map) => {
            for (key, value) in map {
                match (key.as_str(), value) {
                    ("text" | "latex" | "label" | "title", Value::String(text)) => {
                        out.push_str(text);
                        out.push(' ');
                    }
                    ("id" | "type" | "asset" | "path" | "order" | "parent", _) => {}
                    _ => collect_text(value, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_text(item, out)),
        _ => {}
    }
}

pub(crate) fn search(data: &Path, project: &str, query: &str) -> Result<Vec<Value>, String> {
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(vec![]);
    }
    let mut hits = vec![];
    for page in list(data, project)? {
        if page["deletedAt"].as_str().is_some_and(|at| !at.is_empty()) {
            continue;
        }
        let Some(id) = page["id"].as_str() else {
            continue;
        };
        let Ok((full, _)) = read(data, project, id) else {
            continue;
        };
        let title = full["title"].as_str().unwrap_or_default();
        let mut body = String::new();
        collect_text(&full["blocks"], &mut body);
        let lower = body.to_lowercase();
        let in_title = title.to_lowercase().contains(&query);
        let at = lower.find(&query);
        if !in_title && at.is_none() {
            continue;
        }
        // A short excerpt around the match, on character boundaries.
        let snippet = at.map_or_else(
            || body.chars().take(80).collect::<String>(),
            |at| {
                let start = lower[..at].chars().count().saturating_sub(24);
                body.chars().skip(start).take(80).collect()
            },
        );
        hits.push(json!({"id": id, "title": title, "icon": full["icon"], "snippet": snippet.trim(), "inTitle": in_title}));
    }
    hits.sort_by_key(|hit| hit["inTitle"] != true);
    Ok(hits)
}

pub(crate) fn snapshots(data: &Path, project: &str, id: &str) -> Result<Vec<Value>, String> {
    let dir = history(data, project, id)?;
    let mut out: Vec<(u128, u64)> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let at = e
                        .file_name()
                        .to_str()?
                        .strip_suffix(".json")?
                        .parse()
                        .ok()?;
                    Some((at, e.metadata().ok()?.len()))
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort_unstable_by_key(|(at, _)| std::cmp::Reverse(*at));
    Ok(out
        .into_iter()
        .map(|(at, size)| json!({"at": at.to_string(), "size": size}))
        .collect())
}

fn snapshot_read(data: &Path, project: &str, id: &str, at: &str) -> Result<Value, String> {
    if at.is_empty() || !at.bytes().all(|b| b.is_ascii_digit()) {
        return Err("历史版本无效。".into());
    }
    let bytes = std::fs::read(history(data, project, id)?.join(format!("{at}.json")))
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

// ---------- Merging ----------
/// The text put above the other side's version of a block both sides changed.
const CONFLICT_FROM: &str = "这台电脑上的版本";
const PAGE_FIELDS: [&str; 6] = ["title", "icon", "parent", "order", "deletedAt", "width"];

fn fresh_ids(block: &mut Value) {
    if let Some(map) = block.as_object_mut() {
        map.insert(
            "id".into(),
            json!(uuid::Uuid::new_v4().simple().to_string()[..10]),
        );
        if let Some(children) = map.get_mut("children").and_then(Value::as_array_mut) {
            children.iter_mut().for_each(fresh_ids);
        }
    }
}

/// Merges a page changed both here (`local`) and elsewhere (`remote`) since `base`, block by
/// block: whatever only one side changed is kept; a block both sides changed keeps the remote
/// version, with this side's version in a conflict block right after it. Returns the page and
/// how many such conflicts there were.
pub(crate) fn merge(base: Option<&Value>, local: &Value, remote: &Value) -> (Value, usize) {
    let mut out = remote.clone();
    for field in PAGE_FIELDS {
        let before = base.map(|page| &page[field]);
        if before != Some(&local[field]) && before == Some(&remote[field]) {
            out[field] = local[field].clone();
        }
    }
    if local["updatedAt"].as_str() > remote["updatedAt"].as_str() {
        out["updatedAt"] = local["updatedAt"].clone();
        out["updatedBy"] = local["updatedBy"].clone();
    }
    let blocks = |page: &Value| page["blocks"].as_array().cloned().unwrap_or_default();
    let ours = blocks(local);
    let theirs = blocks(remote);
    let before = base.map(blocks).unwrap_or_default();
    let id = |block: &Value| block["id"].as_str().unwrap_or_default().to_owned();
    let index = |list: &[Value]| -> HashMap<String, Value> {
        list.iter()
            .map(|block| (id(block), block.clone()))
            .collect()
    };
    let (ours_by_id, before_by_id) = (index(&ours), index(&before));
    let theirs_ids: std::collections::HashSet<String> = theirs.iter().map(id).collect();
    let mut result: Vec<Value> = vec![];
    let mut conflicts = 0;
    for remote_block in &theirs {
        let key = id(remote_block);
        match (ours_by_id.get(&key), before_by_id.get(&key)) {
            (Some(mine), old) => {
                if mine == remote_block || old == Some(mine) {
                    result.push(remote_block.clone());
                } else if old == Some(remote_block) {
                    result.push(mine.clone());
                } else {
                    result.push(remote_block.clone());
                    let mut copy = mine.clone();
                    fresh_ids(&mut copy);
                    let mut conflict = json!({"type": "conflict",
                        "props": {"from": CONFLICT_FROM, "at": now_ms().to_string()},
                        "children": [copy]});
                    fresh_ids(&mut conflict);
                    result.push(conflict);
                    conflicts += 1;
                }
            }
            // Deleted here: an edit made elsewhere since wins over the deletion.
            (None, Some(old)) => {
                if old != remote_block {
                    result.push(remote_block.clone());
                }
            }
            (None, None) => result.push(remote_block.clone()),
        }
    }
    for (i, mine) in ours.iter().enumerate() {
        let key = id(mine);
        if theirs_ids.contains(&key) {
            continue;
        }
        // New here, or changed here while deleted elsewhere: keep it after its neighbour.
        if before_by_id.get(&key).is_some_and(|old| old == mine) {
            continue;
        }
        let at = ours[..i]
            .iter()
            .rev()
            .find_map(|previous| result.iter().position(|block| id(block) == id(previous)))
            .map_or(0, |position| position + 1);
        result.insert(at, mine.clone());
    }
    out["blocks"] = Value::Array(result);
    (out, conflicts)
}

// ---------- Commands ----------
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| e.to_string())?
}
fn data_of(state: &State<'_, AppState>) -> PathBuf {
    state.storage.directory().to_path_buf()
}
fn require_write(storage: &Storage, project: &str) -> Result<(), String> {
    crate::collaboration::permissions::require_write(storage, project, "doc")
}

#[tauri::command]
pub async fn docs_list(
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<Value>, String> {
    crate::library::trusted(&view)?;
    let data = data_of(&state);
    blocking(move || list(&data, &project_id)).await
}

#[tauri::command]
pub async fn docs_read(
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    id: String,
) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    let data = data_of(&state);
    blocking(move || {
        let (page, version) = read(&data, &project_id, &id)?;
        Ok(json!({"page": page, "version": version}))
    })
    .await
}

#[tauri::command]
pub async fn docs_write(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    page: Value,
    expected_version: Option<String>,
) -> Result<String, String> {
    crate::library::trusted(&view)?;
    let data = data_of(&state);
    let storage = state.storage.clone();
    blocking(move || {
        require_write(&storage, &project_id)?;
        let version = write(&data, &project_id, &page, expected_version.as_deref())?;
        let _ = app.emit(
            "docs-changed",
            json!({"projectId": project_id, "id": page["id"], "version": version}),
        );
        Ok(version)
    })
    .await
}

#[tauri::command]
pub async fn docs_purge(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    id: String,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    let data = data_of(&state);
    let storage = state.storage.clone();
    blocking(move || {
        require_write(&storage, &project_id)?;
        purge(&data, &project_id, &id)?;
        let _ = app.emit("docs-changed", json!({"projectId": project_id, "id": id}));
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn docs_search(
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    query: String,
) -> Result<Vec<Value>, String> {
    crate::library::trusted(&view)?;
    let data = data_of(&state);
    blocking(move || search(&data, &project_id, &query)).await
}

#[tauri::command]
pub async fn docs_history(
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    id: String,
    at: Option<String>,
) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    let data = data_of(&state);
    blocking(move || match at {
        Some(at) => snapshot_read(&data, &project_id, &id, &at),
        None => Ok(Value::Array(snapshots(&data, &project_id, &id)?)),
    })
    .await
}

/// Saves a page as Markdown where the person chooses; its images go to `images/` beside it.
#[tauri::command]
pub async fn docs_export(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    name: String,
    markdown: String,
    images: Vec<String>,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::library::trusted(&view)?;
    let assets = state
        .storage
        .directory()
        .join("note-assets")
        .join(&project_id);
    if !valid_id(&project_id) {
        return Err("项目标识无效。".into());
    }
    blocking(move || {
        let stem: String = name
            .chars()
            .map(|c| {
                if r#"\/:*?"<>|"#.contains(c) || c.is_control() {
                    ' '
                } else {
                    c
                }
            })
            .collect::<String>()
            .trim()
            .chars()
            .take(80)
            .collect();
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md"])
            .set_file_name(format!(
                "{}.md",
                if stem.is_empty() { "untitled" } else { &stem }
            ))
            .blocking_save_file()
        else {
            return Ok(false);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        std::fs::write(&path, markdown).map_err(|e| e.to_string())?;
        let dir = path.parent().ok_or("保存位置无效。")?;
        for image in images {
            let Some(name) = image.strip_prefix("images/") else {
                continue;
            };
            if name.is_empty() || name.contains(['/', '\\', ':']) || name.starts_with('.') {
                continue;
            }
            let from = assets.join("images").join(name);
            if from.is_file() {
                std::fs::create_dir_all(dir.join("images")).map_err(|e| e.to_string())?;
                std::fs::copy(&from, dir.join("images").join(name)).map_err(|e| e.to_string())?;
            }
        }
        Ok(true)
    })
    .await
}

/// Markdown files the person chooses to import, as text.
#[tauri::command]
pub async fn docs_import(
    app: tauri::AppHandle,
    view: tauri::Webview,
) -> Result<Vec<Value>, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::library::trusted(&view)?;
    blocking(move || {
        let Some(files) = app
            .dialog()
            .file()
            .add_filter("Markdown", &["md", "markdown", "txt"])
            .blocking_pick_files()
        else {
            return Ok(vec![]);
        };
        let mut out = vec![];
        for file in files.into_iter().take(50) {
            let path = file.into_path().map_err(|e| e.to_string())?;
            if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > 5 * 1024 * 1024 {
                return Err("Markdown 文件超过 5 MB。".into());
            }
            let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
            let name = path
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            out.push(json!({"name": name, "content": String::from_utf8_lossy(&bytes)}));
        }
        Ok(out)
    })
    .await
}

#[tauri::command]
pub async fn docs_merge(
    view: tauri::Webview,
    base: Option<Value>,
    local: Value,
    remote: Value,
) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    let (page, conflicts) = merge(base.as_ref(), &local, &remote);
    Ok(json!({"page": page, "conflicts": conflicts}))
}

// ---------- The AI's document tools ----------
type Waiting = Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>;
fn waiting() -> &'static Waiting {
    static WAITING: OnceLock<Waiting> = OnceLock::new();
    WAITING.get_or_init(Waiting::default)
}

/// Asks the window to run a document tool and waits for its answer.
pub(crate) fn ask_window<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project: &str,
    tool: &str,
    arguments: &Value,
) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = mpsc::channel();
    waiting()
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), sender);
    app.emit(
        "docs-agent-request",
        json!({"id": id, "projectId": project, "tool": tool, "arguments": arguments}),
    )
    .map_err(|e| e.to_string())?;
    let answer = receiver.recv_timeout(Duration::from_secs(60));
    if let Ok(mut waiting) = waiting().lock() {
        waiting.remove(&id);
    }
    answer.unwrap_or_else(|_| Err("Scientify 窗口没有响应文档操作，请确认主窗口已打开。".into()))
}

#[tauri::command]
pub async fn docs_agent_respond(
    view: tauri::Webview,
    id: String,
    ok: bool,
    value: Value,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    let sender = waiting().lock().map_err(|e| e.to_string())?.remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(if ok {
            Ok(value)
        } else {
            Err(value.as_str().unwrap_or("文档操作失败。").to_string())
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page(id: &str, title: &str, text: &str) -> Value {
        json!({"schema": 1, "id": id, "title": title, "parent": null, "order": "V",
            "createdAt": "", "updatedAt": "", "deletedAt": null,
            "blocks": [{"id": "b", "type": "paragraph", "content": [{"text": text}]}]})
    }

    #[test]
    fn pages_are_written_only_over_the_version_that_was_read() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let first = write(data, "p", &page("a", "组会", "第一版"), None).unwrap();
        assert!(write(data, "p", &page("a", "组会", "x"), None).is_err());
        let second = write(data, "p", &page("a", "组会", "第二版"), Some(&first)).unwrap();
        assert!(write(
            data,
            "p",
            &page("a", "组会", "旧版本上的修改"),
            Some(&first)
        )
        .unwrap_err()
        .contains("别处修改"));
        let (read_back, version) = read(data, "p", "a").unwrap();
        assert_eq!(version, second);
        assert_eq!(read_back["blocks"][0]["content"][0]["text"], "第二版");
        // The version before the second write is kept in the local history.
        let kept = snapshots(data, "p", "a").unwrap();
        assert_eq!(kept.len(), 1);
        let old = snapshot_read(data, "p", "a", kept[0]["at"].as_str().unwrap()).unwrap();
        assert_eq!(old["blocks"][0]["content"][0]["text"], "第一版");
        // Writing the same bytes again is not a change.
        assert_eq!(
            write(data, "p", &page("a", "组会", "第二版"), Some(&second)).unwrap(),
            second
        );
    }

    #[test]
    fn listing_skips_damaged_files_and_search_finds_titles_and_text() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        write(data, "p", &page("a", "组会纪要", "阈值从 0.5 往上调"), None).unwrap();
        write(data, "p", &page("b", "实验", "gate 0.7"), None).unwrap();
        std::fs::write(folder(data, "p").unwrap().join("broken.json"), "{").unwrap();
        std::fs::write(folder(data, "p").unwrap().join("note.txt"), "x").unwrap();
        let listed = list(data, "p").unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().all(|p| p.get("blocks").is_none()));
        let hits = search(data, "p", "阈值").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0]["snippet"].as_str().unwrap().contains("阈值"));
        assert_eq!(search(data, "p", "实验").unwrap()[0]["id"], "b");
    }

    fn blocks(page: &Value) -> Vec<(String, String)> {
        page["blocks"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| {
                let text = if b["type"] == "conflict" {
                    format!(
                        "冲突:{}",
                        b["children"][0]["content"][0]["text"].as_str().unwrap()
                    )
                } else {
                    b["content"][0]["text"]
                        .as_str()
                        .unwrap_or_default()
                        .to_owned()
                };
                (b["id"].as_str().unwrap().to_owned(), text)
            })
            .collect()
    }
    fn doc(title: &str, list: &[(&str, &str)]) -> Value {
        json!({"schema": 1, "id": "p", "title": title, "parent": null, "order": "V",
            "updatedAt": "", "blocks": list.iter().map(|(id, text)|
                json!({"id": id, "type": "paragraph", "content": [{"text": text}]})).collect::<Vec<_>>()})
    }

    #[test]
    fn edits_to_different_blocks_merge_and_the_same_block_keeps_both_versions() {
        let base = doc(
            "组会",
            &[("a", "一"), ("b", "二"), ("c", "三"), ("d", "四")],
        );
        // Here: edit a, delete c, add x after b, rename the page.
        let local = doc(
            "组会（改）",
            &[("a", "一·本机"), ("b", "二"), ("x", "新"), ("d", "四·本机")],
        );
        // Elsewhere: edit b, add y at the end, and edit d too.
        let remote = doc(
            "组会",
            &[
                ("a", "一"),
                ("b", "二·远端"),
                ("c", "三"),
                ("d", "四·远端"),
                ("y", "尾"),
            ],
        );
        let (merged, conflicts) = merge(Some(&base), &local, &remote);
        assert_eq!(conflicts, 1);
        assert_eq!(merged["title"], "组会（改）");
        let got = blocks(&merged);
        let texts: Vec<&str> = got.iter().map(|(_, t)| t.as_str()).collect();
        assert_eq!(
            texts,
            ["一·本机", "二·远端", "新", "四·远端", "冲突:四·本机", "尾"]
        );
        // The conflict copy has new ids so the page never holds one id twice.
        let ids: std::collections::HashSet<_> = got.iter().map(|(id, _)| id.clone()).collect();
        assert_eq!(ids.len(), got.len());
    }

    #[test]
    fn an_edit_wins_over_a_deletion_on_the_other_side() {
        let base = doc("t", &[("a", "一"), ("b", "二")]);
        let local = doc("t", &[("a", "一")]);
        let remote = doc("t", &[("a", "一"), ("b", "二·改")]);
        let (merged, _) = merge(Some(&base), &local, &remote);
        assert_eq!(blocks(&merged).len(), 2);
        let local = doc("t", &[("a", "一"), ("b", "二·改")]);
        let remote = doc("t", &[("a", "一")]);
        let (merged, _) = merge(Some(&base), &local, &remote);
        assert_eq!(blocks(&merged).len(), 2);
        let local = doc("t", &[("a", "一")]);
        let (merged, _) = merge(Some(&base), &local, &doc("t", &[("a", "一"), ("b", "二")]));
        assert_eq!(blocks(&merged).len(), 1);
    }

    #[test]
    fn only_pages_in_the_recycle_bin_are_purged_and_ids_stay_inside_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path();
        let version = write(data, "p", &page("a", "t", "x"), None).unwrap();
        assert!(purge(data, "p", "a").is_err());
        let mut gone = page("a", "t", "x");
        gone["deletedAt"] = json!("2026-11-16T00:00:00Z");
        write(data, "p", &gone, Some(&version)).unwrap();
        purge(data, "p", "a").unwrap();
        assert!(read(data, "p", "a").is_err());
        assert!(write(data, "p", &page("../x", "t", "x"), None).is_err());
        assert!(read(data, "../p", "a").is_err());
    }
}
