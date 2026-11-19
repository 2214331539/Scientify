//! Full-text translation with BabelDOC (through pdf2zh-next): the translated PDF keeps
//! the original's layout, formulas and figures. The engine is Python, so the first
//! translation sets it up with the bundled uv: a private Python 3.11 and pinned
//! packages under `<data>/translator`. Papers are translated one at a time; the result
//! is `.scientify/translations/<fingerprint>.pdf` in the literature folder, so it
//! follows the PDF and syncs like the paper's record.
use crate::library::{project, trusted, LibraryState};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager, State};

const TARGET: &str = env!("SCIENTIFY_TARGET");
/// The engine as tested; changing it sets the engine up again.
const PACKAGES: [&str; 5] = [
    "pdf2zh-next==2.9.0",
    "babeldoc==0.6.2",
    "pymupdf==1.25.2",
    "uharfbuzz==0.55.0",
    "bitstring>=4.3,<5",
];
const STAMP: &str = "pdf2zh-next 2.9.0 / babeldoc 0.6.2 / 2";
const RUNNER: &str = include_str!("translator_run.py");
/// Mirrors reachable from mainland China, tried before the upstream defaults.
const PYTHON_MIRROR: &str = "https://registry.npmmirror.com/-/binary/python-build-standalone";
const PACKAGE_MIRROR: &str = "https://mirrors.aliyun.com/pypi/simple/";
const PROMPT: &str = "你是专业严谨的学术文献翻译引擎，把英文准确、通顺地译为简体中文。严格遵守以下规则：\
1) 作者姓名、机构名、期刊名、图/表编号、文献引用（如 Smith et al., 2015）一律保留英文原文，不要翻译；\
2) 基因/蛋白/通路符号、缩写、物种拉丁学名、计量单位保留原文；\
3) 术语前后保持一致；4) 保留所有公式、占位符、标签不变；5) 只输出译文，不要加任何解释或说明。";

/// The model a translation uses: the assistant's, as the settings name it.
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    provider: String,
    endpoint: String,
    model: String,
    #[serde(default)]
    api_key: String,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `idle`, `queued`, `preparing`, `translating`, `done` or `failed`.
    state: &'static str,
    /// 0–100 while translating.
    progress: f64,
    message: String,
}

impl Status {
    fn new(state: &'static str, progress: f64, message: impl Into<String>) -> Self {
        Self {
            state,
            progress,
            message: message.into(),
        }
    }
}

struct Job {
    project: String,
    paper: String,
    fingerprint: String,
    source: PathBuf,
    target: PathBuf,
    model: Model,
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Job>,
    statuses: HashMap<String, Status>,
    /// The paper being translated and the switch that stops it.
    running: Option<(String, Arc<AtomicBool>)>,
    worker: bool,
}

#[derive(Default)]
pub struct TranslatorState {
    inner: Mutex<Inner>,
}

/// The OpenAI-compatible address pdf2zh-next calls for a model.
pub(crate) fn base_url(model: &Model) -> Result<String, String> {
    let endpoint = model.endpoint.trim().trim_end_matches('/');
    let url = tauri::Url::parse(endpoint).map_err(|_| "模型地址无效。".to_string())?;
    let origin = url.origin().ascii_serialization();
    let path = url.path().trim_end_matches('/');
    Ok(match model.provider.as_str() {
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai".into(),
        "ollama" => format!("{origin}/v1"),
        _ => {
            let path = ["/chat/completions", "/responses", "/models", "/messages"]
                .iter()
                .find_map(|suffix| path.strip_suffix(suffix))
                .unwrap_or(path);
            format!("{origin}{}", if path.is_empty() { "/v1" } else { path })
        }
    })
}

fn bundled_uv() -> Option<PathBuf> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let suffixed = format!("uv-{TARGET}{suffix}");
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .map(|dir| [dir.join(format!("uv{suffix}")), dir.join(&suffixed)])
        .into_iter()
        .flatten();
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&suffixed);
    beside
        .chain(std::iter::once(development))
        .find(|path| path.is_file())
}

fn engine_python(base: &Path) -> PathBuf {
    if cfg!(windows) {
        base.join("env").join("Scripts").join("python.exe")
    } else {
        base.join("env").join("bin").join("python")
    }
}

