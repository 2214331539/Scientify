//! Translation handoff is queued until the active Scientify window acknowledges receipt.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use tauri::{Emitter, Manager, Runtime};

#[derive(Clone, Serialize)]
struct Handoff {
    id: String,
    source: String,
    translation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    question: Option<String>,
}
#[derive(Default)]
pub struct WindowState {
    handoff: Mutex<Option<Handoff>>,
}
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Action {
    TakeHandoff,
    AckHandoff { id: String },
}
fn host<R: Runtime>(app: &tauri::AppHandle<R>) -> &'static str {
    if app.get_webview_window("workspace").is_some() {
        "workspace"
    } else {
        "main"
    }
}

pub(crate) fn send_to_assistant<R: Runtime>(
    app: &tauri::AppHandle<R>,
    source: String,
    translation: String,
    question: Option<String>,
) -> Result<(), String> {
    let state = app.state::<WindowState>();
    if source.chars().count() > 20000
        || translation.len() > 1024 * 1024
        || translation.trim().is_empty()
        || question
            .as_ref()
            .is_some_and(|question| question.chars().count() > 64000)
    {
        return Err("发送到 AI 的翻译内容无效或过长。".into());
    }
    let target = host(app);
    let window = app
        .get_webview_window(target)
        .ok_or("请先打开 Scientify 主窗口。")?;
    // Do not queue a duplicate if the main UI is still booting or has reported an error.
    {
        let mut pending = state.handoff.lock().map_err(|e| e.to_string())?;
        if let Some(existing) = pending.as_ref() {
            if existing.source != source
                || existing.translation != translation
                || existing.question != question
            {
                return Err("上一条翻译正在交给 AI 助手，请稍后重试。".into());
            }
        } else {
            *pending = Some(Handoff {
                id: uuid::Uuid::new_v4().to_string(),
                source,
                translation,
                question,
            });
        }
    }
    window
        .unminimize()
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|e| e.to_string())?;
    app.emit_to(
        tauri::EventTarget::webview(target),
        "translation-assistant-handoff",
        (),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
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
    let mut pending = state.handoff.lock().map_err(|e| e.to_string())?;
    match action {
        Action::TakeHandoff => return serde_json::to_value(&*pending).map_err(|e| e.to_string()),
        Action::AckHandoff { id } => {
            if pending.as_ref().is_some_and(|handoff| handoff.id == id) {
                *pending = None;
            }
        }
    }
    Ok(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_smoke::invoke;
    use serde_json::json;

    #[test]
    fn handoff_preserves_drafts_and_requires_active_host_acknowledgement() {
        let app = tauri::test::mock_builder()
            .manage(WindowState::default())
            .invoke_handler(tauri::generate_handler![translation_window])
            .build(tauri::generate_context!())
            .unwrap();
        let main = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let remote =
            tauri::WebviewWindowBuilder::new(&app, "browser-untrusted", Default::default())
                .build()
                .unwrap();
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
        send_to_assistant(
            app.handle(),
            "paper".into(),
            "translation".into(),
            Some("unsent question".into()),
        )
        .unwrap();
        assert!(send_to_assistant(app.handle(), "different".into(), "new".into(), None).is_err());
        assert!(call(&remote, json!({"type":"takeHandoff"})).is_err());
        let item: Value = call(&main, json!({"type":"takeHandoff"}))
            .unwrap()
            .deserialize()
            .unwrap();
        assert_eq!(item["question"], "unsent question");
        call(&main, json!({"type":"ackHandoff","id":"wrong"})).unwrap();
        assert!(app.state::<WindowState>().handoff.lock().unwrap().is_some());
        let workspace = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
            .build()
            .unwrap();
        let hidden: Value = call(&main, json!({"type":"takeHandoff"}))
            .unwrap()
            .deserialize()
            .unwrap();
        assert!(hidden.is_null());
        call(&workspace, json!({"type":"ackHandoff","id":item["id"]})).unwrap();
        assert!(app.state::<WindowState>().handoff.lock().unwrap().is_none());
    }
}
