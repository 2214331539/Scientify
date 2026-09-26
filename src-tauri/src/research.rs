use super::AppState;
use scientify_core::{
    research::{FileContent, ImportedPdf, ResearchFile, ResearchFiles},
    storage::Storage,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};
use tauri::State;
use tauri_plugin_dialog::DialogExt;

fn project_root(storage: &Storage, files: &ResearchFiles, id: &str) -> Result<PathBuf, String> {
    project_root_for(storage, files, id, false)
}

fn project_root_for(
    storage: &Storage,
    files: &ResearchFiles,
    id: &str,
    git: bool,
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
        if git {
            repository.or_else(|| project["path"].as_str())
        } else {
            project["path"].as_str()
        },
    )
}

#[tauri::command]
pub async fn research_list_files(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Vec<ResearchFile>, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        files.list(&project_root(&storage, &files, &project_id)?)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn research_read_file(
    state: State<'_, AppState>,
    project_id: String,
    path: String,
) -> Result<FileContent, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        files.read(&project_root(&storage, &files, &project_id)?, &path)
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
) -> Result<FileContent, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        files.write(
            &project_root(&storage, &files, &project_id)?,
            &path,
            &content,
            expected_version.as_deref(),
        )
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
pub struct GitChange {
    path: String,
    status: String,
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
        changes.push(GitChange {
            path: item[3..].into(),
            status: status.into(),
        });
        if status.contains(['R', 'C']) {
            parts.next();
        }
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
        let root = project_root_for(&storage, &files, &project_id, true)?;
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

fn git_command(root: &std::path::Path) -> Result<std::process::Command, String> {
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
        command.creation_flags(0x08000000);
    }
    Ok(command)
}

fn bounded_git(
    mut command: std::process::Command,
) -> Result<(std::process::ExitStatus, Vec<u8>), String> {
    use std::{io::Read, thread, time::Instant};
    let mut child = command
        .spawn()
        .map_err(|_| "无法启动 Git，请确认已安装 Git 并加入 PATH。")?;
    let mut stdout = child.stdout.take().ok_or("Git 输出不可用。")?;
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
                let _ = child.kill();
                let _ = child.wait();
                let _ = reader.join();
                return Err("无法读取 Git 进程状态。".into());
            }
            Ok(None) => (),
        }
        if start.elapsed() > Duration::from_secs(15) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = reader.join();
            return Err("Git 状态查询超时，请在终端检查此仓库。".into());
        }
        thread::sleep(Duration::from_millis(25));
    };
    Ok((status, reader.join().map_err(|_| "Git 输出读取失败。")??))
}

