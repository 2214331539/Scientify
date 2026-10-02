use crate::{
    agent::{execution, process::EventSink},
    research, AppState,
};
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
pub(crate) mod runner;

#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Configuration {
    pub id: String,
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub cwd: String,
}
#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Run {
    pub id: String,
    pub project: String,
    pub name: String,
    pub status: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub configuration: Configuration,
    pub directory: String,
    pub executable: String,
    pub platform: String,
    pub git_commit: Option<String>,
    pub git_changes: Vec<String>,
    pub error: Option<String>,
    #[serde(default)]
    pub source: Option<RunSource>,
    #[serde(default = "legacy_permission")]
    pub permission: String,
}
fn legacy_permission() -> String {
    "legacy-current-user".into()
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunSource {
    pub conversation_id: String,
    pub thread_id: String,
    pub turn_id: String,
    pub call_id: String,
    pub workspace_root: String,
}
struct Entry {
    run: Mutex<Run>,
    cancel: AtomicBool,
}
pub struct ExperimentState {
    directory: PathBuf,
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn relative(value: &str) -> Result<PathBuf, String> {
    let value = value.replace('\\', "/");
    let path = PathBuf::from(&value);
    if value.len() > 2048
        || value.split('/').any(|part| {
            let base = part
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase();
            part.ends_with([' ', '.'])
                || part
                    .chars()
                    .any(|c| c.is_control() || "<>\"|?*".contains(c))
                || matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
                || ((base.starts_with("COM") || base.starts_with("LPT"))
                    && base.len() == 4
                    && matches!(base.as_bytes()[3], b'1'..=b'9'))
        })
    {
        return Err("相对路径包含不支持的名称。".into());
    }
    if value.is_empty()
        || value.contains([':', '\0'])
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
        || value
            .split('/')
            .any(|s| s == ".." || s == ".git" || s.is_empty())
    {
        return Err("必须使用工作区内的相对路径。".into());
    }
    Ok(path)
}
fn confined(root: &Path, value: &str) -> Result<PathBuf, String> {
    let p = root.join(relative(value)?);
    scientify_core::research::reject_links(&p)?;
    Ok(p)
}
fn process_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(value) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{value}"));
        }
        if let Some(value) = text.strip_prefix(r"\\?\") {
            return PathBuf::from(value);
        }
    }
    path.to_path_buf()
}
fn resolve_program(root: &Path, value: &str) -> Result<PathBuf, String> {
    if value.trim().is_empty() || value.contains('\0') {
        return Err("请选择可执行程序。".into());
    }
    let p = PathBuf::from(value);
    let p = if p.is_absolute() {
        p
    } else if value.contains(['/', '\\']) {
        confined(root, value)?
    } else {
        let name = if cfg!(windows) && !value.ends_with(".exe") {
            format!("{value}.exe")
        } else {
            value.into()
        };
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .filter(|p| p.is_absolute())
            .map(|p| p.join(&name))
            .find(|p| p.is_file())
            .ok_or("找不到可执行程序，请填写绝对路径或检查 PATH。")?
    };
    scientify_core::research::reject_links(&p)?;
    if !p.is_file() {
        return Err("可执行程序不存在。".into());
    }
    Ok(p)
}
fn persist(directory: &Path, run: &Run) -> Result<(), String> {
    fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let temp = directory.join("record.tmp");
    fs::write(&temp, serde_json::to_vec(run).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(temp, directory.join("record.json")).map_err(|e| e.to_string())
}
impl ExperimentState {
    pub fn new(directory: PathBuf) -> Self {
        let mut entries = BTreeMap::new();
        if let Ok(items) = fs::read_dir(&directory) {
            for item in items.flatten() {
                if scientify_core::research::reject_links(&item.path()).is_err() {
                    continue;
                }
                let record = item.path().join("record.json");
                if scientify_core::research::reject_links(&record).is_err()
                    || !fs::metadata(&record).is_ok_and(|m| m.is_file() && m.len() <= 256 * 1024)
                {
                    continue;
                }
                if let Ok(bytes) = fs::read(record) {
                    if let Ok(mut run) = serde_json::from_slice::<Run>(&bytes) {
                        if uuid::Uuid::parse_str(&run.id).is_err()
                            || item.file_name().to_str() != Some(&run.id)
                        {
                            continue;
                        }
                        if run.status == "running" {
                            run.status = "interrupted".into();
                            run.ended_at = Some(now());
                            run.error = Some("应用上次退出时运行未完成；未自动重新执行。".into());
                            let _ = persist(&item.path(), &run);
                        }
                        entries.insert(
                            run.id.clone(),
                            Arc::new(Entry {
                                run: Mutex::new(run),
                                cancel: AtomicBool::new(false),
                            }),
                        );
                    }
                }
            }
        }
        Self {
            directory,
            entries: Mutex::new(entries),
        }
    }
    pub fn protect(
        &self,
        old: Option<&serde_json::Value>,
        new: Option<&serde_json::Value>,
    ) -> Result<(), String> {
        for entry in self.entries.lock().map_err(|e| e.to_string())?.values() {
            let run = entry.run.lock().map_err(|e| e.to_string())?;
            if run.status != "running" {
                continue;
            }
            let find = |data: Option<&serde_json::Value>| {
                data.and_then(|d| d["projects"].as_array())
                    .and_then(|ps| ps.iter().find(|p| p["id"].as_str() == Some(&run.project)))
                    .cloned()
            };
            let before = find(old);
            let after = find(new);
            if before.is_none()
                || after.is_none()
                || before.as_ref().map(|p| &p["path"]) != after.as_ref().map(|p| &p["path"])
            {
                return Err("实验仍在运行，请停止后再删除项目、更换目录或恢复数据。".into());
            }
        }
        Ok(())
    }
    fn entry(&self, id: &str) -> Result<Arc<Entry>, String> {
        self.entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| "运行记录不存在。".into())
    }
    pub(crate) fn start(
        &self,
        project: String,
        root: PathBuf,
        config: Configuration,
        source: Option<RunSource>,
        sink: Option<EventSink>,
    ) -> Result<Run, String> {
        if config.name.trim().is_empty()
            || config.name.len() > 200
            || config.args.len() > 128
            || config
                .args
                .iter()
                .any(|a| a.len() > 8192 || a.contains('\0'))
        {
            return Err("运行配置无效。".into());
        }
        let cwd = if config.cwd.trim().is_empty() || config.cwd == "." {
            root.clone()
        } else {
            confined(&root, &config.cwd)?
        };
        if !cwd.is_dir() {
            return Err("工作目录不存在。".into());
        }
        let executable = resolve_program(&root, &config.executable)?;
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        if let Some(source) = &source {
            for entry in entries.values() {
                let run = entry.run.lock().map_err(|e| e.to_string())?;
                if run.project == project && run.source.as_ref() == Some(source) {
                    if run.configuration != config {
                        return Err("同一工具请求不能启动不同配置。".into());
                    }
                    return Ok(run.clone());
                }
            }
        }
        if entries
            .values()
            .filter(|e| e.run.lock().is_ok_and(|r| r.status == "running"))
            .count()
            >= 8
        {
            return Err("最多同时运行 8 个实验，请等待或停止已有任务。".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let directory = self.directory.join(&id);
        scientify_core::research::reject_links(&directory)?;
        let git_changes = research::git_status(&root)
            .unwrap_or_default()
            .into_iter()
            .map(|c| format!("{} {}", c.status, c.path))
            .collect();
        let git_commit = research::git_head(&root).ok();
        let run = Run {
            id: id.clone(),
            project,
            name: config.name.clone(),
            status: "running".into(),
            started_at: now(),
            ended_at: None,
            exit_code: None,
            configuration: config.clone(),
            directory: process_path(&cwd).display().to_string(),
            executable: process_path(&executable).display().to_string(),
            platform: format!("{} / {}", std::env::consts::OS, std::env::consts::ARCH),
            git_commit,
            git_changes,
            error: None,
            source,
            permission: "workspace-write".into(),
        };
        fs::create_dir_all(directory.join("artifacts")).map_err(|e| e.to_string())?;
        let private = directory.join("artifacts/.scientify");
        fs::create_dir_all(&private).map_err(|e| e.to_string())?;
        let log_path = if cfg!(windows) {
            private.join("output.log")
        } else {
            directory.join("output.log")
        };
        let mut log = fs::File::create(&log_path).map_err(|e| e.to_string())?;
        let entry = Arc::new(Entry {
            run: Mutex::new(run.clone()),
            cancel: AtomicBool::new(false),
        });
        let home = self
            .directory
            .parent()
            .ok_or("数据目录无效。")?
            .join("agent/code");
        let mut command = vec![process_path(&executable).display().to_string()];
        command.extend(config.args);
        let artifacts = process_path(&directory.join("artifacts"));
        #[cfg(not(windows))]
        let params = serde_json::json!({"command":command,"processId":id,"cwd":process_path(&cwd),
            "streamStdoutStderr":true,"disableTimeout":true,"disableOutputCap":true,
            "env":{"PYTHONUNBUFFERED":"1","SCIENTIFY_RUN_DIR":artifacts},
            "sandboxPolicy":execution::policy(&process_path(&root),Some(&artifacts))});
        #[cfg(windows)]
        let params = {
            let request = private.join("request.json");
            fs::write(
                &request,
                serde_json::to_vec(&runner::Request {
                    command,
                    cwd: process_path(&cwd),
                })
                .map_err(|e| e.to_string())?,
            )
            .map_err(|e| e.to_string())?;
            let binary = std::env::current_exe().map_err(|e| e.to_string())?;
            #[cfg(not(test))]
            let argv = vec![
                binary.display().to_string(),
                "--scientify-runner".into(),
                request.display().to_string(),
            ];
            #[cfg(test)]
            let argv = vec![
                binary.display().to_string(),
                "--exact".into(),
                "experiments::runner::tests::managed_runner_child".into(),
                "--ignored".into(),
                "--nocapture".into(),
            ];
            fs::write(private.join("heartbeat"), "alive").map_err(|e| e.to_string())?;
            serde_json::json!({"command":argv,"processId":id,"cwd":process_path(&cwd),"disableTimeout":true,
                "env":{"PYTHONUNBUFFERED":"1","SCIENTIFY_RUN_DIR":artifacts,"SCIENTIFY_FIXTURE_RUNNER":request},
                "sandboxPolicy":execution::policy(&process_path(&root),Some(&artifacts))})
        };
        persist(&directory, &run)?;
        entries.insert(id.clone(), entry.clone());
        thread::spawn(move || {
            let mut limit_hit = false;
            let result = (|| {
                if entry.cancel.load(Ordering::SeqCst) {
                    return Err("启动前已取消。".into());
                }
                let mut session = execution::session(&home, &root)?;
                if entry.cancel.load(Ordering::SeqCst) {
                    return Err("启动前已取消。".into());
                }
                let mut bytes = 0usize;
                let mut last_event = std::time::Instant::now();
                session.run_command(params, &entry.cancel, |event| {
                    #[cfg(windows)]
                    {
                        scientify_core::research::reject_links(&private)?;
                        if fs::metadata(&log_path).is_ok_and(|meta| meta.len() > 64 * 1024 * 1024) {
                            limit_hit = true;
                            entry.cancel.store(true, Ordering::SeqCst);
                        }
                        fs::write(private.join("heartbeat"), "alive").map_err(|e| e.to_string())?;
                        if entry.cancel.load(Ordering::SeqCst) {
                            fs::write(private.join("stop"), "stop").map_err(|e| e.to_string())?;
                        }
                        let length =
                            fs::metadata(&log_path).map_err(|e| e.to_string())?.len() as usize;
                        if bytes != length {
                            bytes = length;
                            if let Some(sink) = &sink {
                                sink(serde_json::json!({"runId":id}));
                            }
                        }
                    }
                    if event.is_null() {
                        return Ok(());
                    }
                    let chunk = base64::engine::general_purpose::STANDARD
                        .decode(event["deltaBase64"].as_str().ok_or("日志缺少输出字节。")?)
                        .map_err(|e| e.to_string())?;
                    if bytes + chunk.len() > 64 * 1024 * 1024 {
                        limit_hit = true;
                        entry.cancel.store(true, Ordering::SeqCst);
                    } else {
                        log.write_all(&chunk)
                            .and_then(|()| log.flush())
                            .map_err(|e| e.to_string())?;
                        bytes += chunk.len();
                    }
                    if last_event.elapsed() >= Duration::from_millis(80) {
                        if let Some(sink) = &sink {
                            sink(serde_json::json!({"runId":id}));
                        }
                        last_event = std::time::Instant::now();
                    }
                    Ok(())
                })
            })();
            #[cfg(windows)]
            if let Ok(value) = &result {
                if let Ok(mut file) = fs::OpenOptions::new().append(true).open(&log_path) {
                    for field in ["stdout", "stderr"] {
                        if let Some(text) = value[field].as_str() {
                            let _ = file.write_all(text.as_bytes());
                        }
                    }
                }
            }
            if let Ok(mut r) = entry.run.lock() {
                r.exit_code = result
                    .as_ref()
                    .ok()
                    .and_then(|value| value["exitCode"].as_i64())
                    .map(|code| code as i32);
                r.status = if limit_hit {
                    "failed"
                } else if entry.cancel.load(Ordering::SeqCst) {
                    "cancelled"
                } else if r.exit_code == Some(0) {
                    "completed"
                } else {
                    "failed"
                }
                .into();
                r.error = if limit_hit {
                    Some("日志超过 64 MiB，已停止运行以保护磁盘空间。".into())
                } else {
                    result.err()
                };
                r.ended_at = Some(now());
                if let Err(error) = persist(&directory, &r) {
                    r.error = Some(format!("记录保存失败：{error}"));
                }
            }
            if let Some(sink) = &sink {
                sink(serde_json::json!({"runId":id}));
            }
        });
        Ok(run)
    }
    pub(crate) fn run(&self, id: &str) -> Result<Run, String> {
        self.entry(id)?
            .run
            .lock()
            .map(|run| run.clone())
            .map_err(|e| e.to_string())
    }
    pub(crate) fn stop(&self, id: &str) -> Result<(), String> {
        self.entry(id)?.cancel.store(true, Ordering::SeqCst);
        Ok(())
    }
    pub(crate) fn entries_for_tools(&self, project: &str) -> Result<Vec<Run>, String> {
        self.entries
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .map(|entry| {
                entry
                    .run
                    .lock()
                    .map(|run| run.clone())
                    .map_err(|e| e.to_string())
            })
            .collect::<Result<Vec<_>, _>>()
            .map(|runs| {
                runs.into_iter()
                    .filter(|run| run.project == project)
                    .collect()
            })
    }
}
impl Drop for ExperimentState {
    fn drop(&mut self) {
        if let Ok(entries) = self.entries.lock() {
            for entry in entries.values() {
                entry.cancel.store(true, Ordering::SeqCst);
            }
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while entries
                .values()
                .any(|e| e.run.lock().is_ok_and(|r| r.status == "running"))
                && std::time::Instant::now() < deadline
            {
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}
#[tauri::command]
pub async fn experiment_start<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    project_id: String,
    configuration: Configuration,
) -> Result<Run, String> {
    let storage = state.storage.clone();
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let root = research::project_root(&storage, &files, &project_id)?;
        let copy = app.clone();
        app.state::<ExperimentState>().start(
            project_id,
            root,
            configuration,
            None,
            Some(Arc::new(move |value| {
                let _ = tauri::Emitter::emit(&copy, "experiment-event", value);
            })),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn experiment_list(state: State<'_, ExperimentState>) -> Result<Vec<Run>, String> {
    state
        .entries
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .map(|e| e.run.lock().map(|r| r.clone()).map_err(|e| e.to_string()))
        .collect()
}
#[tauri::command]
pub fn experiment_stop(state: State<'_, ExperimentState>, run_id: String) -> Result<(), String> {
    state.stop(&run_id)
}
#[tauri::command]
pub fn experiment_log(state: State<'_, ExperimentState>, run_id: String) -> Result<String, String> {
    read_log(&state, &run_id)
}
pub(crate) fn read_log(state: &ExperimentState, run_id: &str) -> Result<String, String> {
    state.entry(run_id)?;
    let folder = state.directory.join(run_id);
    let native = folder.join("artifacts/.scientify/output.log");
    let path = if native.exists() {
        native
    } else {
        folder.join("output.log")
    };
    scientify_core::research::reject_links(&path)?;
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let len = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(len.saturating_sub(256 * 1024)))
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(256 * 1024)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    Ok(format!(
        "{}{}",
        if len > 256 * 1024 {
            "[仅显示日志末尾 256 KiB，完整日志保存在本机]\n"
        } else {
            ""
        },
        String::from_utf8_lossy(&bytes)
    ))
}
fn list_artifacts(
    root: &Path,
    directory: &Path,
    depth: usize,
    entries: &mut Vec<scientify_core::research::ResearchFile>,
) -> Result<(), String> {
    if depth > 16 {
        return Err("产物目录超过 16 层。".into());
    }
    for item in fs::read_dir(directory).map_err(|e| e.to_string())? {
        let item = item.map_err(|e| e.to_string())?;
        if item.file_name() == ".scientify" {
            continue;
        }
        let path = item.path();
        if scientify_core::research::reject_links(&path).is_err() {
            continue;
        }
        let meta = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        if !meta.is_dir() && !meta.is_file() {
            continue;
        }
        if entries.len() >= 10000 {
            return Err("产物超过 10000 项。".into());
        }
        entries.push(scientify_core::research::ResearchFile {
            path: path
                .strip_prefix(root)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .replace('\\', "/"),
            name: item.file_name().to_string_lossy().into(),
            kind: if meta.is_dir() { "directory" } else { "file" },
            size: meta.len(),
        });
        if meta.is_dir() {
            list_artifacts(root, &path, depth + 1, entries)?;
        }
    }
    Ok(())
}
#[tauri::command]
pub fn experiment_artifacts(
    state: State<'_, ExperimentState>,
    run_id: String,
) -> Result<Vec<scientify_core::research::ResearchFile>, String> {
    artifacts(&state, &run_id)
}
pub(crate) fn artifacts(
    state: &ExperimentState,
    run_id: &str,
) -> Result<Vec<scientify_core::research::ResearchFile>, String> {
    state.entry(run_id)?;
    let root = state.directory.join(run_id).join("artifacts");
    scientify_core::research::reject_links(&root)?;
    let mut entries = Vec::new();
    list_artifacts(&root, &root, 0, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}
#[tauri::command]
pub fn experiment_read_artifact(
    state: State<'_, ExperimentState>,
    run_id: String,
    path: String,
) -> Result<scientify_core::research::FileContent, String> {
    read_artifact(&state, &run_id, path)
}
pub(crate) fn read_artifact(
    state: &ExperimentState,
    run_id: &str,
    path: String,
) -> Result<scientify_core::research::FileContent, String> {
    if path
        .replace('\\', "/")
        .split('/')
        .any(|part| part == ".scientify")
    {
        return Err("运行内部文件不可作为结果读取。".into());
    }
    state.entry(run_id)?;
    let root = state.directory.join(run_id).join("artifacts");
    let target = confined(&root, &path)?;
    let file = fs::File::open(target).map_err(|e| e.to_string())?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > 2 * 1024 * 1024 {
        return Err("产物需为不超过 2 MiB 的文本文件。".into());
    }
    let mut bytes = Vec::new();
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 2 * 1024 * 1024 || bytes.contains(&0) {
        return Err("产物需为不超过 2 MiB 的文本文件。".into());
    }
    let content = String::from_utf8(bytes).map_err(|_| "产物需使用 UTF-8 编码。")?;
    Ok(scientify_core::research::FileContent {
        path,
        content,
        version: "read-only".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stopping_one_run_preserves_other_runs_and_protects_project_paths() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        let state = ExperimentState::new(temp.path().join("runs"));
        let (executable, args) = if cfg!(windows) {
            (
                std::env::var("SystemRoot").unwrap()
                    + "/System32/WindowsPowerShell/v1.0/powershell.exe",
                vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    "Write-Output 'started'; Start-Sleep -Seconds 20".into(),
                ],
            )
        } else {
            ("/bin/sleep".into(), vec!["20".into()])
        };
        let config = Configuration {
            id: "c1".into(),
            name: "independent".into(),
            executable,
            args,
            cwd: ".".into(),
        };
        let a = state
            .start("p1".into(), root.clone(), config.clone(), None, None)
            .unwrap();
        let b = state.start("p1".into(), root, config, None, None).unwrap();
        if cfg!(windows) {
            let deadline = std::time::Instant::now() + Duration::from_secs(60);
            while !read_log(&state, &a.id).unwrap().contains("started")
                || !read_log(&state, &b.id).unwrap().contains("started")
            {
                assert!(
                    std::time::Instant::now() < deadline,
                    "both processes must start before cancellation"
                );
                thread::sleep(Duration::from_millis(50));
            }
        }
        let before = serde_json::json!({"projects":[{"id":"p1","path":"old"}]});
        let after = serde_json::json!({"projects":[{"id":"p1","path":"new"}]});
        assert!(state.protect(Some(&before), Some(&after)).is_err());
        state
            .entry(&a.id)
            .unwrap()
            .cancel
            .store(true, Ordering::SeqCst);
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while state.entry(&a.id).unwrap().run.lock().unwrap().status == "running" {
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            state.entry(&a.id).unwrap().run.lock().unwrap().status,
            "cancelled"
        );
        assert_eq!(
            state.entry(&b.id).unwrap().run.lock().unwrap().status,
            "running"
        );
        state
            .entry(&b.id)
            .unwrap()
            .cancel
            .store(true, Ordering::SeqCst);
    }
    #[test]
    fn rejects_traversal() {
        for value in ["../outside", "C:/temp", "/tmp", ".git/config", "a/../../b"] {
            assert!(relative(value).is_err(), "{value}");
        }
        assert!(relative("src/train.py").is_ok());
    }
    #[cfg(windows)]
    #[test]
    fn sandbox_allows_run_artifacts_and_blocks_external_file_writes() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("project");
        fs::create_dir(&root).unwrap();
        // OS temporary directories can be writable under workspace-write.
        // Check a disposable file outside those platform exceptions.
        let external =
            tempfile::tempdir_in(Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap()).unwrap();
        let outside = external.path().join("outside.txt");
        fs::write(&outside, "unchanged").unwrap();
        let state = ExperimentState::new(temp.path().join("experiments"));
        let executable = std::env::var("SystemRoot").unwrap()
            + "/System32/WindowsPowerShell/v1.0/powershell.exe";
        let config = |name: &str, script: String| Configuration {
            id: name.into(),
            name: name.into(),
            executable: executable.clone(),
            args: vec![
                "-NoProfile".into(),
                "-NonInteractive".into(),
                "-Command".into(),
                script,
            ],
            cwd: ".".into(),
        };
        let bad=state.start("p1".into(),root.clone(),config("blocked",format!("$ErrorActionPreference='Stop'; Set-Content -LiteralPath '{}' -Value 'overwritten' -Encoding Ascii",outside.display().to_string().replace('\'',"''"))),None,None).unwrap();
        let good=state.start("p1".into(),root,config("allowed","$ErrorActionPreference='Stop'; Set-Content -LiteralPath (Join-Path $env:SCIENTIFY_RUN_DIR 'metrics.json') -Value '{\"loss\":0.2}' -Encoding Ascii; Write-Output 'results-written'".into()),None,None).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(60);
        while state.run(&good.id).unwrap().status == "running"
            || state.run(&bad.id).unwrap().status == "running"
        {
            assert!(std::time::Instant::now() < deadline);
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(
            state.run(&good.id).unwrap().status,
            "completed",
            "{:?}; log: {:?}",
            state.run(&good.id),
            read_log(&state, &good.id)
        );
        assert_eq!(
            read_artifact(&state, &good.id, "metrics.json".into())
                .unwrap()
                .content
                .trim(),
            "{\"loss\":0.2}"
        );
        assert!(read_log(&state, &good.id)
            .unwrap()
            .contains("results-written"));
        assert_eq!(state.run(&bad.id).unwrap().status, "failed");
        assert_eq!(fs::read_to_string(outside).unwrap(), "unchanged");
    }
    #[test]
    fn interrupted_records_are_not_replayed() {
        let temp = tempfile::tempdir().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let run = Run {
            id: id.clone(),
            project: "p1".into(),
            name: "test".into(),
            status: "running".into(),
            started_at: now(),
            ended_at: None,
            exit_code: None,
            configuration: Configuration {
                id: "c1".into(),
                name: "test".into(),
                executable: "missing".into(),
                args: vec![],
                cwd: ".".into(),
            },
            directory: "".into(),
            executable: "".into(),
            platform: "".into(),
            git_commit: None,
            git_changes: vec![],
            error: None,
            source: None,
            permission: "workspace-write".into(),
        };
        persist(&temp.path().join(&id), &run).unwrap();
        let state = ExperimentState::new(temp.path().into());
        assert_eq!(
            state.entry(&id).unwrap().run.lock().unwrap().status,
            "interrupted"
        );
    }
}