fn quiet(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

/// Runs one uv step, first with the mirror in `mirror_env`, then once more without.
fn uv_step(
    uv: &Path,
    base: &Path,
    container: &Path,
    args: &[&str],
    mirror_env: (&str, &str),
) -> Result<(), String> {
    let mut last = String::new();
    for use_mirror in [true, false] {
        let mut command = Command::new(crate::local_process::process_path(uv));
        quiet(&mut command)
            .args(args)
            .env("UV_PYTHON_INSTALL_DIR", base.join("python"))
            .env("UV_CACHE_DIR", container.join("cache").join("uv"))
            .env("UV_NO_CONFIG", "1")
            .env("UV_LINK_MODE", "copy")
            .env_remove("VIRTUAL_ENV")
            .env_remove("CONDA_PREFIX");
        if use_mirror {
            command.env(mirror_env.0, mirror_env.1);
        }
        match crate::local_process::capture(&mut command, Duration::from_secs(1200)) {
            Ok(_) => return Ok(()),
            Err(error) => last = error,
        }
    }
    let line = last
        .lines()
        .filter(|l| !l.trim().is_empty())
        .last()
        .unwrap_or("")
        .to_string();
    Err(format!("翻译组件安装失败，请检查网络后重试。{line}"))
}

/// The engine's Python, set up on first use.
fn ensure_engine(base: &Path, container: &Path) -> Result<PathBuf, String> {
    let python = engine_python(base);
    let stamp = base.join("engine.stamp");
    if python.is_file() && std::fs::read_to_string(&stamp).ok().as_deref() == Some(STAMP) {
        return Ok(python);
    }
    let uv = bundled_uv().ok_or("找不到翻译组件的安装工具（uv）。")?;
    std::fs::create_dir_all(base).map_err(|e| e.to_string())?;
    let env = base.join("env");
    let env_arg = env.to_string_lossy().into_owned();
    uv_step(
        &uv,
        base,
        container,
        &[
            "venv",
            "--python",
            "3.11",
            "--python-preference",
            "only-managed",
            "--clear",
            &env_arg,
        ],
        ("UV_PYTHON_INSTALL_MIRROR", PYTHON_MIRROR),
    )?;
    let python_arg = python.to_string_lossy().into_owned();
    let mut install = vec!["pip", "install", "--python", python_arg.as_str()];
    install.extend(PACKAGES);
    uv_step(
        &uv,
        base,
        container,
        &install,
        ("UV_DEFAULT_INDEX", PACKAGE_MIRROR),
    )?;
    std::fs::write(&stamp, STAMP).map_err(|e| e.to_string())?;
    Ok(python)
}

fn notify<R: tauri::Runtime>(app: &tauri::AppHandle<R>, job: &Job, status: &Status) {
    if let Ok(mut inner) = app.state::<TranslatorState>().inner.lock() {
        inner
            .statuses
            .insert(job.fingerprint.clone(), status.clone());
    }
    let _ = app.emit(
        "translation-progress",
        serde_json::json!({
            "projectId": job.project,
            "paperId": job.paper,
            "fingerprint": job.fingerprint,
            "status": status,
        }),
    );
}

/// The JSON lines the runner printed so far: the last progress, and the end.
fn read_events(log: &Path) -> (Option<f64>, Option<Result<String, String>>) {
    let text = std::fs::read(log).unwrap_or_default();
    let text = String::from_utf8_lossy(&text);
    let mut progress = None;
    let mut end = None;
    for line in text.lines() {
        let line = line.trim();
        if !line.starts_with("{\"type\"") {
            continue;
        }
        let Ok(event) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match event["type"].as_str() {
            Some("progress") => progress = event["value"].as_f64(),
            Some("done") => end = Some(Ok(event["path"].as_str().unwrap_or("").to_string())),
            Some("error") => {
                end = Some(Err(event["message"]
                    .as_str()
                    .unwrap_or("翻译失败。")
                    .to_string()))
            }
            _ => {}
        }
    }
    (progress, end)
}

/// Words for an engine error a person can act on.
fn explain(message: &str) -> String {
    let lower = message.to_lowercase();
    if lower.contains("401") || lower.contains("invalid api key") || lower.contains("unauthorized")
    {
        "模型密钥无效或已过期，请在设置里检查模型。".into()
    } else if lower.contains("402") || lower.contains("insufficient") || message.contains("余额")
    {
        "模型账户余额或额度不足。".into()
    } else if lower.contains("429") || lower.contains("rate limit") {
        "模型请求太频繁，请稍后重试。".into()
    } else {
        let short: String = message
            .chars()
            .rev()
            .take(240)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        format!("翻译失败：{short}")
    }
}

fn translate<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job: &Job,
    stop: &AtomicBool,
) -> Result<(), String> {
    let container = app
        .state::<crate::data_location::DataLocation>()
        .container
        .clone();
    let base = container.join("translator");
    if !engine_python(&base).is_file()
        || std::fs::read_to_string(base.join("engine.stamp"))
            .ok()
            .as_deref()
            != Some(STAMP)
    {
        notify(
            app,
            job,
            &Status::new("preparing", 0.0, "正在准备翻译组件（只需一次，约几分钟）"),
        );
    }
    let python = ensure_engine(&base, &container)?;
    if stop.load(Ordering::SeqCst) {
        return Err("已停止。".into());
    }
    notify(app, job, &Status::new("translating", 0.0, "正在翻译"));
    run_engine(&python, &base, job, stop, |value| {
        notify(app, job, &Status::new("translating", value, "正在翻译"))
    })
}

