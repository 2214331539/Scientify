use super::{python, trust};
use crate::{agent::process::EventSink, AppState};
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, VecDeque},
    io::Write,
    sync::{Arc, Mutex},
    time::Instant,
};
use tauri::{Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub project: String,
    pub experiment_id: String,
    pub root: String,
    pub name: String,
    pub profile: String,
    pub environment: Option<python::Interpreter>,
    pub status: String,
    pub exit_code: Option<u32>,
}
struct Output {
    bytes: VecDeque<u8>,
    end: u64,
    drained: bool,
}
struct Controls {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    #[cfg(windows)]
    job: crate::experiments::runner::job::Job,
}
struct Terminal {
    info: Mutex<TerminalInfo>,
    output: Mutex<Output>,
    controls: Mutex<Option<Controls>>,
}
impl Terminal {
    fn close(&self) {
        if let Ok(mut controls) = self.controls.lock() {
            if let Some(mut owned) = controls.take() {
                #[cfg(windows)]
                let _ = owned.job.terminate();
                let _ = owned.killer.kill();
            }
        }
    }
}
impl Drop for Terminal {
    fn drop(&mut self) {
        self.close();
    }
}
#[derive(Default)]
pub struct TerminalState {
    entries: Mutex<BTreeMap<String, Arc<Terminal>>>,
}

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase")]
pub enum Action {
    List,
    Open {
        #[serde(rename = "experimentId")]
        experiment_id: String,
        profile: String,
        path: Option<String>,
        args: Option<Vec<String>>,
    },
    Read {
        id: String,
        offset: u64,
    },
    Input {
        id: String,
        data: String,
    },
    Resize {
        id: String,
        rows: u16,
        cols: u16,
    },
    Close {
        id: String,
    },
}
impl TerminalState {
    pub fn list(&self) -> Result<Vec<TerminalInfo>, String> {
        self.entries
            .lock()
            .map_err(|e| e.to_string())?
            .values()
            .map(|entry| {
                entry
                    .info
                    .lock()
                    .map(|i| i.clone())
                    .map_err(|e| e.to_string())
            })
            .collect()
    }
    pub fn protect(&self, old: Option<&Value>, next: Option<&Value>) -> Result<(), String> {
        for info in self.list()?.into_iter().filter(|i| i.status == "running") {
            let keeps = match (old, next) {
                (Some(old), Some(next)) => {
                    super::catalog::keeps_binding(old, next, Some(&info.experiment_id))
                        && old["projects"]
                            .as_array()
                            .and_then(|p| p.iter().find(|p| p["id"] == info.project))
                            .map(|p| (&p["path"], &p["repo"]))
                            == next["projects"]
                                .as_array()
                                .and_then(|p| p.iter().find(|p| p["id"] == info.project))
                                .map(|p| (&p["path"], &p["repo"]))
                }
                _ => false,
            };
            if !keeps {
                return Err("请先关闭此实验的终端，再移除实验、更换目录或迁移数据。".into());
            }
        }
        Ok(())
    }
    pub fn close_all(&self) {
        if let Ok(mut entries) = self.entries.lock() {
            for entry in entries.values() {
                entry.close();
            }
            entries.clear();
        }
    }
    fn entry(&self, project: &str, id: &str) -> Result<Arc<Terminal>, String> {
        let entry = self
            .entries
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or("终端已关闭。")?;
        if entry.info.lock().map_err(|e| e.to_string())?.project != project {
            return Err("终端不属于此项目。".into());
        }
        Ok(entry)
    }
    pub(crate) fn open(
        &self,
        info: TerminalInfo,
        program: &std::path::Path,
        args: &[String],
        env: &BTreeMap<String, String>,
        sink: Option<EventSink>,
    ) -> Result<TerminalInfo, String> {
        let mut entries = self.entries.lock().map_err(|e| e.to_string())?;
        let lease = if info.profile == "python"
            && args.first().is_some_and(|a| a == "-u")
            && args.get(1).is_some_and(|a| a != "-i")
        {
            Some(crate::code::Lease::run(std::path::Path::new(&info.root))?)
        } else {
            None
        };
        if entries.len() >= 32 {
            return Err("最多保留 32 个终端，请关闭不再使用的终端。".into());
        }
        let pair = native_pty_system()
            .openpty(PtySize::default())
            .map_err(|e| e.to_string())?;
        let mut command = CommandBuilder::new(crate::local_process::process_path(program));
        command.args(args);
        command.cwd(crate::local_process::process_path(std::path::Path::new(
            &info.root,
        )));
        for (key, value) in env {
            command.env(key, value);
        }
        command.env("TERM", "xterm-256color");
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|e| e.to_string())?;
        drop(pair.slave);
        #[cfg(windows)]
        let job = match child
            .as_raw_handle()
            .ok_or_else(|| "终端进程句柄不可用。".to_string())
            .and_then(crate::experiments::runner::job::Job::attach_pty)
        {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                return Err(error);
            }
        };
        let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
        let entry = Arc::new(Terminal {
            info: Mutex::new(info.clone()),
            output: Mutex::new(Output {
                bytes: VecDeque::new(),
                end: 0,
                drained: false,
            }),
            controls: Mutex::new(Some(Controls {
                master: pair.master,
                writer,
                killer: child.clone_killer(),
                #[cfg(windows)]
                job,
            })),
        });
        entries.insert(info.id.clone(), entry.clone());
        let copy = entry.clone();
        let output_sink = sink.clone();
        let id = info.id.clone();
        std::thread::spawn(move || {
            use std::io::Read;
            let mut reader = reader;
            let mut bytes = [0; 8192];
            let mut last = Instant::now();
            while let Ok(n) = reader.read(&mut bytes) {
                if n == 0 {
                    break;
                }
                if let Ok(mut output) = copy.output.lock() {
                    output.bytes.extend(&bytes[..n]);
                    output.end += n as u64;
                    let remove = output.bytes.len().saturating_sub(2 * 1024 * 1024);
                    output.bytes.drain(..remove);
                }
                if last.elapsed().as_millis() >= 16 {
                    if let Some(sink) = &output_sink {
                        sink(json!({"id":id}));
                    }
                    last = Instant::now();
                }
            }
            if let Ok(mut output) = copy.output.lock() {
                output.drained = true;
            }
            if let Some(sink) = &output_sink {
                sink(json!({"id":id}));
            }
        });
        let id = info.id.clone();
        std::thread::spawn(move || {
            let _lease = lease;
            let result = child.wait();
            if let Ok(mut info) = entry.info.lock() {
                info.status = "exited".into();
                info.exit_code = result.ok().map(|s| s.exit_code());
            }
            entry.close();
            if let Some(sink) = &sink {
                sink(json!({"id":id}));
            }
        });
        Ok(info)
    }
    fn control(&self, project: &str, action: Action) -> Result<Value, String> {
        match action {
            Action::List => serde_json::to_value(
                self.list()?
                    .into_iter()
                    .filter(|i| i.project == project)
                    .collect::<Vec<_>>(),
            )
            .map_err(|e| e.to_string()),
            Action::Read { id, offset } => {
                let entry = self.entry(project, &id)?;
                let output = entry.output.lock().map_err(|e| e.to_string())?;
                let start = output.end - output.bytes.len() as u64;
                let at = offset.clamp(start, output.end);
                let bytes = output
                    .bytes
                    .iter()
                    .skip((at - start) as usize)
                    .take(256 * 1024)
                    .copied()
                    .collect::<Vec<_>>();
                let done = output.drained
                    && entry.info.lock().map_err(|e| e.to_string())?.status != "running";
                Ok(
                    json!({"data":base64::engine::general_purpose::STANDARD.encode(&bytes),"offset":at+bytes.len() as u64,"end":output.end,"truncated":offset<start,"done":done}),
                )
            }
            Action::Input { id, data } => {
                if data.len() > 64 * 1024 {
                    return Err("终端输入过大。".into());
                }
                let entry = self.entry(project, &id)?;
                let mut controls = entry.controls.lock().map_err(|e| e.to_string())?;
                let writer = &mut controls.as_mut().ok_or("终端进程已退出。")?.writer;
                writer
                    .write_all(data.as_bytes())
                    .and_then(|()| writer.flush())
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            Action::Resize { id, rows, cols } => {
                let entry = self.entry(project, &id)?;
                let controls = entry.controls.lock().map_err(|e| e.to_string())?;
                if let Some(controls) = controls.as_ref() {
                    controls
                        .master
                        .resize(PtySize {
                            rows: rows.clamp(2, 300),
                            cols: cols.clamp(2, 500),
                            pixel_width: 0,
                            pixel_height: 0,
                        })
                        .map_err(|e| e.to_string())?;
                }
                Ok(Value::Null)
            }
            Action::Close { id } => {
                let entry = self.entry(project, &id)?;
                entry.close();
                self.entries.lock().map_err(|e| e.to_string())?.remove(&id);
                Ok(Value::Null)
            }
            Action::Open { .. } => Err("无效终端操作。".into()),
        }
    }
}
impl Drop for TerminalState {
    fn drop(&mut self) {
        self.close_all();
    }
}

