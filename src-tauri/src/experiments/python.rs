use super::trust;
use crate::{agent::process::EventSink, local_process, AppState};
use scientify_core::storage::Storage;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, State};

#[derive(Clone, Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Interpreter {
    pub executable: String,
    pub version: String,
    pub prefix: String,
    pub manager: String,
}
pub(crate) fn same_environment(a: &str, b: &str) -> bool {
    let normalize = |value: &str| {
        let path = Path::new(value);
        local_process::process_path(&path.canonicalize().unwrap_or_else(|_| path.to_path_buf()))
    };
    let a = normalize(a);
    let b = normalize(b);
    if cfg!(windows) {
        a.to_string_lossy()
            .eq_ignore_ascii_case(&b.to_string_lossy())
    } else {
        a == b
    }
}

pub(crate) fn find_program(name: &str) -> Result<PathBuf, String> {
    let names = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_owned()]
    } else {
        vec![name.to_owned()]
    };
    for directory in program_directories() {
        if !directory.is_absolute() || directory.to_string_lossy().contains("WindowsApps") {
            continue;
        }
        for name in &names {
            let file = directory.join(name);
            if executable_file(&file) {
                return Ok(file);
            }
        }
    }
    Err(format!("找不到 {name}，请检查安装及 PATH。"))
}
fn executable_file(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        return path
            .metadata()
            .is_ok_and(|m| m.permissions().mode() & 0o111 != 0);
    }
    #[cfg(not(unix))]
    true
}
fn program_directories() -> Vec<PathBuf> {
    #[allow(unused_mut)]
    let mut paths: Vec<_> =
        std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()).collect();
    #[cfg(target_os = "macos")]
    {
        paths.extend(
            [
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
                "/bin",
                "/opt/anaconda3/bin",
                "/opt/miniconda3/bin",
                "/opt/homebrew/Caskroom/miniforge/base/bin",
            ]
            .map(PathBuf::from),
        );
        if let Some(home) = dirs::home_dir() {
            paths.extend(
                [
                    "miniforge3/bin",
                    "miniconda3/bin",
                    "anaconda3/bin",
                    "opt/anaconda3/bin",
                ]
                .map(|p| home.join(p)),
            );
        }
    }
    paths
}
fn conda_program() -> Result<PathBuf, String> {
    if let Some(value) = std::env::var_os("CONDA_EXE") {
        let path = PathBuf::from(value);
        if path.is_absolute()
            && executable_file(&path)
            && (!cfg!(windows) || path.extension().is_some_and(|e| e == "exe"))
        {
            return Ok(path);
        }
    }
    if let Ok(path) = find_program("conda") {
        return Ok(path);
    }
    for dir in program_directories() {
        if let Some(parent) = dir.parent() {
            let path = parent.join(if cfg!(windows) {
                "Scripts/conda.exe"
            } else {
                "bin/conda"
            });
            if executable_file(&path) {
                return Ok(path);
            }
        }
    }
    Err("未检测到已安装的 Conda，请选择 venv 或已有解释器。".into())
}
fn python_at(prefix: &Path) -> PathBuf {
    prefix.join(if cfg!(windows) {
        "Scripts/python.exe"
    } else {
        "bin/python"
    })
}
pub(crate) fn inspect(executable: &str) -> Result<Interpreter, String> {
    let path = Path::new(executable);
    if !path.is_absolute()
        || !path.is_file()
        || executable.len() > 4096
        || executable.contains('\0')
    {
        return Err("Python 解释器必须是可访问的绝对路径。".into());
    }
    let mut command = Command::new(local_process::process_path(path));
    command.args(["-I","-c","import sys,json; print(json.dumps({'executable':sys.executable,'version':'.'.join(map(str,sys.version_info[:3])),'prefix':sys.prefix,'base':sys.base_prefix}))"]);
    let result: Value = serde_json::from_slice(&local_process::capture(
        &mut command,
        Duration::from_secs(12),
    )?)
    .map_err(|e| format!("解释器检测失败：{e}"))?;
    let prefix = result["prefix"].as_str().ok_or("Python 缺少 prefix。")?;
    let manager = if Path::new(prefix).join("conda-meta").is_dir() {
        "conda"
    } else if result["prefix"] != result["base"] {
        "venv"
    } else {
        "system"
    };
    Ok(Interpreter {
        executable: result["executable"]
            .as_str()
            .ok_or("Python 缺少 executable。")?
            .into(),
        version: result["version"]
            .as_str()
            .ok_or("Python 版本无效。")?
            .into(),
        prefix: prefix.into(),
        manager: manager.into(),
    })
}
pub(crate) fn bound(
    _storage: &Storage,
    _root: &Path,
    experiment: &Value,
) -> Result<Option<Interpreter>, String> {
    let Some(binding) = experiment.get("python").filter(|v| !v.is_null()) else {
        return Ok(None);
    };
    inspect(
        binding["executable"]
            .as_str()
            .ok_or("已选择的 Python 路径无效，请重新选择。")?,
    )
    .map(Some)
}
pub(crate) fn execution_interpreter(
    storage: &Storage,
    root: &Path,
    binding: Option<&Value>,
    executable: &mut String,
) -> Result<Option<Interpreter>, String> {
    if matches!(executable.as_str(), "python" | "python3" | "python.exe") {
        let interpreter = binding
            .map(|e| bound(storage, root, e))
            .transpose()?
            .flatten()
            .ok_or("请选择此实验的 Python 解释器。")?;
        *executable = interpreter.executable.clone();
        return Ok(Some(interpreter));
    }
    let filename = Path::new(executable)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if matches!(
        filename.as_str(),
        "python" | "python3" | "python.exe" | "python3.exe"
    ) {
        let path = super::resolve_program(root, executable)?;
        let interpreter = inspect(&local_process::process_path(&path).display().to_string())?;
        *executable = interpreter.executable.clone();
        return Ok(Some(interpreter));
    }
    binding
        .map(|e| bound(storage, root, e))
        .transpose()
        .map(Option::flatten)
}
pub(crate) fn environment(
    storage: &Storage,
    interpreter: Option<&Interpreter>,
) -> Result<BTreeMap<String, String>, String> {
    let container = storage.directory().parent().ok_or("数据目录无效。")?;
    let mut env = BTreeMap::new();
    for (key, relative) in [
        ("PIP_CACHE_DIR", "cache/pip"),
        ("UV_CACHE_DIR", "cache/uv"),
        ("CONDA_PKGS_DIRS", "cache/conda"),
        ("TEMP", "tmp"),
        ("TMP", "tmp"),
        ("TMPDIR", "tmp"),
    ] {
        let path = container.join(relative);
        scientify_core::research::reject_links(&path)?;
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        env.insert(
            key.into(),
            local_process::process_path(&path).display().to_string(),
        );
    }
    env.insert("PYTHONUNBUFFERED".into(), "1".into());
    env.insert("PIP_DISABLE_PIP_VERSION_CHECK".into(), "1".into());
    if let Some(info) = interpreter {
        let prefix = Path::new(&info.prefix);
        let mut paths = vec![
            prefix.join(if cfg!(windows) { "Scripts" } else { "bin" }),
            prefix.to_path_buf(),
        ];
        if info.manager == "conda" && cfg!(windows) {
            paths.extend([
                prefix.join("Library/bin"),
                prefix.join("Library/usr/bin"),
                prefix.join("Library/mingw-w64/bin"),
            ]);
        }
        paths.extend(std::env::split_paths(
            &std::env::var_os("PATH").unwrap_or_default(),
        ));
        let paths = paths
            .iter()
            .map(|p| local_process::process_path(p))
            .collect::<Vec<_>>();
        env.insert(
            "PATH".into(),
            std::env::join_paths(paths)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into(),
        );
        if info.manager == "venv" {
            env.insert("VIRTUAL_ENV".into(), info.prefix.clone());
        }
        if info.manager == "conda" {
            env.insert("CONDA_PREFIX".into(), info.prefix.clone());
            env.insert("CONDA_DEFAULT_ENV".into(), info.prefix.clone());
        }
    }
    Ok(env)
}
fn discover(root: &Path) -> Vec<Interpreter> {
    let mut candidates = BTreeSet::new();
    for folder in [".venv", "venv", ".conda"] {
        let prefix = root.join(folder);
        let path = if prefix.join("conda-meta").exists() && cfg!(windows) {
            prefix.join("python.exe")
        } else {
            python_at(&prefix)
        };
        if path.is_file() {
            candidates.insert(local_process::process_path(&path).display().to_string());
        }
    }
    for name in ["python", "python3"] {
        if let Ok(path) = find_program(name) {
            candidates.insert(path.display().to_string());
        }
    }
    if let Ok(py) = find_program("py") {
        let mut command = Command::new(py);
        command.arg("-0p");
        if let Ok(output) = local_process::capture(&mut command, Duration::from_secs(8)) {
            for line in String::from_utf8_lossy(&output).lines() {
                if let Some(index) = line.find(":\\").and_then(|i| i.checked_sub(1)) {
                    let path = line[index..].trim();
                    if Path::new(path).is_file() {
                        candidates.insert(path.into());
                    }
                }
            }
        }
    }
    if let Ok(conda) = conda_program() {
        let mut command = Command::new(conda);
        command.args(["env", "list", "--json"]);
        if let Ok(output) = local_process::capture(&mut command, Duration::from_secs(12)) {
            if let Ok(data) = serde_json::from_slice::<Value>(&output) {
                for prefix in data["envs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                {
                    let path = Path::new(prefix).join(if cfg!(windows) {
                        "python.exe"
                    } else {
                        "bin/python"
                    });
                    if path.is_file() {
                        candidates.insert(path.display().to_string());
                    }
                }
            }
        }
    }
    let mut result = Vec::new();
    let mut seen = BTreeSet::new();
    for candidate in candidates.into_iter().take(32) {
        if let Ok(info) = inspect(&candidate) {
            if seen.insert(info.executable.to_lowercase()) {
                result.push(info);
            }
        }
    }
    result
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentTask {
    pub id: String,
    pub project: String,
    pub experiment_id: String,
    pub root: String,
    pub kind: String,
    pub command: Vec<String>,
    pub prefix: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub error: Option<String>,
    pub environment: Option<Interpreter>,
    pub started_at: u64,
}
struct Entry {
    task: Mutex<EnvironmentTask>,
    cancel: AtomicBool,
}
pub struct PythonState {
    directory: PathBuf,
    entries: Mutex<BTreeMap<String, Arc<Entry>>>,
}
impl PythonState {
    pub fn new(directory: PathBuf) -> Self {
        let mut entries = BTreeMap::new();
        if let Ok(files) = std::fs::read_dir(&directory) {
            for file in files.flatten() {
                let path = file.path().join("record.json");
                if scientify_core::research::reject_links(&path).is_err()
                    || !std::fs::metadata(&path).is_ok_and(|m| m.len() < 256 * 1024)
                {
                    continue;
                }
                if let Ok(bytes) = std::fs::read(&path) {
                    if let Ok(mut task) = serde_json::from_slice::<EnvironmentTask>(&bytes) {
                        if uuid::Uuid::parse_str(&task.id).is_err()
                            || file.file_name().to_str() != Some(&task.id)
                        {
                            continue;
                        }
                        if task.status == "running" {
                            task.status = "interrupted".into();
                            task.error = Some("应用退出时任务未完成，未自动重启。".into());
                        }
                        entries.insert(
                            task.id.clone(),
                            Arc::new(Entry {
                                task: Mutex::new(task),
                                cancel: AtomicBool::new(false),
                            }),
                        );
                    }
                }
            }
        }
        Self {
            directory,
            entries: Mutex::new(entries),
        }
    }
    pub fn list(&self) -> Result<Vec<EnvironmentTask>, String> {
        self.entries
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .map(|e| e.task.lock().map(|t| t.clone()).map_err(|e| e.to_string()))
            .collect()
    }
    pub fn protect(&self, old: Option<&Value>, next: Option<&Value>) -> Result<(), String> {
        for task in self.list()?.into_iter().filter(|t| t.status == "running") {
            if !matches!((old,next),(Some(a),Some(b)) if super::catalog::keeps_binding(a,b,Some(&task.experiment_id)) && a["projects"].as_array().and_then(|ps|ps.iter().find(|p|p["id"]==task.project)).map(|p|(&p["path"],&p["repo"])) == b["projects"].as_array().and_then(|ps|ps.iter().find(|p|p["id"]==task.project)).map(|p|(&p["path"],&p["repo"])))
            {
                return Err("请先停止环境任务，再移除实验、更换目录或迁移数据。".into());
            }
        }
        Ok(())
    }
    pub fn stop_all(&self) {
        if let Ok(entries) = self.entries.lock() {
            for e in entries.values() {
                e.cancel.store(true, Ordering::SeqCst);
            }
        }
    }
    fn start(
        &self,
        task: EnvironmentTask,
        program: PathBuf,
        args: Vec<String>,
        env: BTreeMap<String, String>,
        check: Option<PathBuf>,
        sink: EventSink,
    ) -> Result<EnvironmentTask, String> {
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        if entries
            .values()
            .filter(|e| e.task.lock().is_ok_and(|t| t.status == "running"))
            .count()
            >= 8
        {
            return Err("最多同时运行 8 个环境任务，请等待或停止已有任务。".into());
        }
        if entries.values().any(|e| {
            e.task.lock().is_ok_and(|t| {
                t.status == "running"
                    && (same_environment(&t.prefix, &task.prefix)
                        || t.experiment_id == task.experiment_id)
            })
        }) {
            return Err("此环境或实验已有准备任务，请等待或停止后重试。".into());
        }
        let root = PathBuf::from(&task.root);
        let lease = crate::code::Lease::run(&root)?;
        let directory = self.directory.join(&task.id);
        scientify_core::research::reject_links(&directory)?;
        std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
        std::fs::write(
            directory.join("record.json"),
            serde_json::to_vec(&task).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let log = directory.join("output.log");
        std::fs::write(
            &log,
            format!(
                "{}\n",
                serde_json::to_string(&task.command).map_err(|e| e.to_string())?
            ),
        )
        .map_err(|e| e.to_string())?;
        let entry = Arc::new(Entry {
            task: Mutex::new(task.clone()),
            cancel: AtomicBool::new(false),
        });
        entries.insert(task.id.clone(), entry.clone());
        std::thread::spawn(move || {
            let _lease = lease;
            let id = entry.task.lock().unwrap().id.clone();
            let result = local_process::run_logged(
                &program,
                &args,
                &root,
                &env,
                &log,
                &entry.cancel,
                || sink(json!({"id":id})),
            );
            let verified = if !entry.cancel.load(Ordering::SeqCst) && matches!(result, Ok(0)) {
                check.map(|path| inspect(&local_process::process_path(&path).display().to_string()))
            } else {
                None
            };
            let mut info = entry.task.lock().unwrap();
            info.exit_code = result.as_ref().ok().copied();
            info.status = if entry.cancel.load(Ordering::SeqCst) {
                "cancelled"
            } else if matches!(result, Ok(0)) {
                "completed"
            } else {
                "failed"
            }
            .into();
            info.error = result.err();
            if info.status == "completed" {
                if let Some(verified) = verified {
                    match verified {
                        Ok(environment) => info.environment = Some(environment),
                        Err(error) => {
                            info.status = "failed".into();
                            info.error = Some(error);
                        }
                    }
                }
            }
            if let Some(error) = &info.error {
                local_process::append_error(&log, error);
            }
            let _ = std::fs::write(
                directory.join("record.json"),
                serde_json::to_vec(&*info).unwrap_or_default(),
            );
            drop(info);
            sink(json!({"id":id}));
        });
        Ok(task)
    }
    fn entry(&self, project: &str, id: &str) -> Result<Arc<Entry>, String> {
        let entry = self
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or("环境任务不存在。")?;
        if entry.task.lock().map_err(|e| e.to_string())?.project != project {
            return Err("环境任务不属于此项目。".into());
        }
        Ok(entry)
    }
}
impl Drop for PythonState {
    fn drop(&mut self) {
        self.stop_all();
    }
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Action {
    Discover,
    Inspect {
        executable: String,
    },
    Packages,
    Start {
        kind: String,
        base: Option<String>,
        target: Option<String>,
        packages: Option<Vec<String>>,
        #[serde(rename = "pythonVersion")]
        python_version: Option<String>,
    },
    Tasks {
        all: Option<bool>,
    },
    Log {
        id: String,
    },
    Stop {
        id: String,
    },
}
#[tauri::command]
pub async fn python_command<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    project_id: String,
    experiment_id: String,
    request: Action,
) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    let storage = state.storage.clone();
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let tasks = app.state::<PythonState>();
        if let Action::Tasks { all } = request {
            return serde_json::to_value(
                tasks
                    .list()?
                    .into_iter()
                    .filter(|t| {
                        t.project == project_id
                            && (all == Some(true) || t.experiment_id == experiment_id)
                    })
                    .collect::<Vec<_>>(),
            )
            .map_err(|e| e.to_string());
        }
        if let Action::Stop { id } = request {
            tasks
                .entry(&project_id, &id)?
                .cancel
                .store(true, Ordering::SeqCst);
            return Ok(Value::Null);
        }
        if let Action::Log { id } = request {
            let _ = tasks.entry(&project_id, &id)?;
            let file = tasks.directory.join(id).join("output.log");
            scientify_core::research::reject_links(&file)?;
            use std::io::{Read, Seek, SeekFrom};
            let mut file = std::fs::File::open(file).map_err(|e| e.to_string())?;
            let size = file.metadata().map_err(|e| e.to_string())?.len();
            file.seek(SeekFrom::Start(size.saturating_sub(2 * 1024 * 1024)))
                .map_err(|e| e.to_string())?;
            let mut bytes = Vec::new();
            file.take(2 * 1024 * 1024)
                .read_to_end(&mut bytes)
                .map_err(|e| e.to_string())?;
            return Ok(json!(String::from_utf8_lossy(&bytes)));
        }
        let (root, experiment) = trust::context(&storage, &files, &project_id, &experiment_id)?;
        trust::require(&storage, &root)?;
        match request {
            Action::Discover => {
                Ok(json!({"interpreters":discover(&root),"condaAvailable":conda_program().is_ok()}))
            }
            Action::Inspect { executable } => {
                serde_json::to_value(inspect(&executable)?).map_err(|e| e.to_string())
            }
            Action::Packages => {
                let interpreter =
                    bound(&storage, &root, &experiment)?.ok_or("请选择 Python 解释器。")?;
                let mut command = Command::new(&interpreter.executable);
                command
                    .args(["-m", "pip", "list", "--format=json"])
                    .envs(environment(&storage, Some(&interpreter))?);
                serde_json::from_slice(&local_process::capture(
                    &mut command,
                    Duration::from_secs(20),
                )?)
                .map_err(|e| e.to_string())
            }
            Action::Start {
                kind,
                base,
                target,
                packages,
                python_version,
            } => {
                let selected = bound(&storage, &root, &experiment)?;
                let env = environment(&storage, selected.as_ref())?;
                let (program, args, prefix, check) = match kind.as_str() {
                    "venv" | "conda" => {
                        let prefix = super::confined(
                            &root,
                            target.as_deref().unwrap_or(if kind == "venv" {
                                ".venv"
                            } else {
                                ".conda"
                            }),
                        )?;
                        if prefix.exists() {
                            return Err(
                                "目标环境目录已经存在，请选择其他名称或使用已有解释器。".into()
                            );
                        }
                        let native = local_process::process_path(&prefix).display().to_string();
                        if kind == "venv" {
                            let base = inspect(base.as_deref().ok_or("请选择基础 Python。")?)?;
                            (
                                PathBuf::from(base.executable),
                                vec!["-m".into(), "venv".into(), native],
                                prefix.clone(),
                                Some(python_at(&prefix)),
                            )
                        } else {
                            let mut args = if root.join("environment.yml").is_file() {
                                vec![
                                    "env".into(),
                                    "create".into(),
                                    "--prefix".into(),
                                    native,
                                    "--file".into(),
                                    "environment.yml".into(),
                                    "--yes".into(),
                                ]
                            } else {
                                let version = python_version.unwrap_or("3.12".into());
                                if !version.chars().all(|c| c.is_ascii_digit() || c == '.')
                                    || version.len() > 20
                                {
                                    return Err("Python 版本无效。".into());
                                }
                                vec![
                                    "create".into(),
                                    "--prefix".into(),
                                    native,
                                    "--yes".into(),
                                    format!("python={version}"),
                                    "pip".into(),
                                ]
                            };
                            args.shrink_to_fit();
                            let check = prefix.join(if cfg!(windows) {
                                "python.exe"
                            } else {
                                "bin/python"
                            });
                            (conda_program()?, args, prefix, Some(check))
                        }
                    }
                    "requirements" | "editable" | "install" | "upgrade" | "uninstall"
                    | "condaUpdate" => {
                        let interpreter = selected.as_ref().ok_or("请选择 Python 解释器。")?;
                        if app
                            .try_state::<super::terminal::TerminalState>()
                            .is_some_and(|s| {
                                s.list().is_ok_and(|items| {
                                    items.iter().any(|t| {
                                        t.status == "running"
                                            && (t.experiment_id != experiment_id
                                                || t.profile == "python")
                                            && t.environment.as_ref().is_some_and(|e| {
                                                same_environment(&e.prefix, &interpreter.prefix)
                                            })
                                    })
                                })
                            })
                            || app
                                .state::<super::ExperimentState>()
                                .uses_environment(&interpreter.prefix)
                        {
                            return Err("此环境被活动任务使用，请停止相关任务后再修改依赖。".into());
                        }
                        let mut args = vec!["-m".into(), "pip".into()];
                        match kind.as_str() {
                            "requirements" => {
                                let name = target.unwrap_or("requirements.txt".into());
                                let path = super::confined(&root, &name)?;
                                if !path.is_file() {
                                    return Err("依赖文件不存在。".into());
                                }
                                args.extend(["install".into(), "-r".into(), name]);
                            }
                            "editable" => {
                                if !root.join("pyproject.toml").is_file()
                                    && !root.join("setup.py").is_file()
                                {
                                    return Err("目录中没有可安装的 Python 项目。".into());
                                }
                                args.extend(["install".into(), "-e".into(), ".".into()]);
                            }
                            "condaUpdate" => {
                                if interpreter.manager != "conda"
                                    || !root.join("environment.yml").is_file()
                                {
                                    return Err("请选用 Conda 环境及 environment.yml。".into());
                                }
                                return start_conda_update(
                                    &app,
                                    &tasks,
                                    &root,
                                    &project_id,
                                    &experiment_id,
                                    interpreter,
                                    env,
                                );
                            }
                            _ => {
                                let packages = packages.unwrap_or_default();
                                if packages.is_empty()
                                    || packages.len() > 64
                                    || packages.iter().any(|p| {
                                        p.is_empty()
                                            || p.starts_with('-')
                                            || p.len() > 1024
                                            || p.chars()
                                                .any(|c| c.is_control() || c.is_whitespace())
                                    })
                                {
                                    return Err(
                                        "请输入有效的包名称，每项不能以选项符号开头。".into()
                                    );
                                }
                                args.push(
                                    if kind == "uninstall" {
                                        "uninstall"
                                    } else {
                                        "install"
                                    }
                                    .into(),
                                );
                                if kind == "uninstall" {
                                    args.push("-y".into());
                                }
                                if kind == "upgrade" {
                                    args.push("--upgrade".into());
                                }
                                args.extend(packages);
                            }
                        }
                        (
                            PathBuf::from(&interpreter.executable),
                            args,
                            PathBuf::from(&interpreter.prefix),
                            None,
                        )
                    }
                    _ => return Err("不支持的环境任务。".into()),
                };
                let copy = app.clone();
                let mut command = vec![program.display().to_string()];
                command.extend(args.clone());
                let task = EnvironmentTask {
                    id: uuid::Uuid::new_v4().to_string(),
                    project: project_id,
                    experiment_id,
                    root: root.display().to_string(),
                    kind,
                    command,
                    prefix: prefix.display().to_string(),
                    status: "running".into(),
                    exit_code: None,
                    error: None,
                    environment: None,
                    started_at: super::now(),
                };
                serde_json::to_value(tasks.start(
                    task,
                    program,
                    args,
                    env,
                    check,
                    Arc::new(move |value| {
                        let _ = tauri::Emitter::emit(&copy, "python-event", value);
                    }),
                )?)
                .map_err(|e| e.to_string())
            }
            _ => Err("无效环境操作。".into()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
fn start_conda_update<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    tasks: &PythonState,
    root: &Path,
    project: &str,
    experiment: &str,
    interpreter: &Interpreter,
    env: BTreeMap<String, String>,
) -> Result<Value, String> {
    let program = conda_program()?;
    let args = vec![
        "env".into(),
        "update".into(),
        "--prefix".into(),
        interpreter.prefix.clone(),
        "--file".into(),
        "environment.yml".into(),
    ];
    let mut command = vec![program.display().to_string()];
    command.extend(args.clone());
    let copy = app.clone();
    let task = EnvironmentTask {
        id: uuid::Uuid::new_v4().to_string(),
        project: project.into(),
        experiment_id: experiment.into(),
        root: root.display().to_string(),
        kind: "condaUpdate".into(),
        command,
        prefix: interpreter.prefix.clone(),
        status: "running".into(),
        exit_code: None,
        error: None,
        environment: None,
        started_at: super::now(),
    };
    serde_json::to_value(tasks.start(
        task,
        program,
        args,
        env,
        None,
        Arc::new(move |value| {
            let _ = tauri::Emitter::emit(&copy, "python-event", value);
        }),
    )?)
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn failed_and_cancelled_tasks_never_publish_a_usable_environment() {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".test-artifacts/python-tasks");
        std::fs::create_dir_all(&directory).unwrap();
        let fixture = tempfile::tempdir_in(directory).unwrap();
        let root = fixture.path().join("code");
        std::fs::create_dir(&root).unwrap();
        let state = PythonState::new(fixture.path().join("tasks"));
        let task = || EnvironmentTask {
            id: uuid::Uuid::new_v4().to_string(),
            project: "p".into(),
            experiment_id: "e".into(),
            root: root.display().to_string(),
            kind: "venv".into(),
            command: vec![],
            prefix: root.join(".venv").display().to_string(),
            status: "running".into(),
            exit_code: None,
            error: None,
            environment: None,
            started_at: super::super::now(),
        };
        let wait = |id: &str| {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let current = state.entry("p", id).unwrap().task.lock().unwrap().clone();
                if current.status != "running" {
                    return current;
                }
                assert!(Instant::now() < deadline, "task did not finish");
                std::thread::sleep(Duration::from_millis(40));
            }
        };
        let missing = root.join("missing-python.exe");
        let failed = state
            .start(
                task(),
                missing.clone(),
                vec![],
                BTreeMap::new(),
                Some(missing),
                Arc::new(|_| {}),
            )
            .unwrap();
        let result = wait(&failed.id);
        assert_eq!(result.status, "failed");
        assert!(result.error.is_some());
        assert!(result.environment.is_none());

        let python = find_program("python").expect("native acceptance requires Python");
        let slow = state
            .start(
                task(),
                python.clone(),
                vec![
                    "-u".into(),
                    "-c".into(),
                    "import time; print('ready', flush=True); time.sleep(60)".into(),
                ],
                BTreeMap::new(),
                Some(python),
                Arc::new(|_| {}),
            )
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        let log = state.directory.join(&slow.id).join("output.log");
        while !std::fs::read_to_string(&log)
            .unwrap_or_default()
            .contains("ready")
        {
            assert!(Instant::now() < deadline, "process did not start");
            std::thread::sleep(Duration::from_millis(40));
        }
        state
            .entry("p", &slow.id)
            .unwrap()
            .cancel
            .store(true, Ordering::SeqCst);
        let result = wait(&slow.id);
        assert_eq!(result.status, "cancelled");
        assert!(result.environment.is_none());
        let persisted: EnvironmentTask = serde_json::from_slice(
            &std::fs::read(state.directory.join(&slow.id).join("record.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(persisted.status, "cancelled");
        assert!(persisted.environment.is_none());
        assert!(same_environment(
            root.to_str().unwrap(),
            root.join(".").to_str().unwrap()
        ));
    }
}
