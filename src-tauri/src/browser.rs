//! Remote WebView2 children have no application capabilities and no application preload.
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use tauri::{
    webview::{NewWindowResponse, WebviewBuilder},
    Emitter, Manager, WebviewUrl,
};
use tauri_plugin_opener::OpenerExt;
fn trace(message: impl std::fmt::Display) {
    #[cfg(debug_assertions)]
    if let Some(report) = std::env::var_os("SCIENTIFY_NATIVE_REPORT") {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(std::path::PathBuf::from(report).with_extension("trace"))
        {
            let _ = writeln!(f, "{message}");
        }
    }
    #[cfg(not(debug_assertions))]
    let _ = message;
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserTab {
    pub id: String,
    pub project_id: String,
    pub owner: String,
    pub url: String,
    pub title: String,
    pub loading: bool,
    pub can_back: bool,
    pub can_forward: bool,
    pub error: Option<String>,
}
#[derive(Default)]
pub struct BrowserState(pub Mutex<HashMap<String, BrowserTab>>);
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    viewport_width: f64,
    viewport_height: f64,
    visible: bool,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    Open { project_id: String },
    Navigate { id: String, address: String },
    Action { id: String, action: String },
    Layout { id: String, bounds: Bounds },
    Close { id: String },
    HideAll,
    Snapshot,
    External { address: String },
}

