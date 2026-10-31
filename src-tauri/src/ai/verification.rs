use super::*;
use eventsource_stream::Eventsource;
use futures_util::StreamExt;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelVerification {
    chat: bool,
    agent: bool,
    chat_error: Option<String>,
    agent_error: Option<String>,
}

async fn response_output(connection: &Connection, body: Value) -> Result<Value, String> {
    let root = responses_base(
        &connection.endpoint,
        if matches!(connection.provider, Provider::Ollama) {
            "ollama"
        } else {
            "openai"
        },
        connection.api_key.as_deref(),
    )?;
    let response = authorize(
        client(&root)?.post(child(&root, "responses")).json(&body),
        connection,
    )
    .send()
    .await
    .map_err(|_| "模型连接失败或超时，请检查服务。")?;
    if !response.status().is_success() {
        let status = response.status().as_u16();
        let mut bytes = Vec::new();
        let mut chunks = stream::bounded_bytes(response, 8192);
        while let Some(chunk) = chunks.next().await {
            match chunk {
                Ok(chunk) => bytes.extend_from_slice(&chunk),
                Err(_) => break,
            }
        }
        let payload: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
        let detail = payload["error"]["message"].as_str().unwrap_or("");
        let detail = if let Some(key) = connection.api_key.as_deref().filter(|s| !s.is_empty()) {
            detail.replace(key, "[redacted]")
        } else {
            detail.to_string()
        };
        let detail: String = detail
            .chars()
            .filter(|c| !c.is_control())
            .take(500)
            .collect();
        return Err(if detail.is_empty() {
            format!("模型服务返回 HTTP {status}。")
        } else {
            format!("模型服务返回 HTTP {status}：{detail}")
        });
    }
    if !response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|h| h.to_str().ok())
        .is_some_and(|v| v.starts_with("text/event-stream"))
    {
        return Err("Responses 接口未返回 SSE 流。".into());
    }
    let mut events = stream::bounded_bytes(response, 1024 * 1024).eventsource();
    let mut size = 0usize;
    while let Some(event) = events.next().await {
        let event = event.map_err(|_| "Responses 流读取失败。")?;
        size += event.data.len();
        if size > 1024 * 1024 {
            return Err("Responses 测试响应过大。".into());
        }
        if event.data == "[DONE]" {
            break;
        }
        let value: Value =
            serde_json::from_str(&event.data).map_err(|_| "Responses 流格式无效。")?;
        match value["type"].as_str() {
            Some("response.completed") if value["response"]["status"] == "completed" => {
                return Ok(value["response"]["output"].clone())
            }
            Some("error" | "response.failed" | "response.incomplete") => {
                return Err("Responses 测试未完成，请检查模型和工具兼容性。".into())
            }
            _ => {}
        }
    }
    Err("Responses 接口缺少完成事件。".into())
}

