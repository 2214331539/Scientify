//! In-app updates. The updater plugin fetches the manifest and installs a
//! signed package; these commands tell the page whether this build has an
//! update address at all (only release builds do, see
//! `tauri.updater.conf.json`) and stop the helper processes before the
//! installer replaces their files.

use tauri::Manager;

/// Whether this build checks for updates: release builds carry the manifest
/// address, development builds don't.
#[tauri::command]
pub fn updates_configured(app: tauri::AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .is_some_and(|endpoints| !endpoints.is_empty())
}

/// Ends the Agent engines, terminals, Python checks, browser tabs and the
/// translation service, as closing the main window does. On Windows the
/// installer runs as soon as the app exits, so nothing may still hold a file
/// it overwrites.
#[tauri::command]
pub fn updates_prepare(app: tauri::AppHandle) {
    release_main_window(&app);
}

pub fn release_main_window(app: &tauri::AppHandle) {
    if let Some(agents) = app.try_state::<crate::agent::AgentState>() {
        agents.close_all();
    }
    if let Some(chat) = app.try_state::<crate::ai::stream::ChatState>() {
        chat.close_owner("main");
    }
    if let Some(papers) = app.try_state::<crate::agent::papers::PaperState>() {
        papers.close_owner("main");
    }
    crate::yita::stop(app);
    crate::browser::close_owner(app, "main");
    if let Some(terminal) = app.try_state::<crate::experiments::terminal::TerminalState>() {
        terminal.close_all();
    }
    if let Some(python) = app.try_state::<crate::experiments::python::PythonState>() {
        python.stop_all();
    }
}
