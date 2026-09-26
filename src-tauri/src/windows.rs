//! Window lifecycle stays in Rust; both webviews share the same storage owner.
use tauri::{Emitter, Manager};

#[tauri::command]
pub async fn open_project_window(
    app: tauri::AppHandle,
    state: tauri::State<'_, super::AppState>,
    project_id: String,
    target: Option<String>,
) -> Result<(), String> {
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
    if let Some(target) = target {
        if target.len() > 8192 {
            return Err("导航参数过长。".into());
        }
        url.query_pairs_mut().append_pair("target", &target);
    }
    let route = format!("index.html?{}", url.query().unwrap_or_default());
    let window =
        tauri::WebviewWindowBuilder::new(&app, "workspace", tauri::WebviewUrl::App(route.into()))
            .title("Scientify · Workspace")
            .inner_size(1440.0, 940.0)
            .min_inner_size(1000.0, 680.0)
            .decorations(false)
            .disable_drag_drop_handler()
            .maximized(true)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;
    // A failed webview boot must not leave Projects indefinitely blocked.
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        if window.is_visible().is_ok_and(|visible| !visible) {
            let _ = window.destroy();
        }
    });
    // Keep Projects visible until the frontend confirms its data has loaded.
    Ok(())
}

#[tauri::command]
pub fn workspace_window_ready(app: tauri::AppHandle) -> Result<(), String> {
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
