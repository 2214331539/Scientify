//! Yita owns capture and presentation; Scientify owns model access and application lifetime.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{
    ipc::{Channel, InvokeResponseBody},
    Emitter, Manager,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
    task::JoinSet,
};

type Replies = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;
struct Connection {
    sender: mpsc::UnboundedSender<Value>,
    replies: Replies,
}
#[derive(Default)]
pub struct YitaState {
    connection: Mutex<Option<Connection>>,
    starting: tokio::sync::Mutex<()>,
}

fn executable<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, String> {
    let name = if cfg!(windows) {
        "Yita.Desktop.exe"
    } else {
        "Yita.Desktop"
    };
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("yita")
        .join(name);
    if bundled.is_file() {
        return Ok(bundled);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("release-resources/yita")
        .join(name);
    if development.is_file() {
        return Ok(development);
    }
    Err("翻译组件未打包，请运行 pnpm prepare:translation 后重新构建。".into())
}

fn model_identity(model: &Value) -> String {
    format!(
        "scientify-{:x}",
        Sha256::digest(
            json!([model["provider"], model["endpoint"], model["model"]])
                .to_string()
                .as_bytes()
        )
    )
}

fn configuration<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Value, String> {
    let data = app
        .state::<crate::AppState>()
        .storage
        .load()?
        .unwrap_or_default();
    // Include provider/endpoint in Yita's in-memory cache identity, without transferring any secret.
    let model = model_identity(&data["settings"]["model"]);
    Ok(
        json!({"type":"configure", "model":model, "legacy":data["settings"]["translation"].as_object().cloned().unwrap_or_default(), "language":"zh-CN"}),
    )
}

async fn ensure_started<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<(), String> {
    let state = app.state::<YitaState>();
    let _starting = state.starting.lock().await;
    if state
        .connection
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .is_some_and(|c| !c.sender.is_closed())
    {
        return Ok(());
    }
    let directory = app
        .state::<crate::AppState>()
        .storage
        .directory()
        .parent()
        .ok_or("数据目录无效")?
        .join("translation");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut command = tokio::process::Command::new(executable(app)?);
    command
        .env(
            "SCIENTIFY_TRANSLATION_DATA",
            crate::local_process::process_path(&directory),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("翻译组件启动失败：{e}"))?;
    let mut input = child.stdin.take().ok_or("翻译输入管道不可用")?;
    let output = child.stdout.take().ok_or("翻译输出管道不可用")?;
    let (sender, mut outgoing) = mpsc::unbounded_channel::<Value>();
    let replies: Replies = Arc::default();
    let pending = replies.clone();
    let host = app.clone();
    let responses = sender.clone();
    *state.connection.lock().map_err(|e| e.to_string())? = Some(Connection { sender, replies });
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(output).lines();
        let mut tasks = JoinSet::new();
        let mut cancellations = HashMap::new();
        let result: Result<(), String> = async {
            loop {
                tokio::select! {
                    message = outgoing.recv() => {
                        let Some(message) = message else { break; };
                        if message["type"] == "shutdown" { break; }
                        let mut bytes = serde_json::to_vec(&message).map_err(|e| e.to_string())?;
                        bytes.push(b'\n');
                        input.write_all(&bytes).await.map_err(|e| e.to_string())?;
                    }
                    line = lines.next_line() => {
                        let Some(line) = line.map_err(|e| e.to_string())? else { return Err("翻译组件已退出。".into()); };
                        if line.len() > 2 * 1024 * 1024 { return Err("翻译组件消息过大。".into()); }
                        let message: Value = serde_json::from_str(&line).map_err(|_| "翻译组件协议错误。")?;
                        let id = message["id"].as_str().ok_or("翻译组件消息缺少标识。")?.to_owned();
                        match message["type"].as_str() {
                            Some("conversation") => {
                                if tasks.len() >= 32 {
                                    let _ = responses.send(json!({"type":"conversationResult", "id":id, "error":"并行请求过多，请稍后重试。"}));
                                    continue;
                                }
                                let request = serde_json::from_value::<crate::translation_window::ConversationRequest>(message["request"].clone());
                                let app = host.clone();
                                let output = responses.clone();
                                tasks.spawn(async move {
                                    let result = match request {
                                        Ok(request) => crate::translation_window::conversation(&app, request).await,
                                        Err(error) => Err(format!("翻译问答协议错误：{error}")),
                                    };
                                    let reply = match result {
                                        Ok(result) => json!({"type":"conversationResult","id":id,"result":result}),
                                        Err(error) => json!({"type":"conversationResult","id":id,"error":error}),
                                    };
                                    let _ = output.send(reply);
                                    id
                                });
                            }
                            Some("reply") => {
                                crate::tray::update(&host, &message["result"]);
                                if let Some(reply) = pending.lock().map_err(|e| e.to_string())?.remove(&id) {
                                    let result = if let Some(error) = message["error"].as_str() { Err(error.to_string()) } else { Ok(message["result"].clone()) };
                                    let _ = reply.send(result);
                                }
                            }
                            Some("status") => { crate::tray::update(&host, &message["result"]); }
                            Some("completion") => {
                                if cancellations.contains_key(&id) { return Err("翻译请求标识重复。".into()); }
                                if cancellations.len() >= 16 {
                                    let _ = responses.send(json!({"type":"error", "id":id, "error":"并行翻译请求过多。"}));
                                    continue;
                                }
                                let request = model_request(&host, &message["body"]);
                                let output = responses.clone();
                                let request_id = id.clone();
                                let handle = tasks.spawn(async move {
                                    let result = match request { Ok(request) => complete(request, &request_id, &output).await, Err(error) => Err(error.into()) };
                                    let message = match result { Ok(()) => json!({"type":"complete", "id":request_id}), Err(error) => json!({"type":"error", "id":request_id, "error":error.message, "status":error.status}) };
                                    let _ = output.send(message);
                                    request_id
                                });
                                cancellations.insert(id, handle);
                            }
                            Some("cancel") => { if let Some(handle) = cancellations.remove(&id) { handle.abort(); } }
                            _ => return Err("翻译组件返回未知消息。".into()),
                        }
                    }
                    completed = tasks.join_next(), if !tasks.is_empty() => {
                        if let Some(Ok(id)) = completed { cancellations.remove(&id); }
                    }
                }
            }
            Ok(())
        }.await;
        tasks.abort_all();
        drop(input); // EOF also shuts down Yita's hooks and its native helper on parent exit.
        outgoing.close();
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
        let error = result.err().unwrap_or_else(|| "翻译组件已关闭。".into());
        if let Ok(mut pending) = pending.lock() {
            for (_, reply) in pending.drain() {
                let _ = reply.send(Err(error.clone()));
            }
        }
        let _ = host.emit("translation-service-stopped", error);
    });
    send(app, configuration(app)?).await?;
    Ok(())
}

