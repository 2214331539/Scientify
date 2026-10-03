use scientify_core::storage::{read_workspace, Storage};
use serde::Serialize;
use serde_json::Value;
use std::{path::PathBuf, sync::Arc};
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;
mod agent;
mod ai;
mod browser;
mod credentials;
mod data_location;
pub use data_location::migrate_offline as migrate_storage_offline;
mod code;
mod experiments;
mod git;
mod local_process;
pub use experiments::runner::run as run_managed_experiment;
#[cfg(test)]
mod ipc_smoke;
mod library;
#[cfg(debug_assertions)]
mod literature_smoke;
mod research;
#[cfg(unix)]
mod unix_process;
mod webview_profile;
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
async fn workspace_save<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    workspace: Value,
    expected_revision: u64,
) -> Result<Value, String> {
    let storage = state.storage.clone();
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let workspace = scientify_core::workspace::validate(workspace)?;
        let current = storage.load()?;
        experiments::catalog::validate_changes(&storage, &files, current.as_ref(), &workspace)?;
        if let Some(terminal) = app.try_state::<experiments::terminal::TerminalState>() {
            terminal.protect(current.as_ref(), Some(&workspace))?;
        }
        if let Some(python) = app.try_state::<experiments::python::PythonState>() {
            python.protect(current.as_ref(), Some(&workspace))?;
        }
        app.state::<agent::AgentState>().protect(
            storage.load()?.as_ref(),
            Some(&workspace),
            None,
        )?;
        app.state::<experiments::ExperimentState>()
            .protect(storage.load()?.as_ref(), Some(&workspace))?;
        storage.save(workspace, expected_revision)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn workspace_restore(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let storage = state.storage.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<agent::AgentState>().protect(None, None, None)?;
        app.state::<experiments::ExperimentState>()
            .protect(None, None)?;
        if let Some(terminal) = app.try_state::<experiments::terminal::TerminalState>() {
            terminal.protect(None, None)?;
        }
        if let Some(python) = app.try_state::<experiments::python::PythonState>() {
            python.protect(None, None)?;
        }
        storage.restore()
    })
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
        app.state::<agent::AgentState>().protect(None, None, None)?;
        app.state::<experiments::ExperimentState>()
            .protect(None, None)?;
        if let Some(terminal) = app.try_state::<experiments::terminal::TerminalState>() {
            terminal.protect(None, None)?;
        }
        if let Some(python) = app.try_state::<experiments::python::PythonState>() {
            python.protect(None, None)?;
        }
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
    let mut context = tauri::generate_context!();
    // Resolve and migrate before WebView2 opens any profile in the old directory.
    context.config_mut().app.windows[0].create = false;
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
                if let Some(terminal) = window
                    .app_handle()
                    .try_state::<experiments::terminal::TerminalState>()
                {
                    terminal.close_all();
                }
                if let Some(python) = window
                    .app_handle()
                    .try_state::<experiments::python::PythonState>()
                {
                    python.stop_all();
                }
                windows::show_projects(window.app_handle());
            }
        })
        .setup(move |app| {
            let (directory, location) = data_location::prepare().map_err(|error| {
                rfd::MessageDialog::new()
                    .set_title("Scientify 数据位置")
                    .set_level(rfd::MessageLevel::Error)
                    .set_description(format!(
                        "{error}\n请确认安装目录可写、目标文件夹为空，且旧应用已关闭。"
                    ))
                    .show();
                std::io::Error::other(error)
            })?;
            let profile = location.container.join("ui-profile");
            app.manage(location);
            let legacy = app
                .path()
                .data_dir()?
                .join("scientify-desktop-sample/workspace");
            app.manage(library::LibraryState::new(directory.clone()));
            app.manage(agent::AgentState::default());
            app.manage(experiments::ExperimentState::new(
                directory.join("experiments"),
            ));
            app.manage(experiments::terminal::TerminalState::default());
            app.manage(experiments::python::PythonState::new(
                directory.join("environment-tasks"),
            ));
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
            }
            webview_profile::window(
                tauri::WebviewWindowBuilder::from_config(app, &app.config().app.windows[0])?,
                profile,
            )
            .map_err(std::io::Error::other)?
            .build()?;
            #[cfg(debug_assertions)]
            if isolated_smoke && std::env::var_os("SCIENTIFY_NATIVE_UI").is_none() {
                literature_smoke::start(app.handle().clone());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            library::library_choose,
            library::library_command,
            library::library_open,
            library::library_pdf,
            library::library_read_file,
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
            data_location::storage_location,
            data_location::storage_schedule,
            data_location::storage_cancel,
            research::research_list_files,
            research::research_read_file,
            research::research_write_file,
            research::research_import_pdf,
            research::research_read_pdf,
            research::research_git_status,
            research::research_git_diff,
            git::code_git_inspect,
            git::code_git_diff,
            git::code_git_action,
            experiments::experiment_start,
            experiments::catalog::experiment_prepare,
            experiments::trust::experiment_trust,
            experiments::python::python_command,
            experiments::terminal::terminal_command,
            experiments::terminal::development_snapshot,
            experiments::experiment_list,
            experiments::experiment_stop,
            experiments::experiment_log,
            experiments::experiment_artifacts,
            experiments::experiment_read_artifact,
            ai::research_ask_ai,
            ai::research_list_models,
            ai::research_test_model,
            research::research_fetch_arxiv,
            agent::agent_status,
            agent::agent_handshake,
            agent::agent_domains,
            agent::agent_start_thread,
            agent::agent_windows_sandbox_setup,
            agent::agent_start_turn,
            agent::agent_interrupt,
            agent::agent_events,
            agent::agent_respond,
            agent::agent_release,
            credentials::secret_save,
            credentials::secret_load,
            credentials::secret_clear,
        ])
        .run(context)
        .expect("Scientify failed to start");
}
