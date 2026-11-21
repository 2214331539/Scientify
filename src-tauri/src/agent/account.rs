//! Sign in with a ChatGPT plan. The engine runs the sign-in itself (a browser page
//! and a local callback) and its requests then use the person's own plan.
//! Scientify starts the sign-in, shows the account and its usage, and hands the
//! sign-in to the engines of each workspace kind.
//!
//! Each workspace kind has its own engine home, and the engine keeps the sign-in
//! in `auth.json` there. People sign in through the account home; before a
//! ChatGPT engine starts, the newest sign-in (engines renew it now and then) is
//! copied to the account home and the engine's home, so a renewal made in one
//! place reaches the others.
use super::process::{self, EngineSession, EventSink};
use super::{blocking, codex_home, AppState, DOMAINS};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

const AUTH: &str = "auth.json";
const HOME: &str = "account";
const BUDGET: Duration = Duration::from_secs(30);
const SIGN_IN_FIRST: &str = "请先在模型设置里登录 ChatGPT 账号。";

/// Settings every engine signed in with ChatGPT runs with: the sign-in lives in
/// the engine home's file, and an API key in the environment is never used.
pub const OVERRIDES: [&str; 2] = [
    "cli_auth_credentials_store=\"file\"",
    "forced_login_method=\"chatgpt\"",
];

/// The account engine lives only while a sign-in waits for the browser.
#[derive(Default)]
pub struct AccountState {
    session: Mutex<Option<EngineSession>>,
    login: Arc<Mutex<Option<String>>>,
}

fn homes(data: &Path) -> Vec<PathBuf> {
    let agent = data.join("agent");
    std::iter::once(HOME)
        .chain(DOMAINS)
        .map(|name| agent.join(name))
        .collect()
}

/// When the engine last renewed this sign-in; `None` without one.
fn renewed(path: &Path) -> Option<String> {
    let value: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    value["tokens"]["refresh_token"].as_str()?;
    Some(
        value["last_refresh"]
            .as_str()
            .unwrap_or_default()
            .to_string(),
    )
}

/// Copy the newest sign-in to the account home and `home`.
pub fn share(data: &Path, home: &Path) -> Result<(), String> {
    let (stamp, source) = homes(data)
        .into_iter()
        .chain(std::iter::once(home.to_path_buf()))
        .filter_map(|dir| {
            let path = dir.join(AUTH);
            renewed(&path).map(|stamp| (stamp, path))
        })
        // The engine writes UTC timestamps in one format, so text order is time order.
        .max_by(|a, b| a.0.cmp(&b.0))
        .ok_or(SIGN_IN_FIRST)?;
    for dir in [data.join("agent").join(HOME), home.to_path_buf()] {
        let target = dir.join(AUTH);
        if target == source || renewed(&target).as_deref() == Some(stamp.as_str()) {
            continue;
        }
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        // A running engine may read the file at any moment; never let it see half.
        let partial = dir.join("auth.json.partial");
        std::fs::copy(&source, &partial)
            .and_then(|_| std::fs::rename(&partial, &target))
            .map_err(|e| format!("无法共享 ChatGPT 登录：{e}"))?;
    }
    Ok(())
}

fn forget(data: &Path) {
    for dir in homes(data) {
        let _ = std::fs::remove_file(dir.join(AUTH));
    }
}

fn start(
    app: &tauri::AppHandle,
    login: Arc<Mutex<Option<String>>>,
) -> Result<EngineSession, String> {
    let home = codex_home(app, HOME)?;
    let mut args = vec!["app-server", "--listen", "stdio://"];
    for value in OVERRIDES {
        args.extend(["-c", value]);
    }
    let emit = app.clone();
    let sink: EventSink = Arc::new(move |event| {
        if event["method"] != "account/login/completed" {
            return;
        }
        let params = &event["params"];
        if let Ok(mut waiting) = login.lock() {
            let finished = params["loginId"].as_str();
            if finished.is_none() || waiting.as_deref() == finished {
                *waiting = None;
            }
        }
        let _ = emit.emit(
            "chatgpt-account",
            json!({"success": params["success"], "error": params["error"]}),
        );
    });
    EngineSession::start_with_events(
        &process::engine_path()?,
        &args,
        &home,
        &home,
        &[],
        Some(sink),
    )
}