/// Translates `job.source` into `job.target` with the engine's Python, reporting 0–100.
fn run_engine(
    python: &Path,
    base: &Path,
    job: &Job,
    stop: &AtomicBool,
    progress: impl Fn(f64),
) -> Result<(), String> {
    let work = base.join("work").join(&job.fingerprint);
    let _ = std::fs::remove_dir_all(&work);
    for folder in [&work, &base.join("home"), &base.join("tmp")] {
        std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    }
    let runner = base.join("run.py");
    std::fs::write(&runner, RUNNER).map_err(|e| e.to_string())?;
    let source = work.join("paper.pdf");
    std::fs::copy(&job.source, &source).map_err(|e| format!("无法读取论文：{e}"))?;
    let key = if job.model.api_key.is_empty() {
        "none".to_string()
    } else {
        job.model.api_key.clone()
    };
    let path = |p: &Path| crate::local_process::process_path(p).display().to_string();
    let args: Vec<String> = [
        path(&runner),
        path(&source),
        "--openaicompatible".into(),
        "--openai-compatible-model".into(),
        job.model.model.clone(),
        "--openai-compatible-base-url".into(),
        base_url(&job.model)?,
        "--lang-in".into(),
        "en".into(),
        "--lang-out".into(),
        "zh-CN".into(),
        "--output".into(),
        path(&work),
        "--watermark-output-mode".into(),
        "no_watermark".into(),
        "--no-dual".into(),
        "--no-auto-extract-glossary".into(),
        "--qps".into(),
        "8".into(),
        "--pool-max-workers".into(),
        "6".into(),
        "--custom-system-prompt".into(),
        PROMPT.into(),
    ]
    .into();
    // BabelDOC keeps its fonts and layout model under the home folder; keep them with Scientify's data.
    let home = path(&base.join("home"));
    let tmp = path(&base.join("tmp"));
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    for (name, value) in [
        ("HOME", home.as_str()),
        ("USERPROFILE", home.as_str()),
        ("TEMP", tmp.as_str()),
        ("TMP", tmp.as_str()),
        ("TMPDIR", tmp.as_str()),
        ("PDF2ZH_OPENAI_COMPATIBLE_API_KEY", key.as_str()),
        ("PYTHONUTF8", "1"),
        ("PYTHONIOENCODING", "utf-8"),
        ("PYTHONUNBUFFERED", "1"),
        ("NO_COLOR", "1"),
        ("COLUMNS", "120"),
        ("HF_ENDPOINT", "https://hf-mirror.com"),
    ] {
        env.insert(name.into(), value.into());
    }
    env.remove("VIRTUAL_ENV");
    env.remove("PYTHONHOME");
    env.remove("PYTHONPATH");
    let log = work.join("run.log");
    let last = Mutex::new(-1.0f64);
    let code = crate::local_process::run_logged(python, &args, &work, &env, &log, stop, || {
        if let (Some(value), _) = read_events(&log) {
            let mut seen = last.lock().unwrap();
            if (value - *seen).abs() >= 1.0 {
                *seen = value;
                progress(value);
            }
        }
    })?;
    if stop.load(Ordering::SeqCst) {
        return Err("已停止。".into());
    }
    match read_events(&log).1 {
        Some(Ok(done)) if code == 0 => {
            let produced = PathBuf::from(done);
            if let Some(folder) = job.target.parent() {
                std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
            }
            std::fs::copy(&produced, &job.target).map_err(|e| format!("无法保存译文：{e}"))?;
            let _ = std::fs::remove_dir_all(&work);
            Ok(())
        }
        Some(Err(message)) => Err(explain(&message)),
        _ => {
            let text =
                String::from_utf8_lossy(&std::fs::read(&log).unwrap_or_default()).into_owned();
            Err(explain(
                text.lines()
                    .filter(|l| !l.trim().is_empty())
                    .last()
                    .unwrap_or("翻译引擎意外退出。"),
            ))
        }
    }
}