#[tauri::command]
pub fn development_snapshot<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    terminals: State<'_, TerminalState>,
    python: State<'_, python::PythonState>,
) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    Ok(json!({"terminals": terminals.list()?, "tasks": python.list()?}))
}

#[tauri::command]
pub async fn terminal_command<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    project_id: String,
    request: Action,
) -> Result<Value, String> {
    crate::library::trusted(&view)?;
    let storage = state.storage.clone();
    let files = state.files.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Action::Open {
            experiment_id,
            profile,
            path,
            args,
        } = request
        {
            let (root, experiment) = trust::context(&storage, &files, &project_id, &experiment_id)?;
            trust::require(&storage, &root)?;
            let interpreter = python::bound(&storage, &root, &experiment)?;
            let env = python::environment(&storage, interpreter.as_ref())?;
            let (program, args, name) = match profile.as_str() {
                "powershell" => (
                    python::find_program("powershell")?,
                    vec!["-NoLogo".into(), "-NoProfile".into()],
                    "PowerShell".into(),
                ),
                "pwsh" => (
                    python::find_program("pwsh")?,
                    vec!["-NoLogo".into(), "-NoProfile".into()],
                    "PowerShell 7".into(),
                ),
                "cmd" => (
                    python::find_program("cmd")?,
                    vec!["/D".into()],
                    "Command Prompt".into(),
                ),
                "python" => {
                    let python = interpreter.as_ref().ok_or("请选择 Python 解释器。")?;
                    let mut argv = vec!["-u".into()];
                    if let Some(path) = path {
                        let file = super::confined(&root, &path)?;
                        if !file.is_file() || !path.ends_with(".py") {
                            return Err("请选择工作区中的 Python 文件。".into());
                        }
                        argv.push(path);
                    } else {
                        argv.push("-i".into());
                    }
                    let extra = args.unwrap_or_default();
                    if extra.len() > 128 || extra.iter().any(|a| a.len() > 8192 || a.contains('\0'))
                    {
                        return Err("参数无效。".into());
                    }
                    argv.extend(extra);
                    (
                        std::path::PathBuf::from(&python.executable),
                        argv,
                        "Python".into(),
                    )
                }
                #[cfg(not(windows))]
                "bash" => (python::find_program("bash")?, vec![], "bash".into()),
                _ => return Err("不支持的终端类型。".into()),
            };
            let copy = app.clone();
            let info = app.state::<TerminalState>().open(
                TerminalInfo {
                    id: uuid::Uuid::new_v4().to_string(),
                    project: project_id,
                    experiment_id,
                    root: root.display().to_string(),
                    name,
                    profile,
                    environment: interpreter,
                    status: "running".into(),
                    exit_code: None,
                },
                &program,
                &args,
                &env,
                Some(Arc::new(move |value| {
                    let _ = tauri::Emitter::emit(&copy, "terminal-event", value);
                })),
            )?;
            serde_json::to_value(info).map_err(|e| e.to_string())
        } else {
            app.state::<TerminalState>().control(&project_id, request)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