/// One request to the account engine. Unless a sign-in is waiting for the
/// browser, the engine stops afterwards.
fn call(app: &tauri::AppHandle, method: &str, params: Value, keep: bool) -> Result<Value, String> {
    let state = app.state::<AccountState>();
    let mut guard = state.session.lock().map_err(|e| e.to_string())?;
    if guard
        .as_mut()
        .is_some_and(|session| session.ensure_alive().is_err())
    {
        *guard = None;
    }
    if guard.is_none() {
        let data = app.state::<AppState>().storage.directory().to_path_buf();
        // Pick up a renewal made by a workspace engine; signed out is fine here.
        let _ = share(&data, &codex_home(app, HOME)?);
        *guard = Some(start(app, state.login.clone())?);
    }
    let session = guard.as_mut().ok_or("ChatGPT 账号服务未启动。")?;
    let result = session.call(method, params, BUDGET);
    session.take_pending();
    let waiting = state.login.lock().map(|l| l.is_some()).unwrap_or(false);
    if !keep && !waiting {
        *guard = None;
    }
    result
}

fn waiting(app: &tauri::AppHandle) -> bool {
    app.state::<AccountState>()
        .login
        .lock()
        .map(|l| l.is_some())
        .unwrap_or(false)
}

#[tauri::command]
pub async fn chatgpt_account(app: tauri::AppHandle, view: tauri::Webview) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    blocking(move || {
        let response = call(&app, "account/read", json!({"refreshToken": false}), false)?;
        let account = &response["account"];
        Ok(json!({
            "signedIn": account["type"] == "chatgpt",
            "email": account["email"],
            "plan": account["planType"],
            "waiting": waiting(&app),
        }))
    })
    .await
}

/// Open the ChatGPT sign-in page; `chatgpt-account` reports the outcome.
#[tauri::command]
pub async fn chatgpt_login(app: tauri::AppHandle, view: tauri::Webview) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    crate::library::trusted(&view)?;
    blocking(move || {
        let state = app.state::<AccountState>();
        // A second click starts over with a fresh page.
        *state.session.lock().map_err(|e| e.to_string())? = None;
        *state.login.lock().map_err(|e| e.to_string())? = None;
        let response = call(
            &app,
            "account/login/start",
            json!({"type": "chatgpt"}),
            true,
        )?;
        let url = response["authUrl"]
            .as_str()
            .and_then(|url| reqwest::Url::parse(url).ok())
            .filter(|url| url.scheme() == "https")
            .ok_or("引擎没有返回登录页面。")?;
        *state.login.lock().map_err(|e| e.to_string())? =
            Some(response["loginId"].as_str().unwrap_or_default().to_string());
        app.opener()
            .open_url(url.as_str(), None::<String>)
            .map_err(|e| format!("无法打开浏览器：{e}"))
    })
    .await
}