pub fn resolve_address(raw: &str) -> Result<Option<tauri::Url>, String> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(None);
    }
    if text.len() > 8192 {
        return Err("地址过长。".into());
    }
    let lower = text.to_lowercase();
    if text.contains('\\') {
        return Err("仅允许 HTTP 或 HTTPS 网页。".into());
    }
    if [
        "site:",
        "intitle:",
        "inurl:",
        "filetype:",
        "author:",
        "doi:",
    ]
    .iter()
    .any(|prefix| lower.starts_with(prefix))
    {
        let mut url = tauri::Url::parse("https://duckduckgo.com/").unwrap();
        url.query_pairs_mut().append_pair("q", text);
        return Ok(Some(url));
    }
    if [
        "file:",
        "javascript:",
        "data:",
        "tauri:",
        "asset:",
        "about:",
        "blob:",
    ]
    .iter()
    .any(|p| lower.starts_with(p))
    {
        return Err("仅允许 HTTP 或 HTTPS 网页。".into());
    }
    let url = if lower.starts_with("http://") || lower.starts_with("https://") {
        tauri::Url::parse(text).map_err(|_| "网页地址无效。")?
    } else if !text.chars().any(char::is_whitespace)
        && (text.split('/').next().unwrap_or("").contains('.')
            || lower.starts_with("localhost")
            || lower.starts_with("127.0.0.1")
            || lower.starts_with("[::1]"))
    {
        tauri::Url::parse(&format!(
            "{}://{text}",
            if lower.starts_with("localhost")
                || lower.starts_with("127.0.0.1")
                || lower.starts_with("[::1]")
            {
                "http"
            } else {
                "https"
            }
        ))
        .map_err(|_| "网页地址无效。")?
    } else {
        if text.split(':').next().is_some_and(|p| {
            text.contains(':') && !p.contains(' ') && p.chars().all(|c| c.is_ascii_alphabetic())
        }) {
            return Err("仅允许 HTTP 或 HTTPS 网页。".into());
        }
        let mut u = tauri::Url::parse("https://duckduckgo.com/").unwrap();
        u.query_pairs_mut().append_pair("q", text);
        u
    };
    if !allowed(&url) {
        return Err("该地址不允许在内嵌浏览器中打开。".into());
    }
    Ok(Some(url))
}
pub fn allowed(url: &tauri::Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
        && !url.host_str().is_some_and(|h| {
            ["tauri.localhost", "ipc.localhost", "asset.localhost"]
                .contains(&h.trim_end_matches('.'))
        })
        && !matches!(url.port(), Some(1420 | 1421))
}
fn update(app: &tauri::AppHandle, id: &str, change: impl FnOnce(&mut BrowserTab)) {
    let state = app.state::<BrowserState>();
    let snapshot = {
        let Ok(mut tabs) = state.0.lock() else {
            return;
        };
        let Some(tab) = tabs.get_mut(id) else {
            return;
        };
        change(tab);
        tab.clone()
    };
    trace(format!(
        "state {} loading={} back={} title={} error={:?}",
        snapshot.url, snapshot.loading, snapshot.can_back, snapshot.title, snapshot.error
    ));
    let _ = app.emit_to(&snapshot.owner, "browser-changed", &snapshot);
}
pub(crate) fn get(app: &tauri::AppHandle, owner: &str, id: &str) -> Result<BrowserTab, String> {
    app.state::<BrowserState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .filter(|t| t.owner == owner)
        .cloned()
        .ok_or("网页标签不存在。".into())
}
fn owner_tabs(app: &tauri::AppHandle, owner: &str) -> Result<Vec<BrowserTab>, String> {
    Ok(app
        .state::<BrowserState>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .filter(|t| t.owner == owner)
        .cloned()
        .collect())
}
pub(crate) fn create_tab(
    app: &tauri::AppHandle,
    owner: &str,
    project: &str,
) -> Result<BrowserTab, String> {
    let state = app.state::<BrowserState>();
    let mut tabs = state.0.lock().map_err(|e| e.to_string())?;
    if tabs.values().filter(|t| t.owner == owner).count() >= 16 {
        return Err("最多同时打开 16 个网页标签。".into());
    }
    let tab = BrowserTab {
        id: format!("remote-{}", uuid::Uuid::new_v4()),
        project_id: project.into(),
        owner: owner.into(),
        url: String::new(),
        title: String::new(),
        loading: false,
        can_back: false,
        can_forward: false,
        error: None,
    };
    tabs.insert(tab.id.clone(), tab.clone());
    Ok(tab)
}
pub(crate) fn navigate(
    app: &tauri::AppHandle,
    tab: &BrowserTab,
    url: tauri::Url,
) -> Result<(), String> {
    if let Some(view) = app.get_webview(&tab.id) {
        update(app, &tab.id, |t| {
            t.loading = true;
            t.error = None;
        });
        return view.navigate(url).map_err(|e| e.to_string());
    }
    let window = app.get_window(&tab.owner).ok_or("工作区窗口不存在")?;
    let owner = tab.owner.clone();
    let project = tab.project_id.clone();
    let a = app.clone();
    let new_app = app.clone();
    let id = tab.id.clone();
    let profile = app
        .state::<crate::AppState>()
        .storage
        .directory()
        .parent()
        .ok_or("数据目录无效")?
        .join("browser-profile");
    let builder = WebviewBuilder::new(
        &tab.id,
        WebviewUrl::External(tauri::Url::parse("about:blank").unwrap()),
    )
    .data_directory(profile)
    .on_navigation(move |url| {
        if url.as_str() == "about:blank" {
            return true;
        }
        if !allowed(url) {
            update(&a, &id, |t| {
                t.loading = false;
                t.error = Some("已阻止非网页或应用内部地址。".into());
            });
            return false;
        }
        update(&a, &id, |t| {
            t.url = url.to_string();
            t.loading = true;
            t.error = None;
        });
        true
    })
    .on_document_title_changed(|view, title| {
        update(view.app_handle(), view.label(), |t| t.title = title)
    })
    .on_page_load(|view, event| {
        trace(format!("page {:?} {}", event.event(), event.url()));
        if allowed(event.url()) {
            update(view.app_handle(), view.label(), |t| {
                t.url = event.url().to_string();
                t.loading = matches!(event.event(), tauri::webview::PageLoadEvent::Started);
            });
        }
    })
    .on_new_window(move |url, _| {
        if allowed(&url) {
            let a = new_app.clone();
            let owner = owner.clone();
            let project = project.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(tab) = create_tab(&a, &owner, &project) {
                    let _ = navigate(&a, &tab, url);
                    let _ = a.emit_to(&owner, "browser-created", tab);
                }
            });
        }
        NewWindowResponse::Deny
    })
    .on_download(move |view, event| {
        match event {
            tauri::webview::DownloadEvent::Requested { url, destination } => {
                if !allowed(&url) {
                    return false;
                }
                let app = view.app_handle();
                let Ok(tab) = get(app, view.window().label(), view.label()) else {
                    return false;
                };
                let mut dialog = rfd::FileDialog::new()
                    .set_parent(&view.window())
                    .set_file_name(
                        destination
                            .file_name()
                            .unwrap_or_default()
                            .to_string_lossy(),
                    );
                if let Ok(Some(root)) = app
                    .state::<crate::library::LibraryState>()
                    .service
                    .root(&tab.project_id)
                {
                    dialog = dialog.set_directory(root);
                }
                // rfd's Windows save dialog is native; no web content chooses the destination.
                if let Some(path) = dialog.save_file() {
                    *destination = path;
                    return true;
                }
                false
            }
            tauri::webview::DownloadEvent::Finished { success, .. } => {
                if let Ok(tab) = get(view.app_handle(), view.window().label(), view.label()) {
                    let _ = view.app_handle().emit_to(
                        &tab.owner,
                        "library-changed",
                        serde_json::json!({"projectId":tab.project_id}),
                    );
                    update(view.app_handle(), &tab.id, |t| {
                        t.loading = false;
                        t.error = if success {
                            None
                        } else {
                            Some("下载未完成。".into())
                        };
                    });
                }
                true
            }
            _ => false,
        }
    });
    let view = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(0., 0.),
            tauri::LogicalSize::new(1., 1.),
        )
        .map_err(|e| e.to_string())?;
    view.hide().map_err(|e| e.to_string())?;
    update(app, &tab.id, |t| {
        t.url = url.to_string();
        t.loading = true;
    });
    #[cfg(windows)]
    install_native(&view)?;
    view.navigate(url).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(windows)]
