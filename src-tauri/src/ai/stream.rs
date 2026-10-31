use super::*;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;
use std::{collections::HashMap, sync::Mutex};
use tauri::{ipc::Channel, Runtime, State, Webview};
use tokio::{io::AsyncBufReadExt, sync::watch};

#[derive(Default)]
pub struct ChatState(Mutex<HashMap<String, (String, watch::Sender<bool>)>>);

impl ChatState {
    pub fn close_owner(&self, label: &str) {
        match self.0.lock() {
            Ok(active) => {
                for (owner, sender) in active.values() {
                    if owner == label {
                        let _ = sender.send(true);
                    }
                }
            }
            Err(error) => eprintln!("Scientify 翻译请求清理失败：{error}"),
        }
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ChatEvent {
    Ready,
    Delta { text: String },
}
#[derive(Serialize)]
pub struct ChatResult {
    text: String,
    interrupted: bool,
}

fn http_error(status: reqwest::StatusCode) -> String {
    match status.as_u16() {
        401 | 403 => "服务拒绝访问（401/403），请检查 API 密钥及模型权限。".into(),
        404 | 405 => "服务不支持所选流式接口，请检查服务地址及协议。".into(),
        429 => "请求受限（429），请稍后重试。".into(),
        code => format!("模型服务返回 HTTP {code}。"),
    }
}

pub(crate) struct StreamError {
    pub message: String,
    pub status: u16,
}
impl From<String> for StreamError {
    fn from(message: String) -> Self {
        Self {
            message,
            status: 400,
        }
    }
}
impl From<&str> for StreamError {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl From<StreamError> for String {
    fn from(error: StreamError) -> Self {
        error.message
    }
}
impl std::fmt::Debug for StreamError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.message.fmt(formatter)
    }
}

pub(super) async fn send(call: RequestBuilder) -> Result<reqwest::Response, StreamError> {
    let response = call.send().await.map_err(|_| StreamError {
        message: "模型连接失败或超时，请检查服务。".into(),
        status: 503,
    })?;
    if !response.status().is_success() {
        return Err(StreamError {
            message: http_error(response.status()),
            status: response.status().as_u16(),
        });
    }
    Ok(response)
}

pub(super) fn bounded_bytes(
    response: reqwest::Response,
    limit: usize,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> {
    let mut received = 0usize;
    response.bytes_stream().map(move |chunk| {
        let chunk = chunk.map_err(std::io::Error::other)?;
        received += chunk.len();
        if received > limit {
            return Err(std::io::Error::other("stream size limit"));
        }
        Ok(chunk)
    })
}

fn delta(value: &Value, provider: Provider) -> Result<(String, bool), String> {
    if !value["error"].is_null() || value["type"] == "error" {
        return Err("模型服务在流式回答中报告错误。".into());
    }
    let result = match provider {
        Provider::Openai => (
            value["choices"][0]["delta"]["content"]
                .as_str()
                .unwrap_or("")
                .into(),
            !value["choices"][0]["finish_reason"].is_null(),
        ),
        Provider::Anthropic => (
            if value["delta"]["type"] == "text_delta" {
                value["delta"]["text"].as_str().unwrap_or("")
            } else {
                ""
            }
            .into(),
            value["type"] == "message_stop",
        ),
        Provider::Gemini => (
            output(value, provider),
            !value["candidates"][0]["finishReason"].is_null(),
        ),
        Provider::Ollama => (
            value["message"]["content"].as_str().unwrap_or("").into(),
            value["done"] == true,
        ),
    };
    Ok(result)
}

pub(crate) async fn complete_stream(
    request: &AIRequest,
    text: &mut String,
    channel: &Channel<ChatEvent>,
) -> Result<(), StreamError> {
    let response = send(completion_call(request, false, true)?).await?;
    let mut size = 0usize;
    let mut consume = |data: &str| -> Result<bool, String> {
        size += data.len();
        if size > 4 * 1024 * 1024 {
            return Err("服务流式响应超过大小限制。".into());
        }
        if data == "[DONE]" {
            return Ok(true);
        }
        let value: Value = serde_json::from_str(data).map_err(|_| "服务返回无效的流式 JSON。")?;
        let (chunk, done) = delta(&value, request.connection.provider)?;
        if text.len() + chunk.len() > 1024 * 1024 {
            return Err("回答超过大小限制。".into());
        }
        if !chunk.is_empty() {
            text.push_str(&chunk);
            channel
                .send(ChatEvent::Delta { text: chunk })
                .map_err(|_| "对话界面已断开。")?;
        }
        Ok(done)
    };
    if matches!(request.connection.provider, Provider::Ollama) {
        let bytes = bounded_bytes(response, 4 * 1024 * 1024);
        let reader = tokio_util::io::StreamReader::new(bytes);
        let mut lines = tokio::io::BufReader::new(reader).lines();
        while let Some(line) = lines
            .next_line()
            .await
            .map_err(|_| "读取模型流失败或超时。")?
        {
            if !line.trim().is_empty() && consume(&line)? {
                return Ok(());
            }
        }
    } else {
        if !response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|h| h.to_str().ok())
            .is_some_and(|v| v.starts_with("text/event-stream"))
        {
            return Err("服务未返回 SSE 流，请检查接口兼容性。".into());
        }
        let mut events = bounded_bytes(response, 4 * 1024 * 1024).eventsource();
        while let Some(event) = events.next().await {
            let event = event.map_err(|_| "读取模型流失败或超时。")?;
            if consume(&event.data)? {
                return Ok(());
            }
        }
    }
    Err("模型流意外结束，已保留部分回答。".into())
}

#[tauri::command]
pub async fn research_chat_stream<R: Runtime>(
    view: Webview<R>,
    state: State<'_, ChatState>,
    request_id: String,
    request: AIRequest,
    channel: Channel<ChatEvent>,
) -> Result<ChatResult, String> {
    crate::library::trusted(&view)?;
    if uuid::Uuid::parse_str(&request_id).is_err() {
        return Err("对话请求标识无效。".into());
    }
    let (sender, mut cancelled) = watch::channel(false);
    {
        let mut active = state.0.lock().map_err(|_| "对话状态不可用。")?;
        if active.contains_key(&request_id) {
            return Err("对话请求正在执行。".into());
        }
        if active.len() >= 16 {
            return Err("并行对话过多，请先结束部分任务。".into());
        }
        active.insert(request_id.clone(), (view.label().to_string(), sender));
    }
    // Removing on every exit also covers an IPC future being dropped.
    struct Release<'a>(&'a ChatState, String);
    impl Drop for Release<'_> {
        fn drop(&mut self) {
            if let Ok(mut active) = self.0 .0.lock() {
                active.remove(&self.1);
            }
        }
    }
    let _release = Release(&state, request_id);
    channel
        .send(ChatEvent::Ready)
        .map_err(|_| "对话界面已断开。")?;
    let mut text = String::new();
    let interrupted = tokio::select! {
        result = complete_stream(&request, &mut text, &channel) => { result?; false }
        _ = cancelled.changed() => true,
    };
    if !interrupted && text.trim().is_empty() {
        return Err("模型没有返回文本。".into());
    }
    Ok(ChatResult { text, interrupted })
}