/// Translates queued papers one after another until the queue is empty.
fn work<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    loop {
        let next = {
            let state = app.state::<TranslatorState>();
            let mut inner = state.inner.lock().unwrap();
            match inner.queue.pop_front() {
                Some(job) => {
                    let stop = Arc::new(AtomicBool::new(false));
                    inner.running = Some((job.fingerprint.clone(), stop.clone()));
                    Some((job, stop))
                }
                None => {
                    inner.worker = false;
                    inner.running = None;
                    None
                }
            }
        };
        let Some((job, stop)) = next else { return };
        let outcome = translate(&app, &job, &stop);
        let status = match outcome {
            Ok(()) => Status::new("done", 100.0, ""),
            Err(_) if stop.load(Ordering::SeqCst) => Status::new("idle", 0.0, ""),
            Err(message) => Status::new("failed", 0.0, message),
        };
        notify(&app, &job, &status);
        if let Ok(mut inner) = app.state::<TranslatorState>().inner.lock() {
            inner.running = None;
        }
    }
}

fn paths(
    app: &tauri::AppHandle<impl tauri::Runtime>,
    project: &str,
    paper: &str,
) -> Result<(PathBuf, PathBuf, String), String> {
    app.state::<LibraryState>()
        .service
        .translation_paths(project, paper)
}

fn current(state: &TranslatorState, target: &Path, fingerprint: &str) -> Status {
    let inner = state.inner.lock().unwrap();
    match inner.statuses.get(fingerprint) {
        Some(status) if matches!(status.state, "queued" | "preparing" | "translating") => {
            status.clone()
        }
        // A translation on disk shows even when trying again failed.
        _ if target.is_file() => Status::new("done", 100.0, ""),
        Some(status) if status.state == "failed" => status.clone(),
        _ => Status::new("idle", 0.0, ""),
    }
}

#[tauri::command]
pub async fn translation_status<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
    paper_id: String,
) -> Result<Status, String> {
    trusted(&view)?;
    let (_, target, fingerprint) = paths(&app, &project_id, &paper_id)?;
    Ok(current(
        &app.state::<TranslatorState>(),
        &target,
        &fingerprint,
    ))
}

/// Queues a paper for translation, unless it is translated already (`force` translates again).
#[tauri::command]
pub async fn translation_request<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    paper_id: String,
    model: Model,
    force: bool,
) -> Result<Status, String> {
    trusted(&view)?;
    project(&state, &project_id)?;
    crate::collaboration::permissions::require_write(&state.storage, &project_id, "library")?;
    if model.model.trim().is_empty() {
        return Err("请先在设置里选好 AI 模型。".into());
    }
    base_url(&model)?;
    let (source, target, fingerprint) = paths(&app, &project_id, &paper_id)?;
    let translator = app.state::<TranslatorState>();
    let status = current(&translator, &target, &fingerprint);
    if (status.state == "done" && !force)
        || matches!(status.state, "queued" | "preparing" | "translating")
    {
        return Ok(status);
    }
    let queued = Status::new("queued", 0.0, "排队中");
    let start = {
        let mut inner = translator.inner.lock().map_err(|e| e.to_string())?;
        inner.statuses.insert(fingerprint.clone(), queued.clone());
        inner.queue.push_back(Job {
            project: project_id,
            paper: paper_id,
            fingerprint,
            source,
            target,
            model,
        });
        !std::mem::replace(&mut inner.worker, true)
    };
    if start {
        let handle = app.clone();
        std::thread::spawn(move || work(handle));
    }
    Ok(queued)
}

#[tauri::command]
pub async fn translation_cancel<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
    paper_id: String,
) -> Result<(), String> {
    trusted(&view)?;
    let (_, _, fingerprint) = paths(&app, &project_id, &paper_id)?;
    let translator = app.state::<TranslatorState>();
    let mut inner = translator.inner.lock().map_err(|e| e.to_string())?;
    inner.queue.retain(|job| job.fingerprint != fingerprint);
    if let Some((running, stop)) = &inner.running {
        if *running == fingerprint {
            stop.store(true, Ordering::SeqCst);
        }
    }
    inner
        .statuses
        .insert(fingerprint, Status::new("idle", 0.0, ""));
    Ok(())
}