fn install_native(view: &tauri::Webview) -> Result<(), String> {
    use webview2_com::{
        HistoryChangedEventHandler, Microsoft::Web::WebView2::Win32::*,
        NavigationCompletedEventHandler, NavigationStartingEventHandler,
        PermissionRequestedEventHandler, WebResourceRequestedEventHandler,
    };
    use windows::{
        core::{w, BOOL, PWSTR},
        Win32::System::Com::CoTaskMemFree,
    };
    let a = view.app_handle().clone();
    let id = view.label().to_string();
    view.with_webview(move |native| unsafe {
        trace("install native handlers");
        let Ok(core) = native.controller().CoreWebView2() else {
            return;
        };
        let environment = native.environment();
        let _ = core.AddWebResourceRequestedFilter(w!("*"), COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL);
        let _ = core.add_WebResourceRequested(
            &WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let request = args.Request()?;
                    let mut raw = PWSTR::null();
                    request.Uri(&mut raw)?;
                    let value = raw.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(raw.0.cast()));
                    if let Ok(url) = tauri::Url::parse(&value) {
                        if !allowed(&url) && !matches!(url.scheme(), "data" | "blob") {
                            let response = environment.CreateWebResourceResponse(
                                None::<&windows::Win32::System::Com::IStream>,
                                403,
                                w!("Forbidden"),
                                w!("Content-Type: text/plain"),
                            )?;
                            args.SetResponse(&response)?;
                        }
                    }
                }
                Ok(())
            })),
            &mut 0,
        );
        let _ = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                if let Some(args) = args {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                }
                Ok(())
            })),
            &mut 0,
        );
        let app = a.clone();
        let label = id.clone();
        let _ = core.add_NavigationStarting(
            &NavigationStartingEventHandler::create(Box::new(move |_, _| {
                update(&app, &label, |t| {
                    t.loading = true;
                    t.error = None;
                });
                Ok(())
            })),
            &mut 0,
        );
        let app = a.clone();
        let label = id.clone();
        let _ = core.add_NavigationCompleted(
            &NavigationCompletedEventHandler::create(Box::new(move |_, args| {
                if let Some(args) = args {
                    let mut ok = BOOL(0);
                    args.IsSuccess(&mut ok)?;
                    let mut status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
                    args.WebErrorStatus(&mut status)?;
                    update(&app, &label, |t| {
                        t.loading = false;
                        // Stop, replacement navigations and downloads cancel a navigation normally.
                        if !ok.as_bool()
                            && status != COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED
                        {
                            t.error = Some("网页加载失败，可刷新或在系统浏览器打开。".into());
                        }
                    });
                }
                Ok(())
            })),
            &mut 0,
        );
        let _ = core.add_HistoryChanged(
            &HistoryChangedEventHandler::create(Box::new(move |sender, _| {
                if let Some(core) = sender {
                    let (mut back, mut forward) = (BOOL(0), BOOL(0));
                    core.CanGoBack(&mut back)?;
                    core.CanGoForward(&mut forward)?;
                    let mut source = PWSTR::null();
                    core.Source(&mut source)?;
                    let url = source.to_string().unwrap_or_default();
                    CoTaskMemFree(Some(source.0.cast()));
                    update(&a, &id, |t| {
                        t.can_back = back.as_bool();
                        t.can_forward = forward.as_bool();
                        if let Ok(u) = tauri::Url::parse(&url) {
                            if allowed(&u) {
                                t.url = url;
                            }
                        }
                    });
                }
                Ok(())
            })),
            &mut 0,
        );
    })
    .map_err(|e| e.to_string())
}
pub fn close_owner(app: &tauri::AppHandle, owner: &str) {
    let ids: Vec<_> = app
        .state::<BrowserState>()
        .0
        .lock()
        .unwrap()
        .values()
        .filter(|t| t.owner == owner)
        .map(|t| t.id.clone())
        .collect();
    for id in ids {
        if let Some(view) = app.get_webview(&id) {
            let _ = view.close();
        }
        app.state::<BrowserState>().0.lock().unwrap().remove(&id);
    }
}
#[tauri::command]
pub async fn browser_command(
    app: tauri::AppHandle,
    view: tauri::Webview,
    request: Request,
) -> Result<serde_json::Value, String> {
    crate::library::trusted(&view)?;
    let owner = view.window().label().to_string();
    match request {
        Request::Open { project_id } => {
            let tab = create_tab(&app, &owner, &project_id)?;
            Ok(serde_json::to_value(tab).unwrap())
        }
        Request::Navigate { id, address } => {
            let tab = get(&app, &owner, &id)?;
            if let Some(url) = resolve_address(&address)? {
                navigate(&app, &tab, url)?;
            }
            Ok(serde_json::to_value(get(&app, &owner, &id)?).unwrap())
        }
        Request::Snapshot => Ok(serde_json::to_value(
            app.state::<BrowserState>()
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .values()
                .filter(|t| t.owner == owner)
                .cloned()
                .collect::<Vec<_>>(),
        )
        .unwrap()),
        Request::HideAll => {
            for tab in owner_tabs(&app, &owner)? {
                if let Some(v) = app.get_webview(&tab.id) {
                    v.hide().map_err(|e| e.to_string())?;
                }
            }
            Ok(serde_json::Value::Null)
        }
        Request::Close { id } => {
            get(&app, &owner, &id)?;
            if let Some(v) = app.get_webview(&id) {
                v.close().map_err(|e| e.to_string())?;
            }
            app.state::<BrowserState>()
                .0
                .lock()
                .map_err(|e| e.to_string())?
                .remove(&id);
            Ok(serde_json::Value::Null)
        }
        Request::Layout { id, bounds } => {
            get(&app, &owner, &id)?;
            for tab in owner_tabs(&app, &owner)?.into_iter().filter(|t| t.id != id) {
                if let Some(v) = app.get_webview(&tab.id) {
                    let _ = v.hide();
                }
            }
            if let Some(v) = app.get_webview(&id) {
                let window = view.window();
                let scale = window.scale_factor().map_err(|e| e.to_string())?;
                let size = window
                    .inner_size()
                    .map_err(|e| e.to_string())?
                    .to_logical::<f64>(scale);
                if !bounds.visible
                    || ![
                        bounds.x,
                        bounds.y,
                        bounds.width,
                        bounds.height,
                        bounds.viewport_width,
                        bounds.viewport_height,
                    ]
                    .iter()
                    .all(|n| n.is_finite())
                    || bounds.width < 10.
                    || bounds.height < 10.
                    || bounds.viewport_width < 1.
                    || bounds.viewport_height < 1.
                {
                    v.hide().map_err(|e| e.to_string())?;
                } else {
                    // CSS pixels may differ from native logical pixels after WebView zoom.
                    let sx = size.width / bounds.viewport_width;
                    let sy = size.height / bounds.viewport_height;
                    let x = (bounds.x.max(48.) * sx).min(size.width);
                    let y = (bounds.y.max(44.) * sy).min(size.height);
                    let w = (bounds.width * sx).min(size.width - x).max(1.);
                    let h = (bounds.height * sy).min(size.height - y - 24. * sy).max(1.);
                    v.set_bounds(tauri::Rect {
                        position: tauri::LogicalPosition::new(x, y).into(),
                        size: tauri::LogicalSize::new(w, h).into(),
                    })
                    .map_err(|e| e.to_string())?;
                    v.show().map_err(|e| e.to_string())?;
                }
            }
            Ok(serde_json::Value::Null)
        }
        Request::External { address } => {
            let url = resolve_address(&address)?.ok_or("请输入网址。")?;
            app.opener()
                .open_url(url.as_str(), None::<String>)
                .map_err(|e| e.to_string())?;
            Ok(serde_json::Value::Null)
        }
        Request::Action { id, action } => {
            get(&app, &owner, &id)?;
            let v = app.get_webview(&id).ok_or("网页尚未打开。")?;
            if action == "reload" {
                v.reload().map_err(|e| e.to_string())?;
            } else {
                #[cfg(windows)]
                {
                    if !["back", "forward", "stop"].contains(&action.as_str()) {
                        return Err("无效的浏览器操作。".into());
                    }
                    v.with_webview(move |native| unsafe {
                        if let Ok(core) = native.controller().CoreWebView2() {
                            let _ = match action.as_str() {
                                "back" => core.GoBack(),
                                "forward" => core.GoForward(),
                                _ => core.Stop(),
                            };
                        }
                    })
                    .map_err(|e| e.to_string())?;
                }
                #[cfg(not(windows))]
                return Err("当前浏览器导航仅支持 Windows。".into());
            }
            Ok(serde_json::Value::Null)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn addresses_and_internal_boundaries() {
        assert_eq!(
            resolve_address("continual learning")
                .unwrap()
                .unwrap()
                .host_str(),
            Some("duckduckgo.com")
        );
        assert_eq!(
            resolve_address("localhost:8765/test")
                .unwrap()
                .unwrap()
                .scheme(),
            "http"
        );
        assert_eq!(
            resolve_address("example.com").unwrap().unwrap().scheme(),
            "https"
        );
        for bad in [
            "file:///C:/secret",
            "javascript:alert(1)",
            "data:text/html,test",
            "http://ipc.localhost/",
            "http://localhost:1420/",
            "https://user:secret@example.com/",
        ] {
            assert!(resolve_address(bad).is_err(), "{bad}");
        }
        assert!(resolve_address(" ").unwrap().is_none());
    }
}
