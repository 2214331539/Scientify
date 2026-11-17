use super::AppState;
use scientify_core::{
    research::{FileContent, ImportedPdf, ResearchFile, ResearchFiles},
    storage::Storage,
};
use serde::Serialize;
use std::{path::PathBuf, time::Duration};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

/// The folder a project works in: its `path`, or the linked Git `repo` when no path is set.
pub(crate) fn configured_root(project: &serde_json::Value) -> Option<&str> {
    let set = |key: &str| project[key].as_str().filter(|path| !path.trim().is_empty());
    set("path").or_else(|| set("repo"))
}

pub(crate) fn project_root(
    storage: &Storage,
    files: &ResearchFiles,
    id: &str,
) -> Result<PathBuf, String> {
    let data = storage.load()?.ok_or("请先保存项目。")?;
    let project = data["projects"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p["id"].as_str() == Some(id)))
        .ok_or("项目不存在，请返回项目管理重新打开。")?;
    files.project_root(id, configured_root(project))
}

// A project's four places are kept apart: the literature folder the user picks,
// the code folder (`project_root`), the writing folder for manuscripts and the
// AI workspace where the assistant puts what it makes. The last two live in
// Scientify's data next to the default code folder, as `projects/<kind>-<id>`.
fn managed_root(storage: &Storage, kind: &str, id: &str) -> Result<PathBuf, String> {
    if !scientify_core::workspace::valid_id(id) {
        return Err("项目标识无效。".into());
    }
    Ok(storage
        .directory()
        .join("projects")
        .join(format!("{kind}-{id}")))
}

/// The AI workspace: the assistant works and leaves what it makes here unless told otherwise.
pub(crate) fn ai_root(storage: &Storage, id: &str) -> Result<PathBuf, String> {
    let root = managed_root(storage, "ai", id)?;
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    root.canonicalize().map_err(|e| e.to_string())
}

/// The writing folder, where manuscripts live. The first time, manuscripts that
/// were registered inside the code folder move here (copied when the code folder
/// is the user's own, so nothing of theirs disappears).
pub(crate) fn writing_root(
    storage: &Storage,
    files: &ResearchFiles,
    id: &str,
) -> Result<PathBuf, String> {
    let root = managed_root(storage, "writing", id)?;
    if !root.exists() {
        std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        if let Err(error) = adopt_manuscripts(storage, files, id, &root) {
            eprintln!("Scientify 稿件迁到写作文件夹失败：{error}");
        }
    }
    root.canonicalize().map_err(|e| e.to_string())
}

