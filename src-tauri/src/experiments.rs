use crate::{research, AppState};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};

#[derive(Clone, Serialize, Deserialize, Debug)]
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
    fn start(&self, project: String, root: PathBuf, config: Configuration) -> Result<Run, String> {
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
        };
        persist(&directory, &run)?;
        let log = fs::File::create(directory.join("output.log")).map_err(|e| e.to_string())?;
        fs::create_dir_all(directory.join("artifacts")).map_err(|e| e.to_string())?;
        let mut command = Command::new(process_path(&executable));
        command
            .args(&config.args)
            .current_dir(process_path(&cwd))
            .env("PYTHONUNBUFFERED", "1")
            .env(
                "SCIENTIFY_RUN_DIR",
                process_path(&directory.join("artifacts")),
            )
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
            .stderr(Stdio::from(log));
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(e) => {
                let mut failed = run;
                failed.status = "failed".into();
                failed.ended_at = Some(now());
                failed.error = Some(e.to_string());
                persist(&directory, &failed)?;
                entries.insert(
                    id,
                    Arc::new(Entry {
                        run: Mutex::new(failed.clone()),
                        cancel: AtomicBool::new(false),
                    }),
                );
                return Ok(failed);
            }
        };
        let entry = Arc::new(Entry {
            run: Mutex::new(run.clone()),
            cancel: AtomicBool::new(false),
        });
        entries.insert(id, entry.clone());
        thread::spawn(move || {
            let mut cancel_sent = false;
            let mut limit_hit = false;
            loop {
                if !limit_hit
                    && fs::metadata(directory.join("output.log"))
                        .is_ok_and(|m| m.len() > 64 * 1024 * 1024)
                {
                    limit_hit = true;
                    entry.cancel.store(true, Ordering::SeqCst);
                    if let Ok(mut r) = entry.run.lock() {
                        r.error = Some("日志超过 64 MiB，已停止运行以保护磁盘空间。".into());
                    }
                }
                if entry.cancel.load(Ordering::SeqCst) && !cancel_sent {
                    #[cfg(windows)]
                    {
                        use std::os::windows::process::CommandExt;
                        let system = std::env::var_os("SystemRoot")
                            .map(PathBuf::from)
                            .unwrap_or_else(|| PathBuf::from("C:/Windows"));
                        let _ = Command::new(system.join("System32/taskkill.exe"))
                            .args(["/PID", &child.id().to_string(), "/T", "/F"])
                            .creation_flags(0x08000000)
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .status();
                    }
                    let _ = child.kill();
                    cancel_sent = true;
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if let Ok(mut r) = entry.run.lock() {
                            r.exit_code = status.code();
                            r.status = if limit_hit {
                                "failed"
                            } else if cancel_sent {
                                "cancelled"
                            } else if status.success() {
                                "completed"
                            } else {
                                "failed"
                            }
                            .into();
                            r.ended_at = Some(now());
                            if let Err(e) = persist(&directory, &r) {
                                r.error = Some(format!("记录保存失败：{e}"));
                            }
                        }
                        break;
                    }
                    Err(e) => {
                        let _ = child.kill();
                        let _ = child.wait();
                        if let Ok(mut r) = entry.run.lock() {
                            r.status = "failed".into();
                            r.ended_at = Some(now());
                            r.error = Some(e.to_string());
                            let _ = persist(&directory, &r);
                        }
                        break;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(100)),
                }
            }
        });
        Ok(run)
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
        app.state::<ExperimentState>()
            .start(project_id, root, configuration)
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
    state.entry(&run_id)?.cancel.store(true, Ordering::SeqCst);
    Ok(())
}
#[tauri::command]
pub fn experiment_log(state: State<'_, ExperimentState>, run_id: String) -> Result<String, String> {
    state.entry(&run_id)?;
    let path = state.directory.join(&run_id).join("output.log");
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
    state.entry(&run_id)?;
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
    state.entry(&run_id)?;
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
                    "Start-Sleep -Seconds 20".into(),
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
            .start("p1".into(), root.clone(), config.clone())
            .unwrap();
        let b = state.start("p1".into(), root, config).unwrap();
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
        };
        persist(&temp.path().join(&id), &run).unwrap();
        let state = ExperimentState::new(temp.path().into());
        assert_eq!(
            state.entry(&id).unwrap().run.lock().unwrap().status,
            "interrupted"
        );
    }
}
