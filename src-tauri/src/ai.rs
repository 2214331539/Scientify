//! Model discovery, connection verification and chat share the same protocol adapter.
use reqwest::{Client, RequestBuilder, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    time::{Duration, Instant},
};

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Provider {
    Ollama,
    Openai,
    Anthropic,
    Gemini,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    endpoint: String,
    api_key: Option<String>,
    provider: Provider,
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
pub struct AIRequest {
    #[serde(flatten)]
    connection: Connection,
    model: String,
    messages: Vec<Message>,
}
#[derive(Deserialize)]
pub struct ModelTest {
    #[serde(flatten)]
    connection: Connection,
    model: String,
}
#[derive(Serialize, Debug, PartialEq)]
pub struct Model {
    id: String,
    name: String,
}

fn local(url: &Url) -> bool {
    url.host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]" | "::1"))
}
fn base(connection: &Connection) -> Result<Url, String> {
    if connection.endpoint.len() > 4096
        || connection
            .api_key
            .as_ref()
            .is_some_and(|key| key.len() > 4096)
    {
        return Err("模型服务地址或密钥过长。".into());
    }
    let mut url = Url::parse(connection.endpoint.trim()).map_err(|_| "模型服务地址格式无效。")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("模型服务必须使用 HTTP(S)，地址不能包含密码、查询参数或片段。".into());
    }
    if url.scheme() == "http"
        && !local(&url)
        && connection
            .api_key
            .as_ref()
            .is_some_and(|key| !key.is_empty())
    {
        return Err("带 API Key 的远程模型服务必须使用 HTTPS。".into());
    }
    let path = url.path().trim_end_matches('/');
    let path = match connection.provider {
        Provider::Ollama => {
            let path = path
                .strip_suffix("/chat")
                .or_else(|| path.strip_suffix("/tags"))
                .unwrap_or(path);
            if path.ends_with("/api") {
                path.into()
            } else {
                format!("{path}/api")
            }
        }
        Provider::Openai => {
            let path = path
                .strip_suffix("/chat/completions")
                .or_else(|| path.strip_suffix("/models"))
                .unwrap_or(path);
            if path.is_empty() {
                "/v1".into()
            } else {
                path.into()
            }
        }
        Provider::Anthropic => {
            let path = path
                .strip_suffix("/messages")
                .or_else(|| path.strip_suffix("/models"))
                .unwrap_or(path);
            if path.is_empty() {
                "/v1".into()
            } else {
                path.into()
            }
        }
        Provider::Gemini => {
            let path = path.strip_suffix("/models").unwrap_or(path);
            if path.is_empty() {
                "/v1beta".into()
            } else {
                path.into()
            }
        }
    };
    url.set_path(&path);
    Ok(url)
}
fn child(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    url.set_path(&format!("{}/{}", base.path().trim_end_matches('/'), path));
    url
}
fn client(url: &Url) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(90))
        .connect_timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none());
    // Remote APIs use the OS/environment proxy; a local Ollama must remain local.
    if local(url) {
        builder = builder.no_proxy();
    }
    builder.build().map_err(|_| "网络客户端初始化失败。".into())
}
fn authorize(call: RequestBuilder, connection: &Connection) -> RequestBuilder {
    let call = if matches!(connection.provider, Provider::Anthropic) {
        call.header("anthropic-version", "2023-06-01")
    } else {
        call
    };
    match connection
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty())
    {
        Some(key) => match connection.provider {
            Provider::Anthropic => call.header("x-api-key", key),
            Provider::Gemini => call.header("x-goog-api-key", key),
            _ => call.bearer_auth(key),
        },
        None => call,
    }
}
async fn response(call: RequestBuilder, limit: usize) -> Result<Value, String> {
    let mut response = call.send().await.map_err(|e| {
        if e.is_timeout() {
            "模型请求超时，请检查服务或缩小上下文。"
        } else {
            "无法连接模型服务，请检查地址、网络与服务状态。"
        }
    })?;
    if !response.status().is_success() {
        // Remote error bodies/URLs can echo credentials. Never send them to the UI or logs.
        return Err(match response.status().as_u16() {
            401 | 403 => "服务拒绝访问（401/403），请检查 API 密钥、服务区域及模型权限。".into(),
            404 | 405 => {
                "接口不可用（404/405），请检查服务地址及接口协议；服务需要支持模型列表和聊天接口。"
                    .into()
            }
            429 => "请求受限（429），请检查服务额度或稍后重试。".into(),
            status => format!("模型服务返回 HTTP {status}，请检查服务状态。"),
        });
    }
    if response
        .content_length()
        .is_some_and(|size| size > limit as u64)
    {
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
    serde_json::from_slice(&bytes).map_err(|_| "模型服务返回了无法解析的 JSON。".into())
}

fn valid_model(model: &str) -> bool {
    !model.trim().is_empty() && model.len() <= 256 && !model.chars().any(char::is_control)
}
fn text_model(value: &Value, provider: Provider) -> bool {
    if matches!(provider, Provider::Gemini) {
        return value["supportedGenerationMethods"]
            .as_array()
            .is_some_and(|methods| methods.iter().any(|m| m == "generateContent"));
    }
    for path in [
        "/architecture/output_modalities",
        "/output_modalities",
        "/inference_metadata/response_modality",
    ] {
        if let Some(modalities) = value.pointer(path).and_then(Value::as_array) {
            return modalities
                .iter()
                .any(|m| m.as_str().is_some_and(|s| s.eq_ignore_ascii_case("text")));
        }
    }
    // No reliable capability metadata: let the selected model's chat probe decide.
    true
}

#[tauri::command]
pub async fn research_list_models(request: Connection) -> Result<Vec<Model>, String> {
    let root = base(&request)?;
    let http = client(&root)?;
    let dashscope = matches!(request.provider, Provider::Openai)
        && root.path().ends_with("/compatible-mode/v1");
    let mut url = child(
        &root,
        if matches!(request.provider, Provider::Ollama) {
            "tags"
        } else {
            "models"
        },
    );
    if dashscope {
        url.set_path(&format!(
            "{}/api/v1/models",
            root.path().trim_end_matches("/compatible-mode/v1")
        ));
    }
    let started = Instant::now();
    let mut models = BTreeMap::new();
    let mut cursor = String::new();
    for page in 1..=20 {
        let remaining = Duration::from_secs(60)
            .checked_sub(started.elapsed())
            .ok_or("获取模型列表超时，请重试。")?;
        let mut call = http.get(url.clone()).timeout(remaining);
        if dashscope {
            call = call.query(&[
                ("page_no", page.to_string()),
                ("page_size", "100".into()),
                ("capabilities", "TG".into()),
            ]);
        } else {
            call = match request.provider {
                Provider::Gemini => {
                    let call = call.query(&[("pageSize", "1000")]);
                    if cursor.is_empty() {
                        call
                    } else {
                        call.query(&[("pageToken", &cursor)])
                    }
                }
                Provider::Anthropic => {
                    let call = call.query(&[("limit", "1000")]);
                    if cursor.is_empty() {
                        call
                    } else {
                        call.query(&[("after_id", &cursor)])
                    }
                }
                Provider::Openai if !cursor.is_empty() => call.query(&[("after", &cursor)]),
                _ => call,
            };
        }
        let value = response(authorize(call, &request), 4 * 1024 * 1024).await?;
        let entries = if dashscope {
            value.pointer("/output/models")
        } else {
            Some(
                &value[match request.provider {
                    Provider::Ollama | Provider::Gemini => "models",
                    _ => "data",
                }],
            )
        }
        .and_then(Value::as_array)
        .ok_or("服务未返回有效的模型列表，请检查接口协议。")?;
        for entry in entries {
            if !text_model(entry, request.provider) {
                continue;
            }
            let id = match request.provider {
                Provider::Ollama => entry["model"].as_str().or_else(|| entry["name"].as_str()),
                Provider::Gemini => entry["name"]
                    .as_str()
                    .and_then(|s| s.strip_prefix("models/")),
                _ if dashscope => entry["model"].as_str(),
                _ => entry["id"].as_str(),
            };
            if let Some(id) = id.filter(|s| valid_model(s)) {
                let name = entry["displayName"]
                    .as_str()
                    .or_else(|| entry["display_name"].as_str())
                    .or_else(|| entry["name"].as_str())
                    .unwrap_or(id);
                models.insert(id.to_string(), name.chars().take(200).collect::<String>());
            }
        }
        if models.len() > 5000 {
            return Err("模型列表过大，请使用范围更小的服务接口。".into());
        }
        let next = if dashscope {
            if value["output"]["total"].as_u64().unwrap_or(0) > page * 100 {
                if entries.is_empty() {
                    return Err("服务返回了不完整的模型列表，请重试。".into());
                }
                page.to_string()
            } else {
                String::new()
            }
        } else if matches!(request.provider, Provider::Gemini) {
            value["nextPageToken"].as_str().unwrap_or("").into()
        } else if value["has_more"].as_bool().unwrap_or(false) {
            value["last_id"]
                .as_str()
                .or_else(|| entries.last().and_then(|e| e["id"].as_str()))
                .filter(|id| !id.is_empty())
                .ok_or("服务返回了不完整的模型列表，请重试。")?
                .into()
        } else {
            String::new()
        };
        if next.is_empty() {
            if models.is_empty() {
                return Err("服务未返回可选的聊天模型。".into());
            }
            return Ok(models
                .into_iter()
                .map(|(id, name)| Model { id, name })
                .collect());
        }
        if next == cursor || next.len() > 4096 {
            return Err("服务返回了无效的模型分页信息。".into());
        }
        cursor = next;
    }
    Err("模型列表分页过多，请使用范围更小的服务接口。".into())
}

async fn completion(request: &AIRequest, probe: bool) -> Result<Value, String> {
    if !valid_model(&request.model) {
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
    let connection = &request.connection;
    let root = base(connection)?;
    let tokens = if probe { 32 } else { 4096 };
    let system = request
        .messages
        .iter()
        .filter(|m| matches!(m.role, Role::System))
        .map(|m| m.content.as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    let (url, body) = match connection.provider {
        Provider::Ollama => (
            child(&root, "chat"),
            json!({"model":request.model,"messages":request.messages,"stream":false,"options":{"num_predict":tokens}}),
        ),
        Provider::Openai => {
            let mut body =
                json!({"model":request.model,"messages":request.messages,"stream":false});
            let token_key = if root.host_str() == Some("api.openai.com") {
                "max_completion_tokens"
            } else {
                "max_tokens"
            };
            body[token_key] = json!(tokens);
            (child(&root, "chat/completions"), body)
        }
        Provider::Anthropic => {
            let messages = request
                .messages
                .iter()
                .filter(|m| !matches!(m.role, Role::System))
                .collect::<Vec<_>>();
            let mut body = json!({"model":request.model,"messages":messages,"max_tokens":tokens,"stream":false});
            if !system.is_empty() {
                body["system"] = json!(system);
            }
            (child(&root, "messages"), body)
        }
        Provider::Gemini => {
            let mut url = child(&root, "models");
            // Model IDs are path segments, never interpolated query strings or traversal paths.
            url.path_segments_mut()
                .map_err(|_| "模型服务地址格式无效。")?
                .push(&format!("{}:generateContent", request.model));
            let contents = request.messages.iter().filter(|m| !matches!(m.role, Role::System)).map(|m| json!({
                "role":if matches!(m.role, Role::Assistant) {"model"} else {"user"}, "parts":[{"text":m.content}]
            })).collect::<Vec<_>>();
            let mut body =
                json!({"contents":contents,"generationConfig":{"maxOutputTokens":tokens}});
            if !system.is_empty() {
                body["systemInstruction"] = json!({"parts":[{"text":system}]});
            }
            (url, body)
        }
    };
    response(
        authorize(client(&root)?.post(url).json(&body), connection),
        1024 * 1024,
    )
    .await
}
fn output(value: &Value, provider: Provider) -> String {
    match provider {
        Provider::Ollama => value["message"]["content"].as_str().unwrap_or("").into(),
        Provider::Openai => value["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("")
            .into(),
        Provider::Anthropic => value["content"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p["type"] == "text")
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
        Provider::Gemini => value["candidates"][0]["content"]["parts"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter(|p| p["thought"] != true)
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default(),
    }
}
#[tauri::command]
pub async fn research_test_model(request: ModelTest) -> Result<(), String> {
    let request = AIRequest {
        connection: request.connection,
        model: request.model,
        messages: vec![Message {
            role: Role::User,
            content: "Reply OK.".into(),
        }],
    };
    let value = completion(&request, true).await?;
    // A reasoning model may spend the small probe budget before producing final text.
    let valid = !output(&value, request.connection.provider)
        .trim()
        .is_empty()
        || match request.connection.provider {
            Provider::Ollama => value["message"]["role"] == "assistant" && value["done"] == true,
            Provider::Openai => {
                value["choices"][0]["message"]["role"] == "assistant"
                    && value["choices"][0]["finish_reason"] == "length"
            }
            Provider::Anthropic => {
                value["type"] == "message" && value["stop_reason"] == "max_tokens"
            }
            Provider::Gemini => value["candidates"][0]["finishReason"] == "MAX_TOKENS",
        };
    if valid {
        Ok(())
    } else {
        Err("模型没有返回有效的聊天响应，请选择其他模型。".into())
    }
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
    let value = completion(&request, false).await?;
    let text = output(&value, request.connection.provider);
    if text.trim().is_empty() {
        Err("模型没有返回文本回答，请检查模型是否支持对话。".into())
    } else {
        Ok(text)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::{
        io::{Read, Write},
        net::TcpListener,
        thread,
    };

    fn connection(endpoint: &str, provider: Provider) -> Connection {
        Connection {
            endpoint: endpoint.into(),
            provider,
            api_key: Some("test-only-key".into()),
        }
    }
    pub(crate) fn server(
        responses: Vec<(&str, &str)>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = format!("http://{}", listener.local_addr().unwrap());
        let replies = responses.into_iter().map(|(status, body)| format!("HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len())).collect::<Vec<_>>();
        let handle = thread::spawn(move || {
            let mut requests = vec![];
            for reply in replies {
                let deadline = Instant::now() + Duration::from_secs(10);
                let mut stream = loop {
                    match listener.accept() {
                        Ok((stream, _)) => break stream,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            thread::sleep(Duration::from_millis(5))
                        }
                        other => panic!("test server did not receive a request: {other:?}"),
                    }
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut bytes = vec![];
                loop {
                    let mut buf = [0; 4096];
                    let count = stream.read(&mut buf).unwrap();
                    if count == 0 {
                        break;
                    }
                    bytes.extend_from_slice(&buf[..count]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let header = String::from_utf8_lossy(&bytes[..end]).to_lowercase();
                        let len: usize = header
                            .lines()
                            .find_map(|line| line.strip_prefix("content-length:"))
                            .unwrap_or("0")
                            .trim()
                            .parse()
                            .unwrap();
                        if bytes.len() >= end + 4 + len {
                            break;
                        }
                    }
                }
                requests.push(String::from_utf8(bytes).unwrap());
                stream.write_all(reply.as_bytes()).unwrap();
            }
            requests
        });
        (address, handle)
    }
    #[test]
    fn bases_keep_custom_prefixes_and_reject_credentials_in_urls() {
        for (url, provider, expected) in [
            ("http://localhost:11434", Provider::Ollama, "/api"),
            ("https://example.com", Provider::Openai, "/v1"),
            (
                "https://example.com/gateway/v1/chat/completions",
                Provider::Openai,
                "/gateway/v1",
            ),
            (
                "https://example.com/api/paas/v4",
                Provider::Openai,
                "/api/paas/v4",
            ),
            ("https://example.com/api/v1", Provider::Anthropic, "/api/v1"),
            ("https://example.com", Provider::Gemini, "/v1beta"),
        ] {
            assert_eq!(base(&connection(url, provider)).unwrap().path(), expected);
        }
        for bad in [
            "file:///tmp/model",
            "https://secret@example.com",
            "https://example.com?key=secret",
            "http://example.com",
            "https://example.com#x",
        ] {
            assert!(base(&connection(bad, Provider::Openai)).is_err());
        }
    }
    #[test]
    fn model_catalogs_use_the_correct_protocol_and_filter_metadata() {
        for (provider, suffix, catalog, path, auth) in [
            (
                Provider::Ollama,
                "",
                r#"{"models":[{"name":"chat-a"},{"model":"chat-a"}]}"#,
                "/api/tags",
                "authorization: bearer test-only-key",
            ),
            (
                Provider::Openai,
                "/gateway/v4",
                r#"{"data":[{"id":"chat-a"},{"id":"image","architecture":{"output_modalities":["image"]}}]}"#,
                "/gateway/v4/models",
                "authorization: bearer test-only-key",
            ),
            (
                Provider::Anthropic,
                "",
                r#"{"data":[{"id":"chat-a","display_name":"Chat A"}],"has_more":false}"#,
                "/v1/models?limit=1000",
                "x-api-key: test-only-key",
            ),
            (
                Provider::Gemini,
                "",
                r#"{"models":[{"name":"models/chat-a","displayName":"Chat A","supportedGenerationMethods":["generateContent"]},{"name":"models/embedding","supportedGenerationMethods":["embedContent"]}]}"#,
                "/v1beta/models?pageSize=1000",
                "x-goog-api-key: test-only-key",
            ),
            (
                Provider::Openai,
                "/compatible-mode/v1",
                r#"{"output":{"total":1,"models":[{"model":"chat-a","name":"Chat A"}]}}"#,
                "/api/v1/models?page_no=1&page_size=100&capabilities=TG",
                "authorization: bearer test-only-key",
            ),
        ] {
            let (url, server) = server(vec![("200 OK", catalog)]);
            let models = tauri::async_runtime::block_on(research_list_models(connection(
                &(url + suffix),
                provider,
            )))
            .unwrap();
            let sent = server.join().unwrap();
            assert_eq!(models.len(), 1);
            assert_eq!(models[0].id, "chat-a");
            assert!(
                sent[0].starts_with(&format!("GET {path} HTTP/1.1")),
                "{}",
                sent[0]
            );
            assert!(sent[0].to_lowercase().contains(auth));
            assert!(!sent[0].lines().next().unwrap().contains("test-only-key"));
        }
    }
    #[test]
    fn paginated_catalogs_keep_all_models_and_reject_broken_pages() {
        for (provider, first, second, cursor) in [
            (
                Provider::Anthropic,
                r#"{"data":[{"id":"a"}],"has_more":true,"last_id":"a"}"#,
                r#"{"data":[{"id":"b"}],"has_more":false}"#,
                "after_id=a",
            ),
            (
                Provider::Gemini,
                r#"{"models":[{"name":"models/a","supportedGenerationMethods":["generateContent"]}],"nextPageToken":"next"}"#,
                r#"{"models":[{"name":"models/b","supportedGenerationMethods":["generateContent"]}]}"#,
                "pageToken=next",
            ),
        ] {
            let (url, server) = server(vec![("200 OK", first), ("200 OK", second)]);
            let models =
                tauri::async_runtime::block_on(research_list_models(connection(&url, provider)))
                    .unwrap();
            assert_eq!(models.len(), 2);
            assert!(server.join().unwrap()[1].contains(cursor));
        }
        let (url, server) = server(vec![("200 OK", r#"{"data":[],"has_more":true}"#)]);
        assert!(
            tauri::async_runtime::block_on(research_list_models(connection(
                &url,
                Provider::Anthropic
            )))
            .is_err()
        );
        server.join().unwrap();
    }
    #[test]
    fn probes_and_chat_share_adapters_without_sending_research_to_the_probe() {
        for (provider, answer, path, auth) in [
            (
                Provider::Ollama,
                r#"{"message":{"content":"answer"}}"#,
                "/api/chat",
                "authorization: bearer test-only-key",
            ),
            (
                Provider::Openai,
                r#"{"choices":[{"message":{"content":"answer"}}]}"#,
                "/v1/chat/completions",
                "authorization: bearer test-only-key",
            ),
            (
                Provider::Anthropic,
                r#"{"content":[{"type":"text","text":"answer"}]}"#,
                "/v1/messages",
                "x-api-key: test-only-key",
            ),
            (
                Provider::Gemini,
                r#"{"candidates":[{"content":{"parts":[{"thought":true,"text":"private"},{"text":"answer"}]}}]}"#,
                "/v1beta/models/chat-a:generateContent",
                "x-goog-api-key: test-only-key",
            ),
        ] {
            let (url, server) = server(vec![("200 OK", answer), ("200 OK", answer)]);
            tauri::async_runtime::block_on(research_test_model(ModelTest {
                connection: connection(&url, provider),
                model: "chat-a".into(),
            }))
            .unwrap();
            let request = AIRequest {
                connection: connection(&url, provider),
                model: "chat-a".into(),
                messages: vec![
                    Message {
                        role: Role::System,
                        content: "system-instruction".into(),
                    },
                    Message {
                        role: Role::User,
                        content: "research material".into(),
                    },
                ],
            };
            let result = tauri::async_runtime::block_on(completion(&request, false)).unwrap();
            assert_eq!(output(&result, provider), "answer");
            let sent = server.join().unwrap();
            assert!(sent[0].starts_with(&format!("POST {path} HTTP/1.1")));
            assert!(sent[0].to_lowercase().contains(auth));
            assert!(sent[0].contains("Reply OK."));
            assert!(!sent[0].contains("research material"));
            assert!(sent[1].contains("research material"));
            let body: Value =
                serde_json::from_str(sent[1].split("\r\n\r\n").nth(1).unwrap()).unwrap();
            if matches!(provider, Provider::Anthropic) {
                assert_eq!(body["system"], "system-instruction");
                assert_eq!(body["messages"].as_array().unwrap().len(), 1);
            }
            if matches!(provider, Provider::Gemini) {
                assert_eq!(
                    body["systemInstruction"]["parts"][0]["text"],
                    "system-instruction"
                );
            }
        }
    }
    #[test]
    fn public_catalog_or_http_success_does_not_prove_chat_access() {
        for (status, body, expected) in [
            ("401 Unauthorized", r#"{"error":"test-only-key"}"#, "401"),
            ("200 OK", r#"{"data":[{"id":"a"}]}"#, "有效的聊天响应"),
        ] {
            let (url, server) = server(vec![(status, body)]);
            let error = tauri::async_runtime::block_on(research_test_model(ModelTest {
                connection: connection(&url, Provider::Openai),
                model: "a".into(),
            }))
            .unwrap_err();
            server.join().unwrap();
            assert!(error.contains(expected));
            assert!(!error.contains("test-only-key"));
        }
    }
    #[test]
    fn ipc_flattening_preserves_provider_and_credentials() {
        let request: AIRequest = serde_json::from_value(json!({"endpoint":"https://example.com/v1","provider":"anthropic","apiKey":"test-only-key","model":"a","messages":[{"role":"user","content":"hello"}]})).unwrap();
        assert!(matches!(request.connection.provider, Provider::Anthropic));
        assert_eq!(request.connection.api_key.as_deref(), Some("test-only-key"));
    }
}