#[tauri::command]
pub fn research_chat_cancel<R: Runtime>(
    view: Webview<R>,
    state: State<'_, ChatState>,
    request_id: String,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    let active = state.0.lock().map_err(|_| "对话状态不可用。")?;
    if let Some((owner, sender)) = active.get(&request_id) {
        if owner != view.label() {
            return Err("不能中止其他窗口的对话。".into());
        }
        let _ = sender.send(true);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::Manager;

    #[test]
    fn closing_popup_cancels_only_its_own_requests() {
        let state = ChatState::default();
        let (popup, popup_cancelled) = watch::channel(false);
        let (workspace, workspace_cancelled) = watch::channel(false);
        state
            .0
            .lock()
            .unwrap()
            .insert("translation".into(), ("translator".into(), popup));
        state
            .0
            .lock()
            .unwrap()
            .insert("assistant".into(), ("workspace".into(), workspace));
        state.close_owner("translator");
        assert!(*popup_cancelled.borrow());
        assert!(!*workspace_cancelled.borrow());
    }

    #[test]
    fn streams_native_protocols_and_retains_partial_text_on_broken_streams() {
        for (provider, mime, body, expected, succeeds) in [
            (Provider::Openai, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"中文\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"回答\"},\"finish_reason\":\"stop\"}]}\n\n", "中文回答", true),
            (Provider::Anthropic, "text/event-stream", "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"anthropic\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n", "anthropic", true),
            (Provider::Gemini, "text/event-stream", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"hidden\",\"thought\":true},{\"text\":\"gemini\"}]},\"finishReason\":\"STOP\"}]}\n\n", "gemini", true),
            (Provider::Ollama, "application/x-ndjson", "{\"message\":{\"content\":\"ollama\"},\"done\":false}\n{\"done\":true}\n", "ollama", true),
            (Provider::Openai, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", "partial", false),
            (Provider::Openai, "text/event-stream", "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\ndata: {\"error\":{\"message\":\"secret\"}}\n\n", "partial", false),
        ] {
            let (endpoint, server) = super::super::tests::server_mime(vec![("200 OK", mime, body)]);
            let request = AIRequest { max_tokens: None, temperature: None, connection: Connection { endpoint, provider, api_key: Some("test-secret".into()) }, model: "test-model".into(), messages: vec![Message { role: Role::User, content: "test".into() }] };
            let mut text = String::new();
            let result = tauri::async_runtime::block_on(complete_stream(&request, &mut text, &Channel::new(|_| Ok(()))));
            assert_eq!(text, expected);
            assert_eq!(result.is_ok(), succeeds, "{result:?}");
            if let Err(error) = result { assert!(!error.message.contains("secret")); }
            let requests = server.join().unwrap();
            assert!(requests[0].contains("stream\":true") || requests[0].contains(":streamGenerateContent?alt=sse"));
        }
    }

    #[test]
    fn cancellation_interrupts_header_wait_and_is_scoped_to_the_originating_window() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let app = tauri::test::mock_builder()
            .manage(ChatState::default())
            .build(crate::app_context())
            .unwrap();
        let workspace = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
            .build()
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let request_id = uuid::Uuid::new_v4().to_string();
        let id = request_id.clone();
        let request = AIRequest {
            max_tokens: None,
            temperature: None,
            connection: Connection {
                endpoint: format!("http://{}", listener.local_addr().unwrap()),
                provider: Provider::Openai,
                api_key: None,
            },
            model: "test-model".into(),
            messages: vec![Message {
                role: Role::User,
                content: "test".into(),
            }],
        };
        let (ready, received) = std::sync::mpsc::channel();
        let channel = Channel::new(move |_| {
            let _ = ready.send(());
            Ok(())
        });
        let view = workspace.as_ref().clone();
        let handle = app.handle().clone();
        let started = Instant::now();
        let run = tauri::async_runtime::spawn(async move {
            research_chat_stream(view, handle.state::<ChatState>(), id, request, channel).await
        });
        received.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(research_chat_cancel(
            main.as_ref().clone(),
            app.state::<ChatState>(),
            request_id.clone()
        )
        .is_err());
        research_chat_cancel(
            workspace.as_ref().clone(),
            app.state::<ChatState>(),
            request_id,
        )
        .unwrap();
        let result = tauri::async_runtime::block_on(run).unwrap().unwrap();
        assert!(result.interrupted);
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(app.state::<ChatState>().0.lock().unwrap().is_empty());
    }

    #[test]
    fn sse_parser_preserves_utf8_and_multiline_events_across_byte_boundaries() {
        let data = "event: test\ndata: {\"text\":\n data: ignored\ndata: \"中文\"}\n\n";
        let chunks = data
            .as_bytes()
            .iter()
            .map(|b| Ok::<_, std::io::Error>(bytes::Bytes::from(vec![*b])))
            .collect::<Vec<_>>();
        let mut events = futures_util::stream::iter(chunks).eventsource();
        tauri::async_runtime::block_on(async {
            let event = events.next().await.unwrap().unwrap();
            let parsed: Value = serde_json::from_str(&event.data).unwrap();
            assert_eq!(parsed["text"], "中文");
        });
    }
}
