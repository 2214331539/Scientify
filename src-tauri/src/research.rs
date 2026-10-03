use super::AppState;
use scientify_core::{
    research::{FileContent, ImportedPdf, ResearchFile, ResearchFiles},
    storage::Storage,
};
use serde::Serialize;
use std::{path::PathBuf, time::Duration};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

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
    let repository = project["repo"]
        .as_str()
        .filter(|path| !path.trim().is_empty());
    files.project_root(
        id,
        project["path"]
            .as_str()
            .filter(|path| !path.trim().is_empty())
            .or(repository),
    )
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
        let _lease = crate::code::Lease::write(&root)?;
        files.write(&root, &path, &content, expected_version.as_deref())
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
        command.creation_flags(0x08000000 | 0x00000004);
    }
    Ok(command)
}

fn bounded_git(
    command: std::process::Command,
) -> Result<(std::process::ExitStatus, Vec<u8>), String> {
    bounded_git_full(command).map(|(status, bytes, _)| (status, bytes))
}
pub(crate) fn bounded_git_full(
    mut command: std::process::Command,
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
        if start.elapsed() > Duration::from_secs(15) {
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

fn client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "网络客户端初始化失败。".into())
}

async fn response_bytes(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if !response.status().is_success() {
        return Err(format!(
            "服务返回 HTTP {}，请检查服务地址、模型名称和访问凭据。",
            response.status().as_u16()
        ));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("服务响应超过大小限制。".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "读取服务响应失败或超时，请稍后重试。")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("服务响应超过大小限制。".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

#[tauri::command]
pub async fn research_fetch_arxiv(query: String) -> Result<String, String> {
    let query = query.trim();
    if query.is_empty() || query.chars().count() > 200 {
        return Err("订阅关键词应为 1–200 个字符。".into());
    }
    let response = client(25)?
        .get("https://export.arxiv.org/api/query")
        .query(&[
            ("search_query", format!("all:{query}")),
            ("start", "0".into()),
            ("max_results", "20".into()),
            ("sortBy", "submittedDate".into()),
            ("sortOrder", "descending".into()),
        ])
        .header(
            reqwest::header::USER_AGENT,
            "Scientify/0.3 (local research workspace)",
        )
        .send()
        .await
        .map_err(|_| "无法连接 arXiv，网络异常或服务暂时不可用。")?;
    String::from_utf8(response_bytes(response, 2 * 1024 * 1024).await?)
        .map_err(|_| "arXiv 响应不是有效 UTF-8。".into())
}

#[cfg(test)]
mod tests {
    use super::*;
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