async fn agent_probe(request: &ModelTest) -> Result<(), String> {
    if !matches!(
        request.connection.provider,
        Provider::Openai | Provider::Ollama
    ) {
        return Err("此原始协议尚未接入内置 Agent；可配置服务的 OpenAI Responses 接口。".into());
    }
    if !valid_model(&request.model) {
        return Err("请配置有效的模型名称。".into());
    }
    let nonce = uuid::Uuid::new_v4().to_string();
    let initial = json!({"role":"user","content":format!("Call scientify_connection_test with nonce {nonce}. After the tool result, reply with its acknowledgement exactly.")});
    let tools = json!([{"type":"function","name":"scientify_connection_test","description":"Harmless connection test, no filesystem access.","parameters":{"type":"object","properties":{"nonce":{"type":"string"}},"required":["nonce"],"additionalProperties":false},"strict":true}]);
    let output = response_output(&request.connection, json!({"model":request.model,"input":[initial.clone()],"tools":tools,"tool_choice":"auto","stream":true,"store":false})).await?;
    let items = output.as_array().ok_or("Responses 缺少工具输出。")?;
    let calls = items
        .iter()
        .filter(|v| v["type"] == "function_call")
        .collect::<Vec<_>>();
    if calls.len() != 1 || calls[0]["name"] != "scientify_connection_test" {
        return Err("模型未返回预期的测试函数调用。".into());
    }
    let call = calls[0];
    let arguments: Value =
        serde_json::from_str(call["arguments"].as_str().ok_or("工具参数缺失。")?)
            .map_err(|_| "工具参数无效。")?;
    if arguments["nonce"] != nonce {
        return Err("工具参数未通过往返校验。".into());
    }
    let call_id = call["call_id"]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or("工具调用标识缺失。")?;
    let acknowledgement = format!("scientify-ok-{nonce}");
    let mut input = vec![initial];
    input.extend(items.iter().cloned());
    input.push(json!({"type":"function_call_output","call_id":call_id,"output":acknowledgement}));
    let result = response_output(&request.connection, json!({"model":request.model,"input":input,"tools":tools,"tool_choice":"none","stream":true,"store":false})).await?;
    let text = result
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["type"] == "message")
        .flat_map(|v| v["content"].as_array().into_iter().flatten())
        .filter(|v| v["type"] == "output_text")
        .filter_map(|v| v["text"].as_str())
        .collect::<String>();
    if !text.contains(&acknowledgement) {
        return Err("工具结果回传后未得到有效回答。".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn research_verify_model<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    request: ModelTest,
) -> Result<ModelVerification, String> {
    crate::library::trusted(&view)?;
    base(&request.connection)?;
    if !valid_model(&request.model) {
        return Err("请配置有效的模型名称。".into());
    }
    let chat_request = ModelTest {
        connection: request.connection.clone(),
        model: request.model.clone(),
    };
    let (chat, agent) = tokio::join!(research_test_model(chat_request), agent_probe(&request));
    Ok(ModelVerification {
        chat: chat.is_ok(),
        agent: agent.is_ok(),
        chat_error: chat.err(),
        agent_error: agent.err(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(agent_available: bool) -> (String, std::thread::JoinHandle<Vec<String>>) {
        super::super::tests::server_factory(if agent_available { 3 } else { 2 }, move |_, raw| {
            let body: Value = serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap();
            let (status, mime, response) = if raw.starts_with("POST /v1/chat/completions ") {
                (
                    "200 OK",
                    "application/json",
                    json!({"choices":[{"message":{"role":"assistant","content":"OK"}}]})
                        .to_string(),
                )
            } else if !agent_available {
                (
                    "404 Not Found",
                    "application/json",
                    "{\"error\":\"private-key-must-not-leak\"}".into(),
                )
            } else {
                assert!(raw.starts_with("POST /v1/responses "));
                assert_eq!(body["stream"], true);
                assert_eq!(body["store"], false);
                let output = if body["tool_choice"] == "none" {
                    let inputs = body["input"].as_array().unwrap();
                    let call = inputs
                        .iter()
                        .find(|v| v["type"] == "function_call")
                        .unwrap();
                    let result = inputs
                        .iter()
                        .find(|v| v["type"] == "function_call_output")
                        .unwrap();
                    assert_eq!(call["call_id"], result["call_id"]);
                    json!([{"type":"message","content":[{"type":"output_text","text":result["output"]}]}])
                } else {
                    let prompt = body["input"][0]["content"].as_str().unwrap();
                    let nonce = prompt
                        .split_whitespace()
                        .find_map(|word| uuid::Uuid::parse_str(word.trim_end_matches('.')).ok())
                        .unwrap()
                        .to_string();
                    assert_eq!(
                        body["tool_choice"], "auto",
                        "Thinking providers reject forced tool choice"
                    );
                    json!([{"type":"function_call","call_id":"fixture-call","name":"scientify_connection_test","arguments":json!({"nonce":nonce}).to_string()}])
                };
                let event = json!({"type":"response.completed","response":{"status":"completed","output":output}});
                (
                    "200 OK",
                    "text/event-stream",
                    format!("event: response.completed\ndata: {event}\n\n"),
                )
            };
            format!("HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}", response.len())
        })
    }

    #[test]
    fn verifies_a_real_streaming_tool_round_trip_and_distinguishes_chat_only_services() {
        for agent_available in [true, false] {
            let (endpoint, server) = fixture(agent_available);
            let app = tauri::test::mock_builder()
                .build(crate::app_context())
                .unwrap();
            let window = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
                .build()
                .unwrap();
            let result = tauri::async_runtime::block_on(research_verify_model(
                window.as_ref().clone(),
                ModelTest {
                    connection: Connection {
                        endpoint,
                        provider: Provider::Openai,
                        api_key: Some("fixture-key".into()),
                    },
                    model: "test-model".into(),
                },
            ))
            .unwrap();
            assert!(result.chat);
            assert_eq!(result.agent, agent_available);
            assert!(!serde_json::to_string(&result)
                .unwrap()
                .contains("private-key"));
            let requests = server.join().unwrap();
            assert!(requests
                .iter()
                .all(|request| !request.contains("research-material")));
        }
    }

    #[test]
    fn exposes_parameter_errors_without_leaking_credentials() {
        let (endpoint, server) = super::super::tests::server_mime(vec![(
            "400 Bad Request",
            "application/json",
            r#"{"error":{"message":"Thinking mode does not support this tool_choice private-key"}}"#,
        )]);
        let request = ModelTest {
            connection: Connection {
                endpoint,
                provider: Provider::Openai,
                api_key: Some("private-key".into()),
            },
            model: "fixture".into(),
        };
        let error = tauri::async_runtime::block_on(agent_probe(&request)).unwrap_err();
        assert!(error.contains("Thinking mode does not support this tool_choice"));
        assert!(error.contains("400"));
        assert!(!error.contains("private-key"));
        server.join().unwrap();
    }

    #[test]
    fn rejects_json_only_responses_and_incomplete_tool_streams() {
        for (mime, body) in [
            ("application/json", "{\"output\":[]}"),
            (
                "text/event-stream",
                "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"OK\"}]}]}}\n\n",
            ),
            (
                "text/event-stream",
                "data: {\"type\":\"response.incomplete\"}\n\n",
            ),
            (
                "text/event-stream",
                "data: {\"type\":\"response.created\"}\n\n",
            ),
        ] {
            let (endpoint, server) = super::super::tests::server_mime(vec![("200 OK", mime, body)]);
            let request = ModelTest {
                connection: Connection {
                    endpoint,
                    provider: Provider::Openai,
                    api_key: None,
                },
                model: "test-model".into(),
            };
            assert!(tauri::async_runtime::block_on(agent_probe(&request)).is_err());
            server.join().unwrap();
        }
    }
}