fn git_status(root: &std::path::Path) -> Result<Vec<GitChange>, String> {
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
        "--untracked-files=normal",
        "--ignore-submodules=all",
    ]);
    let (status, bytes) = bounded_git(command)?;
    if !status.success() {
        return Err("此项目不是可读取的 Git 仓库，或 Git 权限/配置不允许访问。".into());
    }
    parse_git(&bytes)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    System,
    User,
    Assistant,
}
#[derive(Deserialize, Serialize)]
pub struct Message {
    role: Role,
    content: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    Openai,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AIRequest {
    endpoint: String,
    model: String,
    api_key: Option<String>,
    provider: Provider,
    messages: Vec<Message>,
}

fn endpoint(request: &AIRequest) -> Result<reqwest::Url, String> {
    if request.endpoint.len() > 4096 {
        return Err("模型服务地址过长。".into());
    }
    let mut url =
        reqwest::Url::parse(request.endpoint.trim()).map_err(|_| "模型服务地址格式无效。")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("模型服务必须使用 HTTP(S)，地址不能包含密码、查询参数或片段。".into());
    }
    let local = url
        .host_str()
        .is_some_and(|h| matches!(h, "localhost" | "127.0.0.1" | "[::1]" | "::1"));
    if url.scheme() == "http" && !local && request.api_key.as_ref().is_some_and(|k| !k.is_empty()) {
        return Err("带 API Key 的远程模型服务必须使用 HTTPS。".into());
    }
    let path = url.path().trim_end_matches('/');
    let next = match request.provider {
        Provider::Ollama if path.ends_with("/api/chat") => path.to_string(),
        Provider::Ollama if path.ends_with("/api") => format!("{path}/chat"),
        Provider::Ollama => format!("{path}/api/chat"),
        Provider::Openai if path.ends_with("/chat/completions") => path.to_string(),
        Provider::Openai if path.ends_with("/v1") => format!("{path}/chat/completions"),
        Provider::Openai => format!("{path}/v1/chat/completions"),
    };
    url.set_path(&next);
    Ok(url)
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
pub async fn research_ask_ai(request: AIRequest) -> Result<String, String> {
    static BUSY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if BUSY.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return Err("已有模型请求正在执行，请等待当前回答完成。".into());
    }
    struct Release;
    impl Drop for Release {
        fn drop(&mut self) {
            BUSY.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _release = Release;
    if request.model.trim().is_empty() || request.model.len() > 256 {
        return Err("请配置有效的模型名称。".into());
    }
    if request.messages.is_empty()
        || request.messages.len() > 50
        || request
            .messages
            .iter()
            .map(|m| m.content.len())
            .sum::<usize>()
            > 256 * 1024
    {
        return Err("对话超过 50 条或 256 KiB 上下文限制，请新建对话或减少上下文。".into());
    }
    if request.api_key.as_ref().is_some_and(|k| k.len() > 4096) {
        return Err("API Key 长度无效。".into());
    }
    let url = endpoint(&request)?;
    let body = match request.provider {
        Provider::Ollama => {
            json!({"model":request.model,"messages":request.messages,"stream":false,"options":{"num_predict":4096}})
        }
        Provider::Openai => {
            json!({"model":request.model,"messages":request.messages,"stream":false,"max_tokens":4096})
        }
    };
    let mut call = client(90)?.post(url).json(&body);
    if let Some(key) = request.api_key.as_ref().filter(|s| !s.is_empty()) {
        call = call.bearer_auth(key);
    }
    let response = call.send().await.map_err(|e| {
        if e.is_timeout() {
            "模型请求超时，请检查服务或缩小上下文。"
        } else {
            "无法连接模型服务，请检查地址、网络与服务状态。"
        }
    })?;
    let bytes = response_bytes(response, 1024 * 1024).await?;
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|_| "模型服务返回了无法解析的 JSON。")?;
    let output = match request.provider {
        Provider::Ollama => value["message"]["content"].as_str(),
        Provider::Openai => value["choices"][0]["message"]["content"].as_str(),
    };
    output
        .filter(|s| !s.trim().is_empty())
        .map(String::from)
        .ok_or_else(|| "模型没有返回文本回答，请检查模型是否支持对话。".into())
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
    fn request(endpoint: &str, provider: Provider) -> AIRequest {
        AIRequest {
            endpoint: endpoint.into(),
            provider,
            model: "m".into(),
            api_key: None,
            messages: vec![],
        }
    }
    #[test]
    fn constructs_endpoints_and_rejects_credentials() {
        assert_eq!(
            endpoint(&request("http://127.0.0.1:11434", Provider::Ollama))
                .unwrap()
                .path(),
            "/api/chat"
        );
        assert_eq!(
            endpoint(&request("https://example.com/v1", Provider::Openai))
                .unwrap()
                .path(),
            "/v1/chat/completions"
        );
        for bad in [
            "file:///tmp/model",
            "https://secret@example.com",
            "https://example.com?key=x",
        ] {
            assert!(endpoint(&request(bad, Provider::Openai)).is_err());
        }
        let mut r = request("http://example.com", Provider::Openai);
        r.api_key = Some("secret".into());
        assert!(endpoint(&r).is_err());
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

    #[test]
    fn ai_http_adapters_send_real_requests_and_redact_remote_errors() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
            thread,
        };
        fn server(status: &str, body: &str) -> (String, std::thread::JoinHandle<String>) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = format!("http://{}", listener.local_addr().unwrap());
            let response = format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
            let handle = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = Vec::new();
                loop {
                    let mut chunk = [0; 4096];
                    let count = stream.read(&mut chunk).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&chunk[..count]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let length = headers
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap()
                            .trim()
                            .parse::<usize>()
                            .unwrap();
                        if bytes.len() >= end + 4 + length {
                            break;
                        }
                    }
                }
                stream.write_all(response.as_bytes()).unwrap();
                String::from_utf8(bytes).unwrap()
            });
            (address, handle)
        }
        for (provider, body, expected_path) in [
            (
                Provider::Ollama,
                r#"{"message":{"content":"local answer"}}"#,
                "/api/chat",
            ),
            (
                Provider::Openai,
                r#"{"choices":[{"message":{"content":"local answer"}}]}"#,
                "/v1/chat/completions",
            ),
        ] {
            let (address, server) = server("200 OK", body);
            let mut r = request(&address, provider);
            r.messages.push(Message {
                role: Role::User,
                content: "test context".into(),
            });
            r.api_key = Some("test-only-token".into());
            let answer = tauri::async_runtime::block_on(research_ask_ai(r)).unwrap();
            let sent = server.join().unwrap();
            assert_eq!(answer, "local answer");
            assert!(sent.starts_with(&format!("POST {expected_path} HTTP/1.1")));
            assert!(sent.contains("test context"));
            assert!(sent
                .to_lowercase()
                .contains("authorization: bearer test-only-token"));
        }
        let (address, server) = server(
            "401 Unauthorized",
            r#"{"error":"never echo test-only-token"}"#,
        );
        let mut r = request(&address, Provider::Openai);
        r.messages.push(Message {
            role: Role::User,
            content: "test".into(),
        });
        let error = tauri::async_runtime::block_on(research_ask_ai(r)).unwrap_err();
        server.join().unwrap();
        assert!(error.contains("401"));
        assert!(!error.contains("test-only-token"));
    }
}
