use scientify_core::storage_location::{Location, Locator};
use std::path::{Path, PathBuf};
use tauri::{Manager, State};

pub struct DataLocation {
    pub locator: Option<Locator>,
    pub container: PathBuf,
}

fn installation_root(exe: &Path) -> Result<PathBuf, String> {
    let parent = exe.parent().ok_or("安装目录不可用")?;
    // Both ordinary and UI-shell builds belong to this checkout's installation.
    for candidate in parent.ancestors().take(5) {
        if candidate.join("Scientify-MVP.cmd").is_file()
            && candidate.join("src-tauri/tauri.conf.json").is_file()
        {
            return Ok(candidate.to_path_buf());
        }
    }
    Ok(parent.to_path_buf())
}

pub fn production_locator() -> Result<Locator, String> {
    let installation = installation_root(&std::env::current_exe().map_err(|e| e.to_string())?)?;
    let roaming = std::env::var_os("APPDATA").ok_or("无法定位旧数据目录")?;
    let local = std::env::var_os("LOCALAPPDATA").ok_or("无法定位旧缓存目录")?;
    Ok(Locator::new(
        installation,
        PathBuf::from(roaming).join("com.scientify.desktop"),
        PathBuf::from(local).join("com.scientify.desktop"),
    ))
}

pub fn prepare() -> Result<(PathBuf, DataLocation), String> {
    #[cfg(debug_assertions)]
    {
        let directory = std::env::var_os("SCIENTIFY_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .unwrap()
                    .join(".tauri-data/workspace")
            });
        Ok((
            directory.clone(),
            DataLocation {
                locator: None,
                container: directory.parent().ok_or("数据目录无效")?.to_path_buf(),
            },
        ))
    }
    #[cfg(not(debug_assertions))]
    {
        let locator = production_locator()?;
        let location = locator.prepare()?;
        Ok((
            location.directory.join("workspace"),
            DataLocation {
                locator: Some(locator),
                container: location.directory,
            },
        ))
    }
}

#[tauri::command]
pub fn storage_location(state: State<'_, DataLocation>) -> Result<Location, String> {
    match &state.locator {
        Some(locator) => locator.location(),
        None => Ok(Location {
            directory: state.container.clone(),
            pending: None,
            cleanup: vec![],
        }),
    }
}

#[tauri::command]
pub async fn storage_schedule<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, DataLocation>,
    directory: String,
) -> Result<Location, String> {
    let locator = state
        .locator
        .as_ref()
        .ok_or("开发版使用隔离数据目录，请在正式版更改存储位置。")?;
    // This schedules a future move; it never swaps live services or saved drafts.
    app.state::<crate::agent::AgentState>()
        .protect(None, None, None)?;
    app.state::<crate::experiments::ExperimentState>()
        .protect(None, None)?;
    if let Some(terminal) = app.try_state::<crate::experiments::terminal::TerminalState>() {
        terminal.protect(None, None)?;
    }
    if let Some(python) = app.try_state::<crate::experiments::python::PythonState>() {
        python.protect(None, None)?;
    }
    locator.schedule(&state.container, Path::new(&directory))
}

#[tauri::command]
pub fn storage_cancel(state: State<'_, DataLocation>) -> Result<Location, String> {
    state
        .locator
        .as_ref()
        .ok_or("开发版使用隔离数据目录。")?
        .cancel()
}

pub fn migrate_offline() -> Result<(), String> {
    production_locator()?.prepare().map(|_| ())
}