fn model_request<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    body: &Value,
) -> Result<crate::ai::AIRequest, String> {
    let state = app.state::<crate::AppState>();
    let data = state.storage.load()?.ok_or("请先配置 AI 模型。")?;
    let model = &data["settings"]["model"];
    if body["model"] != model_identity(model) {
        return Err("模型配置已更新，请重新翻译。".into());
    }
    let provider = model["provider"].as_str().unwrap_or("ollama");
    let endpoint = model["endpoint"].as_str().ok_or("请先配置 AI 服务地址。")?;
    let key = crate::credentials::load_for_model(state.storage.directory(), provider, endpoint)?;
    serde_json::from_value(json!({"provider":provider,"endpoint":endpoint,"apiKey":key,"model":model["model"],"messages":body["messages"],"max_tokens":body["max_tokens"],"temperature":body["temperature"]}))
        .map_err(|_| "翻译请求格式错误。".into())
}

async fn complete(
    request: crate::ai::AIRequest,
    id: &str,
    output: &mpsc::UnboundedSender<Value>,
) -> Result<(), crate::ai::stream::StreamError> {
    let request_id = id.to_owned();
    let sender = output.clone();
    let channel = Channel::new(move |response| {
        if let InvokeResponseBody::Json(raw) = response {
            let value: Value = serde_json::from_str(&raw)
                .map_err(|e| tauri::Error::Io(std::io::Error::other(e)))?;
            if value["type"] == "delta" {
                sender
                    .send(json!({"type":"delta","id":request_id,"text":value["text"]}))
                    .map_err(|_| {
                        tauri::Error::Io(std::io::Error::other("Translation pipe closed"))
                    })?;
            }
        }
        Ok(())
    });
    let mut text = String::new();
    crate::ai::stream::complete_stream(&request, &mut text, &channel).await?;
    if text.trim().is_empty() {
        return Err("模型未返回文本。".into());
    }
    Ok(())
}

