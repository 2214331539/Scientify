use scientify_core::storage::{read_workspace, Storage};
use serde::Serialize;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
mod browser;
#[cfg(test)]
mod ipc_smoke;
mod library;
#[cfg(debug_assertions)]
mod literature_smoke;
mod research;
mod windows;

struct AppState {
    storage: Arc<Storage>,
    files: Arc<scientify_core::research::ResearchFiles>,
    legacy: PathBuf,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadResult {
    workspace: Option<Value>,
    directory: String,
    legacy_available: bool,
}

#[tauri::command]
async fn workspace_load(state: State<'_, AppState>) -> Result<LoadResult, String> {
    let storage = state.storage.clone();
    let legacy = state.legacy.clone();
    tauri::async_runtime::spawn_blocking(move || {
        Ok(LoadResult {
            workspace: storage.load()?,
            directory: storage.directory().display().to_string(),
            legacy_available: legacy.join("workspace.json").is_file(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_save(
    state: State<'_, AppState>,
    workspace: Value,
    expected_revision: u64,
) -> Result<Value, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.save(workspace, expected_revision))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_restore(state: State<'_, AppState>) -> Result<Value, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || storage.restore())
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_migrate_legacy(state: State<'_, AppState>) -> Result<Value, String> {
    let storage = state.storage.clone();
    let legacy = state.legacy.clone();
    tauri::async_runtime::spawn_blocking(move || storage.migrate_legacy(&legacy))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_import(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<Value>, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Scientify JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = file.into_path().map_err(|e| e.to_string())?;
        storage.import(read_workspace(&path)?).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_export(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let Some(file) = app
            .dialog()
            .file()
            .add_filter("Scientify JSON", &["json"])
            .set_file_name("scientify-workspace.json")
            .blocking_save_file()
        else {
            return Ok(false);
        };
        storage.export(&file.into_path().map_err(|e| e.to_string())?)?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn choose_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .blocking_pick_folder()
            .map(|p| {
                p.into_path()
                    .map(|p| p.display().to_string())
                    .map_err(|e| e.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let isolated_smoke = std::env::var_os("SCIENTIFY_NATIVE_SMOKE").is_some();
    #[cfg(not(debug_assertions))]
    let isolated_smoke = false;
    let context = tauri::generate_context!();
    #[cfg(debug_assertions)]
    let context = {
        let mut context = context;
        if isolated_smoke {
            context.config_mut().app.windows[0].create = false;
        }
        context
    };
    let builder = if isolated_smoke {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app
                .get_webview_window("workspace")
                .or_else(|| app.get_webview_window("main"))
            {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
    };
    builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(browser::BrowserState::default())
        .on_window_event(|window, event| {
            if window.label() == "workspace" && matches!(event, tauri::WindowEvent::Destroyed) {
                browser::close_owner(window.app_handle(), "workspace");
                windows::show_projects(window.app_handle());
            }
        })
        .setup(move |app| {
            #[cfg(debug_assertions)]
            let directory = std::env::var_os("SCIENTIFY_DATA_DIR")
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                        .parent()
                        .expect("repository root")
                        .join(".tauri-data/workspace")
                });
            #[cfg(not(debug_assertions))]
            let directory = app.path().app_data_dir()?.join("workspace");
            let legacy = app
                .path()
                .data_dir()?
                .join("scientify-desktop-sample/workspace");
            app.manage(library::LibraryState::new(directory.clone()));
            app.manage(AppState {
                files: Arc::new(scientify_core::research::ResearchFiles::new(
                    directory.clone(),
                )),
                storage: Arc::new(Storage::open(directory).map_err(std::io::Error::other)?),
                legacy,
            });
            #[cfg(debug_assertions)]
            if isolated_smoke {
                let data = app.state::<AppState>().storage.directory().to_path_buf();
                if !data.to_string_lossy().contains(".test-artifacts") {
                    return Err("native smoke requires an isolated test directory".into());
                }
                if std::env::var_os("SCIENTIFY_NATIVE_UI").is_some() {
                    literature_smoke::seed_ui(app.handle())?;
                }
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?
                    .data_directory(data.parent().unwrap().join("ui-profile"))
                    .build()?;
                if std::env::var_os("SCIENTIFY_NATIVE_UI").is_none() {
                    literature_smoke::start(app.handle().clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::library_choose,
            library::library_command,
            library::library_open,
            library::library_pdf,
            library::library_note,
            library::library_external,
            library::library_import,
            library::library_import_bytes,
            browser::browser_command,
            windows::open_project_window,
            windows::workspace_window_ready,
            workspace_load,
            workspace_save,
            workspace_restore,
            workspace_migrate_legacy,
            workspace_import,
            workspace_export,
            choose_directory,
            research::research_list_files,
            research::research_read_file,
            research::research_write_file,
            research::research_import_pdf,
            research::research_read_pdf,
            research::research_git_status,
            research::research_ask_ai,
            research::research_fetch_arxiv,
        ])
        .run(context)
        .expect("Scientify failed to start");
}
