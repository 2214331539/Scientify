use super::AppState;
use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use scientify_core::library::{Binding, LocalLibrary, Note, Operation, Scan};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct LibraryState {
    pub service: Arc<LocalLibrary>,
    watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}
impl LibraryState {
    pub fn new(directory: PathBuf) -> Self {
        Self {
            service: Arc::new(LocalLibrary::new(directory)),
            watchers: Mutex::new(HashMap::new()),
        }
    }
}
pub fn trusted(view: &tauri::Webview) -> Result<(), String> {
    if matches!(view.label(), "main" | "workspace") {
        Ok(())
    } else {
        Err("网页不能调用应用接口。".into())
    }
}
fn project(state: &AppState, id: &str) -> Result<(), String> {
    let data = state.storage.load()?.ok_or("请先保存项目。")?;
    if data["projects"]
        .as_array()
        .is_some_and(|ps| ps.iter().any(|p| p["id"].as_str() == Some(id)))
    {
        Ok(())
    } else {
        Err("项目不存在。".into())
    }
}
pub fn watch(app: &tauri::AppHandle, project_id: &str) -> Result<(), String> {
    let state = app.state::<LibraryState>();
    let mut watchers = state.watchers.lock().map_err(|e| e.to_string())?;
    watchers.remove(project_id);
    let Some(root) = state.service.root(project_id)? else {
        return Ok(());
    };
    let app = app.clone();
    let project = project_id.to_string();
    let service = state.service.clone();
    let last = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(1)));
    let mut watcher=notify::recommended_watcher(move |event:Result<notify::Event,notify::Error>|{
        if let Ok(event)=&event {if event.paths.iter().all(|p|p.components().any(|c|c.as_os_str()==".scientify")){return;}service.invalidate_fingerprints(&event.paths);}
        // Coalesce bursts with one trailing event; no busy-loop polling of the file system.
        let mut last=last.lock().unwrap();if last.elapsed()<Duration::from_millis(250){return;}*last=Instant::now();
        let app=app.clone();let project=project.clone();std::thread::spawn(move||{std::thread::sleep(Duration::from_millis(300));let _=app.emit("library-changed",serde_json::json!({"projectId":project,"error":event.err().map(|e|e.to_string())}));});
    }).map_err(|e|e.to_string())?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|e| e.to_string())?;
    watchers.insert(project_id.into(), watcher);
    Ok(())
}
#[tauri::command]
pub async fn library_choose(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Option<Scan>, String> {
    trusted(&view)?;
    project(&state, &project_id)?;
    let service = app.state::<LibraryState>().service.clone();
    let a = app.clone();
    let id = project_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = a.dialog().file().blocking_pick_folder() else {
            return Ok(None);
        };
        service
            .mount(&id, &file.into_path().map_err(|e| e.to_string())?)
            .map(Some)
    })
    .await
    .map_err(|e| e.to_string())??;
    if result.is_some() {
        watch(&app, &project_id)?;
    }
    Ok(result)
}
#[tauri::command]
pub async fn library_command(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    operation: Operation,
) -> Result<Scan, String> {
    trusted(&view)?;
    project(&state, &project_id)?;
    let service = app.state::<LibraryState>().service.clone();
    let id = project_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || service.operate(&id, operation))
        .await
        .map_err(|e| e.to_string())??;
    if !app
        .state::<LibraryState>()
        .watchers
        .lock()
        .map_err(|e| e.to_string())?
        .contains_key(&project_id)
        || result.root.is_none()
    {
        watch(&app, &project_id)?;
    }
    Ok(result)
}
#[tauri::command]
pub async fn library_open(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    path: String,
) -> Result<Binding, String> {
    trusted(&view)?;
    let service = app.state::<LibraryState>().service.clone();
    tauri::async_runtime::spawn_blocking(move || service.open(&project_id, &path))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn library_pdf(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    trusted(&view)?;
    let service = app.state::<LibraryState>().service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.pdf(&project_id, &id).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn library_note(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    id: String,
    content: Option<String>,
    revision: Option<String>,
    copy: Option<String>,
) -> Result<Note, String> {
    trusted(&view)?;
    let service = app.state::<LibraryState>().service.clone();
    tauri::async_runtime::spawn_blocking(move || match content {
        Some(content) => service.save_note(
            &project_id,
            &id,
            &content,
            revision.as_deref(),
            copy.as_deref(),
        ),
        None => service.note(&project_id, &id),
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn library_external(
    app: tauri::AppHandle,
    view: tauri::Webview,
    project_id: String,
    path: String,
    open: bool,
) -> Result<(), String> {
    trusted(&view)?;
    let file = app
        .state::<LibraryState>()
        .service
        .external_path(&project_id, &path)?;
    if open {
        let extension = file
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if ![
            "pdf", "md", "txt", "csv", "png", "jpg", "jpeg", "svg", "bib", "tex", "json",
        ]
        .contains(&extension.as_str())
        {
            return Err("该文件类型不允许直接执行，请在文件管理器中打开。".into());
        }
        app.opener()
            .open_path(file.to_string_lossy(), None::<String>)
            .map_err(|e| e.to_string())
    } else {
        app.opener()
            .reveal_item_in_dir(file)
            .map_err(|e| e.to_string())
    }
}
#[tauri::command]
pub async fn library_import_bytes(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<Scan, String> {
    trusted(&view)?;
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Destination {
        project_id: String,
        folder: String,
        name: String,
    }
    // ASCII JSON escapes keep Chinese filenames valid in HTTP headers.
    let destination: Destination = serde_json::from_str(
        request
            .headers()
            .get("x-scientify-file")
            .and_then(|value| value.to_str().ok())
            .ok_or("缺少拖入文件信息。")?,
    )
    .map_err(|_| "拖入文件信息无效。")?;
    project(&state, &destination.project_id)?;
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("拖入文件内容无效。".into());
    };
    if bytes.len() as u64 > scientify_core::library::PDF_LIMIT {
        return Err("文件名无效或文件超过 150 MiB。".into());
    }
    let bytes = bytes.clone();
    let service = app.state::<LibraryState>().service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service.import_bytes(
            &destination.project_id,
            &destination.folder,
            &destination.name,
            &bytes,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn library_import(
    app: tauri::AppHandle,
    view: tauri::Webview,
    state: State<'_, AppState>,
    project_id: String,
    migrate: bool,
) -> Result<Option<Scan>, String> {
    trusted(&view)?;
    project(&state, &project_id)?;
    let service = app.state::<LibraryState>().service.clone();
    let data = state.storage.load()?.ok_or("工作区未载入")?;
    let assets = state.storage.directory().join("assets/pdf");
    let a = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let files = if migrate {
            data["papers"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|p| {
                    p["projects"]
                        .as_array()
                        .is_some_and(|ps| ps.iter().any(|v| v.as_str() == Some(&project_id)))
                })
                .filter_map(|p| {
                    let asset = p["assetId"].as_str()?;
                    let uuid = uuid::Uuid::parse_str(asset).ok()?;
                    let source = assets.join(format!("{uuid}.pdf"));
                    let title = p["title"].as_str().unwrap_or("paper");
                    let safe: String = title
                        .chars()
                        .map(|c| {
                            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                                '_'
                            } else {
                                c
                            }
                        })
                        .take(100)
                        .collect();
                    let mut note = [
                        p["note"].as_str().unwrap_or(""),
                        p["abstract"].as_str().unwrap_or(""),
                    ]
                    .join("\n\n");
                    if let Some(quotes) = p["quotes"].as_array() {
                        for q in quotes {
                            if let Some(text) = q["text"].as_str() {
                                note.push_str(&format!(
                                    "\n\n> {}\n\n[Page {}](scientify-page:{})\n",
                                    text.replace('\n', "\n> "),
                                    q["page"],
                                    q["page"]
                                ));
                            }
                        }
                    }
                    if let Some(records) = data["records"].as_array() {
                        for record in records.iter().filter(|r| {
                            r["project"].as_str() == Some(&project_id)
                                && r["sources"].as_array().is_some_and(|sources| {
                                    sources.iter().any(|source| source["resourceId"] == p["id"])
                                })
                        }) {
                            note.push_str(&format!(
                                "\n\n## {}\n\n{}",
                                record["title"].as_str().unwrap_or("Note"),
                                record["body"].as_str().unwrap_or("")
                            ));
                        }
                    }
                    Some((
                        source,
                        format!("paper-{}.pdf", safe.trim().trim_end_matches('.')),
                        Some(note),
                    ))
                })
                .collect()
        } else {
            let Some(selected) = a
                .dialog()
                .file()
                .add_filter("PDF", &["pdf"])
                .blocking_pick_files()
            else {
                return Ok(None);
            };
            let mut files = vec![];
            for file in selected {
                let path = file.into_path().map_err(|e| e.to_string())?;
                let name = path
                    .file_name()
                    .ok_or("无效文件名")?
                    .to_string_lossy()
                    .into_owned();
                files.push((path, name, None));
            }
            files
        };
        service.import_files(&project_id, &files).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}
