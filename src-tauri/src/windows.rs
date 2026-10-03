//! Window lifecycle stays in Rust; both webviews share the same storage owner.
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
static WORKSPACE_READY: AtomicBool = AtomicBool::new(false);
fn trace(stage: impl std::fmt::Display) {
    #[cfg(debug_assertions)]
    if let Some(path) = std::env::var_os("SCIENTIFY_NATIVE_REPORT") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::path::PathBuf::from(path).with_extension("windows.trace"))
        {
            let _ = writeln!(f, "{stage}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = stage;
}

#[tauri::command]
pub async fn open_project_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::AppState>,
    project_id: String,
    target: Option<String>,
    preferences: Option<serde_json::Value>,
) -> Result<(), String> {
    trace("open request");
    let data = state.storage.load()?.ok_or("工作区尚未载入")?;
    if !data["projects"]
        .as_array()
        .is_some_and(|items| items.iter().any(|p| p["id"].as_str() == Some(&project_id)))
    {
        return Err("项目不存在，请刷新项目列表。".into());
    }
    if let Some(window) = app.get_webview_window("workspace") {
        window.unminimize().map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        if let Some(manager) = app.get_webview_window("main") {
            manager.hide().map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let mut url = tauri::Url::parse("http://localhost/index.html").unwrap();
    url.query_pairs_mut().append_pair("project", &project_id);
    if let Some(prefs) = preferences {
        if matches!(prefs["language"].as_str(), Some("zh-CN" | "en"))
            && matches!(prefs["theme"].as_str(), Some("light" | "dark" | "system"))
        {
            url.query_pairs_mut()
                .append_pair("preferences", &prefs.to_string());
        }
    }
    if let Some(target) = target {
        if target.len() > 8192 {
            return Err("导航参数过长。".into());
        }
        url.query_pairs_mut().append_pair("target", &target);
    }
    let route = format!("index.html?{}", url.query().unwrap_or_default());
    WORKSPACE_READY.store(false, Ordering::SeqCst);
    let profile = state
        .storage
        .directory()
        .parent()
        .ok_or("数据位置无效")?
        .join("workspace-ui-profile");
    let builder =
        tauri::WebviewWindowBuilder::new(&app, "workspace", tauri::WebviewUrl::App(route.into()))
            .title("Scientify · Workspace")
            .inner_size(1440.0, 940.0)
            .min_inner_size(1000.0, 680.0)
            .decorations(false)
            .disable_drag_drop_handler()
            .maximized(true)
            .on_page_load(|_, event| trace(format!("page {:?} {}", event.event(), event.url())))
            .visible(true);
    trace("creating native window");
    let window = crate::webview_profile::window(builder, profile)?
        .build()
        .map_err(|e| e.to_string())?;
    trace("native window created");
    // A failed webview boot must not leave Projects indefinitely blocked.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        if window.is_visible().is_ok() && !WORKSPACE_READY.load(Ordering::SeqCst) {
            let _ = window.destroy();
        }
    });
    // Keep Projects visible until the frontend confirms its data has loaded.
    Ok(())
}

#[tauri::command]
pub async fn workspace_window_ready(app: tauri::AppHandle) -> Result<(), String> {
    trace("frontend ready");
    WORKSPACE_READY.store(true, Ordering::SeqCst);
    let window = app
        .get_webview_window("workspace")
        .ok_or("工作区窗口不存在")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    if let Some(manager) = app.get_webview_window("main") {
        manager.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn show_projects(app: &tauri::AppHandle) {
    if let Some(manager) = app.get_webview_window("main") {
        let _ = manager.emit("projects-refresh", ());
        let _ = manager.show();
        let _ = manager.unminimize();
        let _ = manager.set_focus();
    }
}