/// The translated PDF's bytes.
#[tauri::command]
pub async fn translation_pdf<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
    paper_id: String,
) -> Result<tauri::ipc::Response, String> {
    trusted(&view)?;
    let service = app.state::<LibraryState>().service.clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .translation_bytes(&project_id, &paper_id)
            .map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(provider: &str, endpoint: &str) -> Model {
        Model {
            provider: provider.into(),
            endpoint: endpoint.into(),
            model: "m".into(),
            api_key: String::new(),
        }
    }

    #[test]
    fn every_provider_reaches_an_openai_compatible_address() {
        assert_eq!(
            base_url(&model("openai", "https://api.openai.com/v1")).unwrap(),
            "https://api.openai.com/v1"
        );
        assert_eq!(
            base_url(&model("openai", "https://124.221.115.83:8443")).unwrap(),
            "https://124.221.115.83:8443/v1"
        );
        assert_eq!(
            base_url(&model(
                "openai",
                "https://sub.acadwrite.cn/v1/chat/completions"
            ))
            .unwrap(),
            "https://sub.acadwrite.cn/v1"
        );
        assert_eq!(
            base_url(&model("ollama", "http://127.0.0.1:11434")).unwrap(),
            "http://127.0.0.1:11434/v1"
        );
        assert_eq!(
            base_url(&model("anthropic", "https://api.anthropic.com/v1")).unwrap(),
            "https://api.anthropic.com/v1"
        );
        assert!(base_url(&model(
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta"
        ))
        .unwrap()
        .ends_with("/openai"));
        assert!(base_url(&model("openai", "not a url")).is_err());
    }

    /// Sets the engine up from nothing with the bundled uv and translates a PDF:
    /// `SCIENTIFY_TRANSLATE_PDF=… SCIENTIFY_TRANSLATE_KEY=… SCIENTIFY_TRANSLATE_BASE=…
    /// SCIENTIFY_TRANSLATE_MODEL=… cargo test -p scientify -- --ignored live_translation`
    #[test]
    #[ignore]
    fn live_translation() {
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name}"));
        let root = PathBuf::from(var("SCIENTIFY_TRANSLATE_HOME"));
        let base = root.join("translator");
        let started = std::time::Instant::now();
        let python = ensure_engine(&base, &root).unwrap();
        println!(
            "engine ready in {:?}: {}",
            started.elapsed(),
            python.display()
        );
        let target = root.join("out").join("translated.pdf");
        let _ = std::fs::remove_file(&target);
        let job = Job {
            project: "p".into(),
            paper: "a".into(),
            fingerprint: "f".repeat(64),
            source: PathBuf::from(var("SCIENTIFY_TRANSLATE_PDF")),
            target: target.clone(),
            model: Model {
                provider: "openai".into(),
                endpoint: var("SCIENTIFY_TRANSLATE_BASE"),
                model: var("SCIENTIFY_TRANSLATE_MODEL"),
                api_key: var("SCIENTIFY_TRANSLATE_KEY"),
            },
        };
        let started = std::time::Instant::now();
        run_engine(&python, &base, &job, &AtomicBool::new(false), |value| {
            println!("progress {value:.0}")
        })
        .unwrap();
        println!(
            "translated in {:?}: {} bytes",
            started.elapsed(),
            std::fs::metadata(&target).unwrap().len()
        );
    }

    #[test]
    fn reads_progress_and_the_end_from_the_runner_log() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("run.log");
        std::fs::write(&log, "rich noise\n{\"type\": \"progress\", \"value\": 12.5, \"stage\": \"x\"}\nmore\n{\"type\": \"progress\", \"value\": 40}\n").unwrap();
        assert_eq!(read_events(&log), (Some(40.0), None));
        std::fs::write(
            &log,
            "{\"type\": \"done\", \"path\": \"C:/w/paper.zh-CN.mono.pdf\"}\n",
        )
        .unwrap();
        assert_eq!(
            read_events(&log).1,
            Some(Ok("C:/w/paper.zh-CN.mono.pdf".into()))
        );
        std::fs::write(
            &log,
            "{\"type\": \"error\", \"message\": \"Error code: 401\"}\n",
        )
        .unwrap();
        assert_eq!(
            explain(&read_events(&log).1.unwrap().unwrap_err()),
            "模型密钥无效或已过期，请在设置里检查模型。"
        );
    }
}