#[tauri::command]
pub async fn chatgpt_login_cancel(
    app: tauri::AppHandle,
    view: tauri::Webview,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    blocking(move || {
        let state = app.state::<AccountState>();
        *state.login.lock().map_err(|e| e.to_string())? = None;
        // Stopping the engine closes its sign-in callback.
        *state.session.lock().map_err(|e| e.to_string())? = None;
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn chatgpt_logout(app: tauri::AppHandle, view: tauri::Webview) -> Result<(), String> {
    crate::library::trusted(&view)?;
    blocking(move || {
        let result = call(&app, "account/logout", json!({}), false);
        forget(app.state::<AppState>().storage.directory());
        result.map(|_| ())
    })
    .await
}

/// How much of the plan's usage windows has been used.
#[tauri::command]
pub async fn chatgpt_usage(app: tauri::AppHandle, view: tauri::Webview) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    blocking(move || {
        let response = call(
            &app,
            "account/rateLimits/read",
            json!({"excludeResetCreditDetails": true}),
            false,
        )?;
        let limits = &response["rateLimits"];
        Ok(json!({"primary": limits["primary"], "secondary": limits["secondary"]}))
    })
    .await
}

/// The models this ChatGPT plan offers in the engine: every page, including the ones the
/// engine keeps out of its own short picker (they work; the account catalog hides many of
/// them), with the picker's models first. Special-purpose models such as code review are left out.
#[tauri::command]
pub async fn chatgpt_models(app: tauri::AppHandle, view: tauri::Webview) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    blocking(move || {
        let mut listed = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..20 {
            let response = call(
                &app,
                "model/list",
                json!({"includeHidden": true, "limit": 100, "cursor": cursor}),
                false,
            )?;
            listed.extend(response["data"].as_array().cloned().unwrap_or_default());
            cursor = response["nextCursor"].as_str().map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        Ok(Value::Array(picker_order(&listed)))
    })
    .await
}

/// The engine's models as the model list shows them: picker models first, hidden ones after.
fn picker_order(listed: &[Value]) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    let mut models: Vec<(bool, Value)> = listed
        .iter()
        .filter(|model| model["modelSpecialty"].as_str().is_none_or(str::is_empty))
        .filter_map(|model| {
            let id = model["model"]
                .as_str()
                .filter(|id| crate::ai::valid_model(id))?;
            if !seen.insert(id.to_string()) {
                return None;
            }
            let hidden = model["hidden"] == true;
            let name = model["displayName"].as_str().unwrap_or(id);
            let name = if hidden {
                format!("{name} · 更多")
            } else {
                name.to_string()
            };
            Some((hidden, json!({"id": id, "name": name})))
        })
        .collect();
    models.sort_by_key(|(hidden, _)| *hidden);
    models.into_iter().map(|(_, model)| model).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, stamp: &str, token: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join(AUTH),
            json!({"tokens": {"refresh_token": token}, "last_refresh": stamp}).to_string(),
        )
        .unwrap();
    }
    fn token(dir: &Path) -> String {
        let value: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.join(AUTH)).unwrap()).unwrap();
        value["tokens"]["refresh_token"].as_str().unwrap().into()
    }

    #[test]
    fn hidden_models_follow_the_picker_and_specialised_ones_are_left_out() {
        let listed = vec![
            json!({"model": "gpt-6-sol", "displayName": "GPT-6-Sol", "hidden": true}),
            json!({"model": "codex-auto-review", "displayName": "Review", "hidden": true, "modelSpecialty": "review"}),
            json!({"model": "gpt-6-luna", "displayName": "GPT-6-Luna", "hidden": false}),
            json!({"model": "gpt-6-luna", "displayName": "GPT-6-Luna", "hidden": false}),
        ];
        let models = picker_order(&listed);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "gpt-6-luna");
        assert_eq!(models[1]["name"], "GPT-6-Sol · 更多");
    }

    #[test]
    fn engines_get_the_newest_sign_in() {
        let data = tempfile::tempdir().unwrap();
        let agent = data.path().join("agent");
        let code = agent.join("code");
        assert_eq!(share(data.path(), &code).unwrap_err(), SIGN_IN_FIRST);

        write(
            &agent.join(HOME),
            "2026-11-01T00:00:00.000000Z",
            "signed-in",
        );
        share(data.path(), &code).unwrap();
        assert_eq!(token(&code), "signed-in");

        // A workspace engine renewed it; the account home and the next engine follow.
        write(&code, "2026-11-09T00:00:00.000000Z", "renewed");
        let inbox = agent.join("inbox");
        share(data.path(), &inbox).unwrap();
        assert_eq!(token(&inbox), "renewed");
        assert_eq!(token(&agent.join(HOME)), "renewed");
        assert!(!inbox.join("auth.json.partial").exists());

        forget(data.path());
        assert_eq!(share(data.path(), &code).unwrap_err(), SIGN_IN_FIRST);
    }
}