fn adopt_manuscripts(
    storage: &Storage,
    files: &ResearchFiles,
    id: &str,
    writing: &std::path::Path,
) -> Result<(), String> {
    let data = storage.load()?.ok_or("工作区尚未载入。")?;
    let Some(project) = data["projects"]
        .as_array()
        .and_then(|ps| ps.iter().find(|p| p["id"].as_str() == Some(id)))
    else {
        return Ok(());
    };
    let code = files.project_root(id, configured_root(project))?;
    let managed = configured_root(project).is_none();
    for manuscript in project["manuscripts"].as_array().into_iter().flatten() {
        let Some(folder) = manuscript["folder"].as_str().filter(|f| !f.is_empty()) else {
            continue;
        };
        let relative = std::path::Path::new(folder);
        if !relative
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
        {
            continue;
        }
        let (from, to) = (code.join(relative), writing.join(relative));
        if !from.is_dir() || to.exists() {
            continue;
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        if managed {
            std::fs::rename(&from, &to).map_err(|e| e.to_string())?;
        } else {
            copy_tree(&from, &to)?;
        }
    }
    Ok(())
}

fn copy_tree(from: &std::path::Path, to: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(to).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let kind = entry.file_type().map_err(|e| e.to_string())?;
        let target = to.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else if kind.is_file() {
            std::fs::copy(entry.path(), target).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// Whether two folders are the same or one holds the other.
pub(crate) fn overlaps(a: &std::path::Path, b: &std::path::Path) -> bool {
    let a = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let b = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    a.starts_with(&b) || b.starts_with(&a)
}

/// Every project's literature folder, as `library::LocalLibrary` records them.
pub(crate) fn literature_roots(storage: &Storage) -> Vec<PathBuf> {
    std::fs::read(storage.directory().join("literature-roots.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|roots| roots.as_object().cloned())
        .map(|roots| {
            roots
                .values()
                .filter_map(|path| path.as_str().map(PathBuf::from))
                .collect()
        })
        .unwrap_or_default()
}

/// Refuses a literature folder that is, holds or sits in the project's code,
/// writing or AI folder, or any experiment's code folder.
pub(crate) fn check_literature(
    storage: &Storage,
    files: &ResearchFiles,
    project: &str,
    literature: &std::path::Path,
) -> Result<(), String> {
    let mut taken = vec![
        ("代码文件夹", project_root(storage, files, project)?),
        ("写作文件夹", writing_root(storage, files, project)?),
        ("AI 工作区", ai_root(storage, project)?),
    ];
    if let Some(data) = storage.load()? {
        for experiment in data["experiments"].as_array().into_iter().flatten() {
            if experiment["archived"] == true {
                continue;
            }
            if let Ok(root) =
                crate::experiments::catalog::root_of(storage, files, &data, experiment)
            {
                taken.push(("实验代码文件夹", root));
            }
        }
    }
    for (name, root) in taken {
        if overlaps(literature, &root) {
            return Err(format!(
                "文献文件夹不能和{name}（{}）相同或互相包含，请另选一个只放文献的文件夹。",
                crate::local_process::process_path(&root).display()
            ));
        }
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectFolders {
    literature: Option<String>,
    code: String,
    writing: String,
    workspace: String,
}

/// The folders of a project that file previews may read: each experiment's code,
/// the writing folder, the AI workspace and the project's code folder, most
/// specific first.
fn project_places(
    storage: &Storage,
    files: &ResearchFiles,
    project: &str,
) -> Result<Vec<PathBuf>, String> {
    let mut places = Vec::new();
    if let Some(data) = storage.load()? {
        for experiment in data["experiments"].as_array().into_iter().flatten() {
            if experiment["project"].as_str() == Some(project) && experiment["archived"] != true {
                if let Ok(root) =
                    crate::experiments::catalog::root_of(storage, files, &data, experiment)
                {
                    places.push(root);
                }
            }
        }
    }
    places.push(writing_root(storage, files, project)?);
    places.push(ai_root(storage, project)?);
    places.push(project_root(storage, files, project)?);
    Ok(places
        .into_iter()
        .filter_map(|place| place.canonicalize().ok())
        .collect())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocatedFile {
    /// The project folder holding it, to pass as `workspaceRoot`.
    root: String,
    /// Its path inside that folder, with `/`.
    path: String,
}

fn locate(
    storage: &Storage,
    files: &ResearchFiles,
    project: &str,
    path: &str,
) -> Result<Option<(PathBuf, LocatedFile)>, String> {
    let Ok(file) = PathBuf::from(path.trim()).canonicalize() else {
        return Ok(None);
    };
    if !file.is_file() {
        return Ok(None);
    }
    for root in project_places(storage, files, project)? {
        if let Ok(relative) = file.strip_prefix(&root) {
            let path = relative
                .components()
                .map(|part| part.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            return Ok(Some((
                file.clone(),
                LocatedFile {
                    root: root.display().to_string(),
                    path,
                },
            )));
        }
    }
    Ok(None)
}

/// A file of the project's folders, for the browser to open; `None` outside them.
pub(crate) fn project_file(
    storage: &Storage,
    files: &ResearchFiles,
    project: &str,
    path: &str,
) -> Result<Option<PathBuf>, String> {
    Ok(locate(storage, files, project, path)?.map(|(file, _)| file))
}

/// Where a file named in an AI answer lives among the project's folders, so the
/// center can preview it; `None` for files elsewhere (or missing).
#[tauri::command]
pub async fn research_locate(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<Option<LocatedFile>, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        Ok(locate(&storage, &files, &project_id, &path)?.map(|(_, located)| located))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Opens a project file with the system's program for it (an HTML report in the
/// browser, say). Only files in the project's folders.
#[tauri::command]
pub async fn research_open_system(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let (storage, files) = (state.storage.clone(), state.files.clone());
    let file = tauri::async_runtime::spawn_blocking(move || {
        locate(&storage, &files, &project_id, &path)?
            .map(|(file, _)| file)
            .ok_or_else(|| "只能打开项目文件夹里的文件。".to_string())
    })
    .await
    .map_err(|e| e.to_string())??;
    let shown = crate::local_process::process_path(&file)
        .display()
        .to_string();
    app.opener()
        .open_path(shown, None::<&str>)
        .map_err(|e| e.to_string())
}

/// The project's four places, for the writing page and project settings.
#[tauri::command]
pub async fn project_folders(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ProjectFolders, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    let literature = tauri::Manager::state::<crate::library::LibraryState>(&app)
        .service
        .root(&project_id)
        .ok()
        .flatten();
    tauri::async_runtime::spawn_blocking(move || {
        let show = |path: PathBuf| {
            crate::local_process::process_path(&path)
                .display()
                .to_string()
        };
        Ok(ProjectFolders {
            literature: literature.map(show),
            code: show(project_root(&storage, &files, &project_id)?),
            writing: show(writing_root(&storage, &files, &project_id)?),
            workspace: show(ai_root(&storage, &project_id)?),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_list_files(
    state: State<'_, AppState>,
    project_id: String,
    workspace_root: Option<String>,
) -> Result<Vec<ResearchFile>, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        files.list(&crate::git::resolve(
            &storage,
            &files,
            &project_id,
            workspace_root.as_deref(),
        )?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_read_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    workspace_root: Option<String>,
) -> Result<FileContent, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        files.read(
            &crate::git::resolve(&storage, &files, &project_id, workspace_root.as_deref())?,
            &path,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_write_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    content: String,
    expected_version: Option<String>,
    workspace_root: Option<String>,
) -> Result<FileContent, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::git::resolve(&storage, &files, &project_id, workspace_root.as_deref())?;
        crate::collaboration::permissions::require_write(&storage, &project_id, "code")?;
        let _lease = crate::code::Lease::write(&root)?;
        files.write(&root, &path, &content, expected_version.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_read_binary(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    workspace_root: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::git::resolve(&storage, &files, &project_id, workspace_root.as_deref())?;
        files
            .read_bytes(&root, &path)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Shows a project file in the system file manager; nothing is opened or run.
#[tauri::command]
pub async fn research_reveal(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let (storage, files) = (state.storage.clone(), state.files.clone());
    let file = tauri::async_runtime::spawn_blocking(move || {
        let root = crate::git::resolve(&storage, &files, &project_id, workspace_root.as_deref())?;
        files.locate(&root, &path)
    })
    .await
    .map_err(|e| e.to_string())??;
    app.opener()
        .reveal_item_in_dir(file)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn research_create_directory(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
    workspace_root: Option<String>,
) -> Result<String, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let root = crate::git::resolve(&storage, &files, &project_id, workspace_root.as_deref())?;
        crate::collaboration::permissions::require_write(&storage, &project_id, "code")?;
        let _lease = crate::code::Lease::write(&root)?;
        files.create_directory(&root, &path)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_import_pdf(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<ImportedPdf>, String> {
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("PDF", &["pdf"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        files
            .import_pdf(&file.into_path().map_err(|e| e.to_string())?)
            .map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_read_pdf(
    state: State<'_, AppState>,
    asset_id: String,
) -> Result<tauri::ipc::Response, String> {
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        files.read_pdf(&asset_id).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[derive(Serialize)]
pub(crate) struct GitChange {
    pub(crate) path: String,
    pub(crate) status: String,
    #[serde(rename = "oldPath", skip_serializing_if = "Option::is_none")]
    pub(crate) old_path: Option<String>,
}

fn parse_git(bytes: &[u8]) -> Result<Vec<GitChange>, String> {
    let text =
        std::str::from_utf8(bytes).map_err(|_| "Git 返回的文件名不是 UTF-8，暂时无法显示。")?;
    let mut parts = text.split('\0');
    let mut changes = Vec::new();
    while let Some(item) = parts.next() {
        if item.is_empty() {
            continue;
        }
        if item.len() < 4 || !item.as_bytes()[..2].is_ascii() || item.as_bytes()[2] != b' ' {
            return Err("Git 状态格式无法识别。".into());
        }
        let status = &item[..2];
        let old_path = if status.contains(['R', 'C']) {
            Some(
                parts
                    .next()
                    .filter(|p| !p.is_empty())
                    .ok_or("Git 重命名来源缺失。")?
                    .into(),
            )
        } else {
            None
        };
        changes.push(GitChange {
            path: item[3..].into(),
            status: status.into(),
            old_path,
        });
        if changes.len() > 10_000 {
            return Err("Git 变更超过 10000 项，请缩小项目范围。".into());
        }
    }
    Ok(changes)
}

#[tauri::command]
pub async fn research_git_status(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<GitChange>, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            crate::git::repository_for(&storage, &project_root(&storage, &files, &project_id)?)?;
        git_status(&root)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn git_executable() -> Result<PathBuf, String> {
    // Do not let Windows executable lookup discover a git.exe in the project cwd.
    let path = std::env::var_os("PATH").ok_or("PATH 未配置，无法查找 Git。")?;
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    std::env::split_paths(&path)
        .filter(|p| p.is_absolute())
        .map(|p| p.join(name))
        .find(|p| p.is_file())
        .ok_or_else(|| "无法启动 Git，请确认已安装 Git 并加入 PATH。".into())
}

pub(crate) fn git_command(root: &std::path::Path) -> Result<std::process::Command, String> {
    use std::process::{Command, Stdio};
    let mut command = Command::new(git_executable()?);
    command
        .args([
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "status.submoduleSummary=false",
        ])
        .current_dir(root)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_CONFIG_COUNT", "0")
        .env("GIT_CEILING_DIRECTORIES", root.parent().unwrap_or(root))
        .env_remove("GIT_CONFIG_PARAMETERS")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_INDEX_FILE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_OBJECT_DIRECTORY")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::experiments::runner::job::CREATION_FLAGS);
    }
    Ok(command)
}

fn bounded_git(
    command: std::process::Command,
) -> Result<(std::process::ExitStatus, Vec<u8>), String> {
    bounded_git_full(command).map(|(status, bytes, _)| (status, bytes))
}
pub(crate) fn bounded_git_full(
    command: std::process::Command,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    bounded_git_within(command, Duration::from_secs(15))
}

/// Runs Git inside a kill-on-close job, giving up after `limit`.
pub(crate) fn bounded_git_within(
    mut command: std::process::Command,
    limit: Duration,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    use std::{io::Read, thread, time::Instant};
    command.stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 Git，请确认已安装 Git 并加入 PATH。")?;
    #[cfg(windows)]
    let job = match crate::experiments::runner::job::Job::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let mut stdout = child.stdout.take().ok_or("Git 输出不可用。")?;
    let mut stderr = child.stderr.take().ok_or("Git 错误输出不可用。")?;
    let errors = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0; 8192];
        loop {
            let count = stderr.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            let remaining = (32 * 1024usize).saturating_sub(bytes.len());
            bytes.extend_from_slice(&buffer[..count.min(remaining)]);
        }
        Ok::<_, String>(bytes)
    });
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut buffer = [0; 8192];
        let mut overflow = false;
        loop {
            let count = stdout.read(&mut buffer).map_err(|e| e.to_string())?;
            if count == 0 {
                break;
            }
            if bytes.len() + count <= 2 * 1024 * 1024 {
                bytes.extend_from_slice(&buffer[..count]);
            } else {
                overflow = true;
            }
        }
        if overflow {
            Err("Git 输出超过 2 MiB 限制。".to_string())
        } else {
            Ok(bytes)
        }
    });
    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Err(_) => {
                #[cfg(windows)]
                let _ = job.terminate();
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                let _ = errors.join();
                return Err("无法读取 Git 进程状态。".into());
            }
            Ok(None) => (),
        }
        if start.elapsed() > limit {
            #[cfg(windows)]
            let _ = job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            let _ = errors.join();
            return Err("Git 操作超时，请检查仓库状态后重试。".into());
        }
        thread::sleep(Duration::from_millis(25));
    };
    #[cfg(windows)]
    let _ = job.terminate();
    let bytes = reader.join().map_err(|_| "Git 输出读取失败。")?;
    let error = errors.join().map_err(|_| "Git 错误读取失败。")??;
    Ok((status, bytes?, error))
}

pub(crate) fn git_status(root: &std::path::Path) -> Result<Vec<GitChange>, String> {
    if !root.join(".git").exists() {
        return Err("所选目录不是 Git 仓库根目录，请在项目设置中选择仓库目录。".into());
    }
    scientify_core::research::reject_links(&root.join(".git"))?;
    let mut config = git_command(root)?;
    config.args([
        "config",
        "--null",
        "--name-only",
        "--get-regexp",
        "^filter\\.",
    ]);
    let (status, bytes) = bounded_git(config)?;
    if !status.success() && status.code() != Some(1) {
        return Err("无法安全读取 Git 配置，请在终端检查此仓库。".into());
    }
    let names = std::str::from_utf8(&bytes).map_err(|_| "Git 过滤器配置不是 UTF-8。")?;
    let mut drivers = std::collections::BTreeSet::new();
    for key in names.split('\0').filter(|key| !key.is_empty()) {
        if let Some((prefix, field)) = key.rsplit_once('.') {
            if matches!(field, "clean" | "smudge" | "process" | "required") {
                drivers.insert(prefix.to_string());
            }
        }
    }
    if drivers.len() > 64 || drivers.iter().map(String::len).sum::<usize>() > 2048 {
        return Err("Git 自定义过滤器配置过多，当前只读视图无法安全加载。".into());
    }
    if drivers
        .iter()
        .any(|driver| driver.contains('=') || driver.chars().any(char::is_control))
    {
        return Err("Git 过滤器名称包含不支持的字符，当前只读视图无法安全加载。".into());
    }
    let mut command = git_command(root)?;
    // Status can invoke clean/process filters while checking file content. Disable
    // all configured drivers for this invocation without modifying user config.
    for driver in drivers {
        for field in ["clean", "smudge", "process"] {
            command.arg("-c").arg(format!("{driver}.{field}="));
        }
        command.arg("-c").arg(format!("{driver}.required=false"));
    }
    command.args([
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
        "--ignore-submodules=all",
    ]);
    let (status, bytes) = bounded_git(command)?;
    if !status.success() {
        return Err("此项目不是可读取的 Git 仓库，或 Git 权限/配置不允许访问。".into());
    }
    parse_git(&bytes)
}

pub(crate) fn git_head(root: &std::path::Path) -> Result<String, String> {
    let mut command = git_command(root)?;
    command.args(["rev-parse", "--verify", "HEAD"]);
    let (status, bytes) = bounded_git(command)?;
    if !status.success() {
        return Err("没有 HEAD 提交。".into());
    }
    Ok(String::from_utf8_lossy(&bytes).trim().into())
}
#[tauri::command]
pub async fn research_git_diff(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<String, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let root =
            crate::git::repository_for(&storage, &project_root(&storage, &files, &project_id)?)?;
        let changes = git_status(&root)?;
        if !changes.iter().any(|c| c.path == path) {
            return Err("文件不在当前变更列表中，请刷新。".into());
        }
        if path.starts_with('-')
            || path.contains(['\0', ':'])
            || std::path::Path::new(&path)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("差异路径无效。".into());
        }
        if changes.iter().any(|c| c.path == path && c.status == "??") {
            let file = files.read(&root, &path)?;
            return Ok(format!(
                "--- /dev/null\n+++ b/{path}\n@@ -0,0 +1,{} @@\n{}",
                file.content.lines().count(),
                file.content
                    .lines()
                    .map(|l| format!("+{l}\n"))
                    .collect::<String>()
            ));
        }
        let mut command = git_command(&root)?;
        command.args([
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--no-color",
            "--unified=3",
        ]);
        // Unborn repositories compare against the index; otherwise include staged changes.
        if git_head(&root).is_ok() {
            command.arg("HEAD");
        }
        command.arg("--").arg(&path);
        let (status, bytes) = bounded_git(command)?;
        if !status.success() {
            return Err("无法读取 Git 差异。".into());
        }
        String::from_utf8(bytes).map_err(|_| "二进制或非 UTF-8 文件无法显示文本差异。".into())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn project(temp: &std::path::Path, extra: serde_json::Value) -> (Storage, ResearchFiles) {
        let storage = Storage::open(temp.join("data")).unwrap();
        let mut data = scientify_core::workspace::empty();
        let mut project = serde_json::json!({"id":"p1","name":"P","space":"personal","question":"","createdAt":"",
            "manuscripts":[{"id":"m1","name":"ICLR","folder":"paper","main":"main.tex"}]});
        for (key, value) in extra.as_object().unwrap() {
            project[key] = value.clone();
        }
        data["projects"] = serde_json::json!([project]);
        data["revision"] = serde_json::json!(1);
        storage.save(data, 0).unwrap();
        let files = ResearchFiles::new(storage.directory().to_path_buf());
        (storage, files)
    }

    #[test]
    fn manuscripts_move_out_of_the_default_code_folder_into_the_writing_folder() {
        let temp = tempfile::tempdir().unwrap();
        let (storage, files) = project(temp.path(), serde_json::json!({}));
        let code = project_root(&storage, &files, "p1").unwrap();
        std::fs::create_dir_all(code.join("paper")).unwrap();
        std::fs::write(code.join("paper/main.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(code.join("train.py"), "print(1)").unwrap();
        let writing = writing_root(&storage, &files, "p1").unwrap();
        assert!(writing.join("paper/main.tex").is_file());
        assert!(!code.join("paper").exists());
        assert!(code.join("train.py").is_file());
        let ai = ai_root(&storage, "p1").unwrap();
        for (a, b) in [(&code, &writing), (&code, &ai), (&writing, &ai)] {
            assert!(!overlaps(a, b), "{} {}", a.display(), b.display());
        }
    }

    #[test]
    fn manuscripts_in_the_users_own_code_folder_are_copied_not_moved() {
        let temp = tempfile::tempdir().unwrap();
        let own = temp.path().join("repo");
        std::fs::create_dir_all(own.join("paper")).unwrap();
        std::fs::write(own.join("paper/main.tex"), "x").unwrap();
        let (storage, files) = project(temp.path(), serde_json::json!({"path": own}));
        let writing = writing_root(&storage, &files, "p1").unwrap();
        assert!(writing.join("paper/main.tex").is_file());
        assert!(own.join("paper/main.tex").is_file());
    }

    #[test]
    fn a_literature_folder_never_shares_the_code_writing_or_ai_folder() {
        let temp = tempfile::tempdir().unwrap();
        let own = temp.path().join("research");
        std::fs::create_dir_all(own.join("papers")).unwrap();
        let (storage, files) = project(temp.path(), serde_json::json!({"path": own}));
        assert!(check_literature(&storage, &files, "p1", &own).is_err());
        assert!(check_literature(&storage, &files, "p1", &own.join("papers")).is_err());
        assert!(check_literature(&storage, &files, "p1", temp.path()).is_err());
        let ai = ai_root(&storage, "p1").unwrap();
        assert!(check_literature(&storage, &files, "p1", &ai).is_err());
        let papers = temp.path().join("papers");
        std::fs::create_dir_all(&papers).unwrap();
        assert!(check_literature(&storage, &files, "p1", &papers).is_ok());
    }

    #[test]
    fn files_named_in_answers_are_found_only_in_the_projects_folders() {
        let temp = tempfile::tempdir().unwrap();
        let (storage, files) = project(temp.path(), serde_json::json!({}));
        let ai = ai_root(&storage, "p1").unwrap();
        std::fs::create_dir_all(ai.join("figures")).unwrap();
        std::fs::write(ai.join("figures/curve.png"), b"png").unwrap();
        let found = locate(
            &storage,
            &files,
            "p1",
            &ai.join("figures/curve.png").display().to_string(),
        )
        .unwrap()
        .unwrap()
        .1;
        assert_eq!(found.path, "figures/curve.png");
        assert_eq!(PathBuf::from(&found.root), ai);
        let outside = temp.path().join("secret.txt");
        std::fs::write(&outside, b"x").unwrap();
        assert!(
            locate(&storage, &files, "p1", &outside.display().to_string())
                .unwrap()
                .is_none()
        );
        assert!(locate(&storage, &files, "p1", "relative/path.txt")
            .unwrap()
            .is_none());
    }

    #[test]
    fn parses_git_spaces_and_rename_records() {
        let changes = parse_git(b" M chapter one.md\0R  new.md\0old.md\0?? draft.py\0").unwrap();
        assert_eq!(changes.len(), 3);
        assert_eq!(changes[0].path, "chapter one.md");
        assert_eq!(changes[1].path, "new.md");
    }

    #[test]
    fn git_status_never_executes_repository_filters_or_updates_the_index() {
        use std::fs;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for args in [
            vec!["init", "--quiet"],
            vec!["config", "core.autocrlf", "false"],
        ] {
            let mut command = git_command(root).unwrap();
            command.args(args);
            assert!(bounded_git(command).unwrap().0.success());
        }
        fs::write(root.join("tracked.txt"), "original").unwrap();
        let mut add = git_command(root).unwrap();
        add.args(["add", "tracked.txt"]);
        assert!(bounded_git(add).unwrap().0.success());
        fs::write(root.join(".gitattributes"), "*.txt filter=probe\n").unwrap();
        for (key, value) in [
            ("filter.probe.clean", "echo executed > filter-ran.txt; cat"),
            ("filter.probe.required", "true"),
            ("core.fsmonitor", "echo executed > monitor-ran.txt"),
        ] {
            let mut config = git_command(root).unwrap();
            config.args(["config", key, value]);
            assert!(bounded_git(config).unwrap().0.success());
        }
        fs::write(root.join("tracked.txt"), "changed content").unwrap();
        let index = fs::read(root.join(".git/index")).unwrap();
        let changes = git_status(root).unwrap();
        assert!(changes.iter().any(|change| change.path == "tracked.txt"));
        assert!(!root.join("filter-ran.txt").exists());
        assert!(!root.join("monitor-ran.txt").exists());
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), index);
        let mut config = git_command(root).unwrap();
        config.args([
            "config",
            "filter.invalid=name.clean",
            "echo executed > invalid-ran.txt; cat",
        ]);
        assert!(bounded_git(config).unwrap().0.success());
        assert!(git_status(root).is_err());
        assert!(!root.join("invalid-ran.txt").exists());
    }
}
