//! Bounded request/reply bridge to the local window that owns the shared chat runtime.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tauri::{Emitter, Manager, Runtime};

#[derive(Default)]
pub struct WindowState {
    conversations: Mutex<HashMap<String, PendingConversation>>,
}
struct PendingConversation {
    owner: String,
    request: Option<ConversationRequest>,
    reply: tokio::sync::oneshot::Sender<Value>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConversationRequest {
    pub id: String,
    pub conversation_id: String,
    pub op: String,
    #[serde(default)]
    pub question: String,
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub translation: String,
    #[serde(default)]
    pub explanation: String,
}
impl ConversationRequest {
    fn validate(&self) -> Result<(), String> {
        if uuid::Uuid::parse_str(&self.id).is_err()
            || uuid::Uuid::parse_str(&self.conversation_id).is_err()
            || !matches!(
                self.op.as_str(),
                "create" | "read" | "send" | "retry" | "cancel" | "open"
            )
            || self.question.len() > 32_000
            || self.source.len() > 100_000
            || self.translation.len() > 256_000
            || self.explanation.len() > 256_000
        {
            return Err("翻译问答请求无效或过长。".into());
        }
        Ok(())
    }
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    TakeConversations,
    ConversationReply { id: String, result: Value },
}
fn host<R: Runtime>(app: &tauri::AppHandle<R>) -> &'static str {
    if app.get_webview_window("workspace").is_some() {
        "workspace"
    } else {
        "main"
    }
}

pub(crate) async fn conversation<R: Runtime>(
    app: &tauri::AppHandle<R>,
    request: ConversationRequest,
) -> Result<Value, String> {
    request.validate()?;
    let owner = host(app);
    if request.op == "open" {
        let window = app
            .get_webview_window(owner)
            .ok_or("Scientify 主窗口不可用。")?;
        window
            .unminimize()
            .and_then(|_| window.show())
            .and_then(|_| window.set_focus())
            .map_err(|e| e.to_string())?;
    }
    let id = request.id.clone();
    let (reply, received) = tokio::sync::oneshot::channel();
    let state = app.state::<WindowState>();
    {
        let mut queue = state.conversations.lock().map_err(|e| e.to_string())?;
        if queue.len() >= 16 || queue.contains_key(&id) {
            return Err("翻译问答请求正在处理中，请稍后重试。".into());
        }
        queue.insert(
            id.clone(),
            PendingConversation {
                owner: owner.into(),
                request: Some(request),
                reply,
            },
        );
    }
    let result = async {
        app.emit_to(
            tauri::EventTarget::webview(owner),
            "translation-conversation-request",
            (),
        )
        .map_err(|e| e.to_string())?;
        tokio::time::timeout(Duration::from_secs(20), received)
            .await
            .map_err(|_| "Scientify 会话响应超时，请重试。".to_owned())?
            .map_err(|_| "Scientify 会话窗口已关闭。".to_owned())
    }
    .await;
    state
        .conversations
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    result
}

#[tauri::command]
pub async fn translation_window<R: Runtime>(
    view: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    action: Action,
) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    if view.label() != host(&app) {
        return Ok(Value::Null);
    }
    let state = app.state::<WindowState>();
    match action {
        Action::TakeConversations => {
            let mut queue = state.conversations.lock().map_err(|e| e.to_string())?;
            let requests: Vec<_> = queue
                .values_mut()
                .filter(|pending| pending.owner == view.label())
                .filter_map(|pending| pending.request.take())
                .collect();
            return serde_json::to_value(requests).map_err(|e| e.to_string());
        }
        Action::ConversationReply { id, result } => {
            let mut queue = state.conversations.lock().map_err(|e| e.to_string())?;
            if queue
                .get(&id)
                .is_some_and(|pending| pending.owner == view.label())
            {
                if let Some(pending) = queue.remove(&id) {
                    let _ = pending.reply.send(result);
                }
            }
            return Ok(Value::Null);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_smoke::invoke;
    use serde_json::json;

    #[test]
    fn conversation_protocol_validates_external_inputs() {
        let mut request: ConversationRequest = serde_json::from_value(json!({
            "id": uuid::Uuid::new_v4(), "conversationId": uuid::Uuid::new_v4(), "op":"read"
        }))
        .unwrap();
        assert!(request.validate().is_ok());
        request.op = "execute".into();
        assert!(request.validate().is_err());
        request.op = "send".into();
        request.question = "a".repeat(32_001);
        assert!(request.validate().is_err());
    }

    #[test]
    fn only_the_owning_local_window_can_take_and_answer_requests() {
        let app = tauri::test::mock_builder()
            .manage(WindowState::default())
            .invoke_handler(tauri::generate_handler![translation_window])
            .build(tauri::generate_context!())
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let workspace = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
            .build()
            .unwrap();
        let remote =
            tauri::WebviewWindowBuilder::new(&app, "browser-untrusted", Default::default())
                .build()
                .unwrap();
        let request: ConversationRequest = serde_json::from_value(json!({
            "id":uuid::Uuid::new_v4(), "conversationId":uuid::Uuid::new_v4(), "op":"read"
        }))
        .unwrap();
        let id = request.id.clone();
        let (reply, mut received) = tokio::sync::oneshot::channel();
        app.state::<WindowState>()
            .conversations
            .lock()
            .unwrap()
            .insert(
                id.clone(),
                PendingConversation {
                    owner: "workspace".into(),
                    request: Some(request),
                    reply,
                },
            );
        let origin = if cfg!(feature = "custom-protocol") {
            if cfg!(windows) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
        } else {
            "http://127.0.0.1:1420"
        };
        let call =
            |view, action| invoke(view, "translation_window", json!({"action":action}), origin);
        assert!(call(&remote, json!({"type":"takeConversations"})).is_err());
        let hidden: Value = call(&main, json!({"type":"takeConversations"}))
            .unwrap()
            .deserialize()
            .unwrap();
        assert!(hidden.is_null());
        call(
            &main,
            json!({"type":"conversationReply","id":id,"result":{"fake":true}}),
        )
        .unwrap();
        assert!(received.try_recv().is_err());
        let items: Value = call(&workspace, json!({"type":"takeConversations"}))
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(items.as_array().unwrap().len(), 1);
        let again: Value = call(&workspace, json!({"type":"takeConversations"}))
            .unwrap()
            .deserialize()
            .unwrap();
        assert!(again.as_array().unwrap().is_empty());
        call(
            &workspace,
            json!({"type":"conversationReply","id":id,"result":{"running":true}}),
        )
        .unwrap();
        assert_eq!(received.try_recv().unwrap(), json!({"running":true}));
        assert!(app
            .state::<WindowState>()
            .conversations
            .lock()
            .unwrap()
            .is_empty());
    }
}