async fn send<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: Value,
) -> Result<Value, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let (reply, received) = oneshot::channel();
    let pending = {
        let state = app.state::<YitaState>();
        let connection = state.connection.lock().map_err(|e| e.to_string())?;
        let connection = connection.as_ref().ok_or("翻译组件未启动。")?;
        connection
            .replies
            .lock()
            .map_err(|e| e.to_string())?
            .insert(id.clone(), reply);
        connection
            .sender
            .send(json!({"type":"command","id":id,"action":action}))
            .map_err(|_| "翻译组件已断开。")?;
        connection.replies.clone()
    };
    let result = tokio::time::timeout(Duration::from_secs(20), received).await;
    pending.lock().map_err(|e| e.to_string())?.remove(&id);
    result
        .map_err(|_| "翻译组件响应超时。")?
        .map_err(|_| "翻译组件已断开。")?
}

pub async fn command<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    action: Value,
) -> Result<Value, String> {
    ensure_started(app).await?;
    send(app, action).await
}

pub fn stop<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Ok(mut connection) = app.state::<YitaState>().connection.lock() {
        if let Some(connection) = connection.take() {
            let _ = connection.sender.send(json!({"type":"shutdown"}));
        }
    }
}

pub fn refresh<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    // Storage-only test hosts do not install the desktop translation component.
    if app.try_state::<YitaState>().is_none() {
        return;
    }
    let host = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async { command(&host, configuration(&host)?).await }.await;
        if let Err(error) = result {
            let _ = host.emit("translation-service-stopped", error);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    #[test]
    fn hosted_requests_use_saved_model_and_stream_only_their_own_deltas() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let temp = tempfile::tempdir().unwrap();
        let storage =
            Arc::new(scientify_core::storage::Storage::open(temp.path().join("data")).unwrap());
        let mut data = scientify_core::workspace::empty();
        data["revision"] = json!(1);
        data["settings"]["model"] =
            json!({"provider":"openai","endpoint":endpoint,"model":"saved-model"});
        storage.save(data.clone(), 0).unwrap();
        let app = tauri::test::mock_builder()
            .manage(crate::AppState {
                files: Arc::new(scientify_core::research::ResearchFiles::new(
                    storage.directory().into(),
                )),
                storage,
                legacy: temp.path().join("legacy"),
            })
            .build(crate::app_context())
            .unwrap();
        let model = configuration(app.handle()).unwrap()["model"].clone();
        assert!(!model.as_str().unwrap().contains(&endpoint));
        let request = model_request(app.handle(), &json!({
            "model":model, "endpoint":"https://untrusted.invalid", "apiKey":"ignored-child-input",
            "messages":[{"role":"user","content":"fixture"}], "max_tokens":768,"temperature":0.4,
        })).unwrap();
        assert!(model_request(app.handle(), &json!({"model":"stale-model"})).is_err());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut bytes = Vec::new();
            let mut chunk = [0u8; 4096];
            loop {
                let length = socket.read(&mut chunk).unwrap();
                assert_ne!(length, 0);
                bytes.extend_from_slice(&chunk[..length]);
                let raw = String::from_utf8_lossy(&bytes);
                if let Some((headers, body)) = raw.split_once("\r\n\r\n") {
                    let size: usize = headers
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .and_then(|v| v.parse().ok())
                        })
                        .unwrap();
                    if body.len() >= size {
                        let body: Value = serde_json::from_str(&body[..size]).unwrap();
                        assert_eq!(body["model"], "saved-model");
                        assert_eq!(body["max_tokens"], 768);
                        assert_eq!(body["temperature"], 0.4);
                        assert!(!raw.contains("ignored-child-input"));
                        break;
                    }
                }
            }
            let body = "data: {\"choices\":[{\"delta\":{\"content\":\"fixture translation\"}}]}\n\ndata: [DONE]\n\n";
            write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\n\r\n{body}", body.len()).unwrap();
        });
        let (sender, mut receiver) = mpsc::unbounded_channel();
        tauri::async_runtime::block_on(complete(request, "translation-only", &sender)).unwrap();
        let delta = receiver.try_recv().unwrap();
        assert_eq!(delta["id"], "translation-only");
        assert_eq!(delta["text"], "fixture translation");
        server.join().unwrap();
    }
}

#[tauri::command]
pub async fn translation_service<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    action: Value,
) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    if !matches!(
        action["type"].as_str(),
        Some("status" | "settings" | "enabled" | "translate" | "clipboard" | "appearance")
    ) {
        return Err("未知翻译操作。".into());
    }
    command(&app, action).await
}
