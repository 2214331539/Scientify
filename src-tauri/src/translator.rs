//! Full-text translation with BabelDOC (through pdf2zh-next): the translated PDF keeps
//! the original's layout, formulas and figures. The engine ships in the installer
//! (`release-resources/babeldoc`, built by `scripts/prepare-babeldoc.mjs`) and runs from
//! there; nothing is installed at run time.
//!
//! Translation happens in the background and never asks. Every PDF in a literature
//! folder is translated once: a paper someone opens in translation first, then papers
//! that arrived, then the ones already there. Papers go one at a time; when the model
//! is out of quota or unreachable the work pauses and resumes later. The result is
//! `.scientify/translations/<fingerprint>.pdf`, which syncs, so the devices of one
//! account share it: each device lists the papers it is about to translate in its own
//! small claim file beside the translations, and the others leave those alone.
use crate::library::{trusted, LibraryState};
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

const RUNNER: &str = include_str!("translator_run.py");
const PROMPT: &str = "你是专业严谨的学术文献翻译引擎，把英文准确、通顺地译为简体中文。严格遵守以下规则：\
1) 作者姓名、机构名、期刊名、图/表编号、文献引用（如 Smith et al., 2015）一律保留英文原文，不要翻译；\
2) 基因/蛋白/通路符号、缩写、物种拉丁学名、计量单位保留原文；\
3) 术语前后保持一致；4) 保留所有公式、占位符、标签不变；5) 只输出译文，不要加任何解释或说明。";
const CLAIMS: &str = ".claims.json";
/// A claim holds this long (seconds) unless its device renews it.
const LEASE: u64 = 90 * 60;
const HEARTBEAT: u64 = 30 * 60;
/// A newly arrived paper waits this long, so the device it came from can claim it first.
const SETTLE: Duration = Duration::from_secs(3 * 60);
const FIRST_PASS: Duration = Duration::from_secs(45);
const PASS: Duration = Duration::from_secs(2 * 60);
/// A paper that fails by itself (not the model) is left alone after this many tries.
const ATTEMPTS: u32 = 3;

#[derive(Clone)]
struct Model {
    provider: String,
    endpoint: String,
    model: String,
    api_key: String,
    /// The official model, whose token comes from the collaboration server.
    official: bool,
}

/// What the translation pane shows: the translated PDF, progress, or a quiet wait.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// `done`, `translating` or `waiting`.
    state: &'static str,
    /// 0–100 while translating.
    progress: f64,
}

impl Status {
    fn new(state: &'static str, progress: f64) -> Self {
        Self { state, progress }
    }
}

#[derive(Clone)]
struct Job {
    project: String,
    fingerprint: String,
    source: PathBuf,
    target: PathBuf,
}

/// The papers one device is about to translate, in that library's translations folder.
#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
struct Claims {
    device: String,
    /// When the device last renewed the claim (Unix seconds).
    at: u64,
    /// Fingerprint → `queued` or `running`.
    papers: BTreeMap<String, String>,
}

/// What this device remembers, in its data folder.
#[derive(Serialize, Deserialize, Default)]
struct Local {
    /// Per project, the papers that were already there when this device first looked;
    /// they wait behind papers that arrive later.
    #[serde(default)]
    known: BTreeMap<String, BTreeSet<String>>,
    #[serde(default)]
    failures: BTreeMap<String, u32>,
    /// The engine those failures happened with; a new one tries the papers again.
    #[serde(default)]
    engine: String,
}

/// The engine as shipped: its folder, the interpreter inside it and its build stamp.
struct Engine {
    dir: PathBuf,
    executable: PathBuf,
    stamp: String,
}

enum Failure {
    /// The model or the engine is unavailable: wait and try the same paper again.
    Model(String),
    /// This paper could not be translated.
    Paper,
    Stopped,
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Job>,
    running: Option<(Job, f64, Arc<AtomicBool>)>,
    /// Papers someone opened in translation.
    wanted: HashSet<String>,
    first_seen: HashMap<String, Instant>,
    paused_until: Option<Instant>,
    /// An official-model token the server turned down; the next one is fetched fresh.
    stale_token: Option<String>,
    worker: bool,
    /// What this device last wrote to each claim file, and when.
    written: HashMap<PathBuf, (BTreeMap<String, String>, u64)>,
}

#[derive(Default)]
pub struct TranslatorState {
    inner: Mutex<Inner>,
    wake: Mutex<Option<mpsc::Sender<()>>>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or_default()
}

/// The OpenAI-compatible address pdf2zh-next calls for a model.
fn base_url(model: &Model) -> Result<String, String> {
    let endpoint = model.endpoint.trim().trim_end_matches('/');
    let url = tauri::Url::parse(endpoint).map_err(|_| "模型地址无效。".to_string())?;
    let origin = url.origin().ascii_serialization();
    let path = url.path().trim_end_matches('/');
    let url: String = match model.provider.as_str() {
        "gemini" => "https://generativelanguage.googleapis.com/v1beta/openai".into(),
        "ollama" => format!("{origin}/v1"),
        _ => {
            let path = ["/chat/completions", "/responses", "/models", "/messages"]
                .iter()
                .find_map(|suffix| path.strip_suffix(suffix))
                .unwrap_or(path);
            format!("{origin}{}", if path.is_empty() { "/v1" } else { path })
        }
    };
    // The official service gives translation its own allowance, apart from conversations.
    Ok(if model.official && url.ends_with("/v1") {
        format!("{url}/translate")
    } else {
        url
    })
}

/// The engine in the installer (or, while developing, in `release-resources`).
fn engine<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<Engine> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("babeldoc"));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("release-resources")
        .join("babeldoc");
    bundled
        .into_iter()
        .chain(std::iter::once(development))
        .find_map(|dir| {
            let stamp: serde_json::Value =
                serde_json::from_slice(&std::fs::read(dir.join("scientify-babeldoc.json")).ok()?)
                    .ok()?;
            let relative = Path::new(stamp["executable"].as_str()?);
            if !relative
                .components()
                .all(|c| matches!(c, Component::Normal(_)))
            {
                return None;
            }
            dir.join(relative).is_file().then(|| Engine {
                executable: relative.to_path_buf(),
                stamp: stamp["stamp"].as_str().unwrap_or_default().to_string(),
                dir,
            })
        })
}

fn quarantined(path: &Path) -> bool {
    Command::new("/usr/bin/xattr")
        .args(["-p", "com.apple.quarantine"])
        .arg(path)
        .output()
        .is_ok_and(|output| output.status.success())
}

/// Where the engine runs from. macOS refuses code carrying the download quarantine of
/// an app that is not notarized, which Scientify cannot be yet. A quarantined engine
/// is cloned into the data folder (an APFS clone takes no extra space), the mark taken
/// off the copy, and run from there; once per version, without asking anything.
fn runnable(engine: &Engine, base: &Path) -> Result<PathBuf, String> {
    if !cfg!(target_os = "macos") || !quarantined(&engine.dir.join(&engine.executable)) {
        return Ok(engine.dir.clone());
    }
    let copies = base.join("engine");
    let copy = copies.join(engine.stamp.chars().take(16).collect::<String>());
    if copy.join(".ready").is_file() {
        return Ok(copy);
    }
    // Older versions and an interrupted copy go first.
    let _ = std::fs::remove_dir_all(&copies);
    std::fs::create_dir_all(&copies).map_err(|e| e.to_string())?;
    let partial = copies.join("partial");
    let copied = |flags: &str| {
        Command::new("/bin/cp")
            .arg(flags)
            .arg(&engine.dir)
            .arg(&partial)
            .status()
            .is_ok_and(|status| status.success())
    };
    // `cp -c` clones on APFS; on another volume a plain copy does the job.
    if !copied("-cR") {
        let _ = std::fs::remove_dir_all(&partial);
        if !copied("-R") {
            return Err("无法复制翻译组件。".into());
        }
    }
    let _ = Command::new("/usr/bin/xattr")
        .args(["-dr", "com.apple.quarantine"])
        .arg(&partial)
        .status();
    if quarantined(&partial.join(&engine.executable)) {
        return Err("无法去掉翻译组件的下载隔离标记。".into());
    }
    std::fs::rename(&partial, &copy).map_err(|e| e.to_string())?;
    std::fs::write(copy.join(".ready"), &engine.stamp).map_err(|e| e.to_string())?;
    Ok(copy)
}

fn base<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    app.state::<crate::data_location::DataLocation>()
        .container
        .join("translator")
}

/// Why translations failed, kept for diagnosis; nobody is shown it.
fn log(base: &Path, line: &str) {
    let path = base.join("translator.log");
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > 256 * 1024) {
        let _ = std::fs::remove_file(&path);
    }
    let _ = std::fs::create_dir_all(base);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let tail: String = line
            .chars()
            .rev()
            .take(600)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let _ = writeln!(
            file,
            "{} {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            tail.replace('\n', " ")
        );
    }
}

/// The model translation calls: the assistant's, or another saved one for a ChatGPT sign-in.
fn model<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Result<Model, String> {
    let state = app.state::<AppState>();
    let data = state.storage.load()?.ok_or("工作区尚未载入。")?;
    let settings = crate::ai::text_connection(&data)?;
    let provider = settings["provider"]
        .as_str()
        .unwrap_or("ollama")
        .to_string();
    let mut endpoint = settings["endpoint"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let name = settings["model"]
        .as_str()
        .filter(|name| crate::ai::valid_model(name))
        .ok_or("没有选择模型。")?
        .to_string();
    let official = settings["serviceId"] == "scientify";
    let api_key = if official {
        endpoint = crate::collaboration::device(&state)?.endpoint;
        let stale = app
            .state::<TranslatorState>()
            .inner
            .lock()
            .map_err(|e| e.to_string())?
            .stale_token
            .take();
        tauri::async_runtime::block_on(crate::collaboration::model_token(
            &state,
            stale.is_some(),
            stale.as_deref(),
        ))?
    } else {
        crate::credentials::load_for_model(state.storage.directory(), &provider, &endpoint)?
            .unwrap_or_default()
    };
    Ok(Model {
        provider,
        endpoint,
        model: name,
        api_key,
        official,
    })
}

/// Whether an error is about the model service (quota, key, network) rather than the paper.
fn model_trouble(message: &str) -> bool {
    let lower = message.to_lowercase();
    [
        "401",
        "402",
        "403",
        "404",
        "429",
        "500",
        "502",
        "503",
        "504",
        "insufficient",
        "quota",
        "rate limit",
        "ratelimit",
        "unauthorized",
        "authentication",
        "permissiondenied",
        "apiconnection",
        "apitimeout",
        "timed out",
        "timeout",
        "connection",
        "notfounderror",
        "internalservererror",
        "余额",
        "额度",
        "点数",
    ]
    .iter()
    .any(|word| lower.contains(word))
}

fn claims_of(folder: &Path) -> Vec<Claims> {
    let Ok(entries) = std::fs::read_dir(folder) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter(|entry| entry.file_name().to_string_lossy().ends_with(CLAIMS))
        .filter(|entry| {
            entry
                .metadata()
                .is_ok_and(|m| m.is_file() && m.len() < 1 << 20)
        })
        .filter_map(|entry| serde_json::from_slice(&std::fs::read(entry.path()).ok()?).ok())
        .collect()
}

/// Whether another device has the paper: it is translating it, or it queued it first in
/// device order. Someone who opened the paper only waits for a translation under way.
fn taken(others: &[Claims], me: &str, fingerprint: &str, at: u64, wanted: bool) -> bool {
    others.iter().any(|claims| {
        claims.device != me
            && at.saturating_sub(claims.at) < LEASE
            && match claims.papers.get(fingerprint).map(String::as_str) {
                Some("running") => true,
                Some(_) => !wanted && claims.device.as_str() < me,
                None => false,
            }
    })
}

fn write_claims(folder: &Path, claims: &Claims) -> Result<(), String> {
    let path = folder.join(format!("{}{CLAIMS}", claims.device));
    if claims.papers.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.to_string()),
            _ => Ok(()),
        };
    }
    std::fs::create_dir_all(folder).map_err(|e| e.to_string())?;
    let partial = folder.join(format!("{}.claims.partial", claims.device));
    std::fs::write(
        &partial,
        serde_json::to_vec(claims).map_err(|e| e.to_string())?,
    )
    .and_then(|()| std::fs::rename(&partial, &path))
    .map_err(|e| e.to_string())
}

fn local_path<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> PathBuf {
    base(app).join("state.json")
}
fn load_local<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Local {
    std::fs::read(local_path(app))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
fn save_local<R: tauri::Runtime>(app: &tauri::AppHandle<R>, local: &Local) {
    let path = local_path(app);
    if let Some(folder) = path.parent() {
        let _ = std::fs::create_dir_all(folder);
    }
    if let Ok(bytes) = serde_json::to_vec(local) {
        let partial = path.with_extension("partial");
        let _ = std::fs::write(&partial, bytes).and_then(|()| std::fs::rename(&partial, &path));
    }
}

/// Looks over the literature folders again soon, for example after a file arrived.
pub(crate) fn wake<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(sender) = app
        .state::<TranslatorState>()
        .wake
        .lock()
        .ok()
        .and_then(|s| s.clone())
    {
        let _ = sender.send(());
    }
}

fn notify<R: tauri::Runtime>(app: &tauri::AppHandle<R>, job: &Job, status: Status) {
    if let Ok(mut inner) = app.state::<TranslatorState>().inner.lock() {
        if let Some((running, progress, _)) = inner.running.as_mut() {
            if running.fingerprint == job.fingerprint {
                *progress = status.progress;
            }
        }
    }
    let _ = app.emit(
        "translation-progress",
        serde_json::json!({
            "projectId": job.project,
            "fingerprint": job.fingerprint,
            "status": status,
        }),
    );
}

/// Starts the background translation: a first look shortly after launch, then one every
/// couple of minutes or whenever something asks.
pub fn start<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let (sender, receiver) = mpsc::channel();
    if let Ok(mut wake) = app.state::<TranslatorState>().wake.lock() {
        *wake = Some(sender);
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut wait = FIRST_PASS;
        loop {
            match receiver.recv_timeout(wait) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
            while receiver.try_recv().is_ok() {}
            pass(&app);
            wait = PASS;
        }
    });
}

/// One look over every literature folder: decide what this device translates, claim it,
/// and keep the worker going.
fn pass<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    let Some(engine) = engine(app) else {
        return;
    };
    let state = app.state::<AppState>();
    let Ok(Some(data)) = state.storage.load() else {
        return;
    };
    let Ok(me) = crate::collaboration::device(&state).map(|d| d.client_id) else {
        return;
    };
    let library = app.state::<LibraryState>().service.clone();
    let translator = app.state::<TranslatorState>();
    let (wanted, running, paused) = {
        let Ok(mut inner) = translator.inner.lock() else {
            return;
        };
        if inner
            .paused_until
            .is_some_and(|until| until <= Instant::now())
        {
            inner.paused_until = None;
        }
        (
            inner.wanted.clone(),
            inner.running.as_ref().map(|(job, _, _)| job.target.clone()),
            inner.paused_until.is_some(),
        )
    };
    let mut local = load_local(app);
    let mut remembered = false;
    // Papers that failed with an earlier engine (perhaps a broken one) are tried again.
    if local.engine != engine.stamp {
        local.engine = engine.stamp.clone();
        local.failures.clear();
        remembered = true;
    }
    let mut first: Vec<Job> = Vec::new();
    let mut arrived: Vec<Job> = Vec::new();
    let mut older: Vec<Job> = Vec::new();
    let mut finished: Vec<String> = Vec::new();
    let mut claims: Vec<(PathBuf, BTreeMap<String, String>)> = Vec::new();
    let at = now();
    for project in data["projects"].as_array().into_iter().flatten() {
        let Some(id) = project["id"].as_str() else {
            continue;
        };
        if crate::collaboration::permissions::require_write(&state.storage, id, "library").is_err()
        {
            continue;
        }
        let Ok(Some((folder, pdfs))) = library.translation_candidates(id) else {
            continue;
        };
        let known = local.known.entry(id.to_string()).or_insert_with(|| {
            remembered = true;
            pdfs.iter().map(|(_, fp)| fp.clone()).collect()
        });
        let others = claims_of(&folder);
        let mut ours = BTreeMap::new();
        for (source, fingerprint) in pdfs {
            let target = folder.join(format!("{fingerprint}.pdf"));
            if target.is_file() {
                finished.push(fingerprint);
                continue;
            }
            let wanted = wanted.contains(&fingerprint);
            if !wanted {
                if local.failures.get(&fingerprint).copied().unwrap_or(0) >= ATTEMPTS {
                    continue;
                }
                let seen = translator
                    .inner
                    .lock()
                    .map(|mut inner| {
                        *inner
                            .first_seen
                            .entry(fingerprint.clone())
                            .or_insert_with(Instant::now)
                    })
                    .unwrap_or_else(|_| Instant::now());
                if seen.elapsed() < SETTLE {
                    continue;
                }
            }
            if taken(&others, &me, &fingerprint, at, wanted) {
                continue;
            }
            let job = Job {
                project: id.to_string(),
                fingerprint: fingerprint.clone(),
                source,
                target,
            };
            let mark = if running.as_ref() == Some(&job.target) {
                "running"
            } else {
                "queued"
            };
            ours.insert(fingerprint, mark.to_string());
            if wanted {
                first.push(job);
            } else if known.contains(&job.fingerprint) {
                older.push(job);
            } else {
                arrived.push(job);
            }
        }
        claims.push((folder, ours));
    }
    if remembered {
        save_local(app, &local);
    }
    let start_worker = {
        let Ok(mut inner) = translator.inner.lock() else {
            return;
        };
        for fingerprint in &finished {
            inner.wanted.remove(fingerprint);
            inner.first_seen.remove(fingerprint);
        }
        // A paused device stops renewing its claims, so another one can take over.
        if !paused {
            for (folder, papers) in claims {
                let due = inner.written.get(&folder).is_none_or(|(last, when)| {
                    *last != papers || at.saturating_sub(*when) >= HEARTBEAT
                });
                if due
                    && write_claims(
                        &folder,
                        &Claims {
                            device: me.clone(),
                            at,
                            papers: papers.clone(),
                        },
                    )
                    .is_ok()
                {
                    inner.written.insert(folder, (papers, at));
                }
            }
        }
        inner.queue = first
            .into_iter()
            .chain(arrived)
            .chain(older)
            .filter(|job| running.as_ref() != Some(&job.target))
            .collect();
        let start = !paused && !inner.worker && !inner.queue.is_empty();
        if start {
            inner.worker = true;
        }
        start
    };
    if start_worker {
        let handle = app.clone();
        std::thread::spawn(move || work(handle));
    }
}

/// Translates claimed papers one after another until the queue is empty or the model
/// needs a rest.
fn work<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    loop {
        let next = {
            let state = app.state::<TranslatorState>();
            let Ok(mut inner) = state.inner.lock() else {
                return;
            };
            let job = if inner.paused_until.is_some() {
                None
            } else {
                inner.queue.pop_front()
            };
            match job {
                Some(job) => {
                    let stop = Arc::new(AtomicBool::new(false));
                    inner.running = Some((job.clone(), 0.0, stop.clone()));
                    Some((job, stop))
                }
                None => {
                    inner.worker = false;
                    inner.running = None;
                    None
                }
            }
        };
        let Some((job, stop)) = next else {
            return;
        };
        // Claims synced since the pass; the paper may have been translated meanwhile too.
        let me = crate::collaboration::device(&app.state::<AppState>())
            .map(|d| d.client_id)
            .unwrap_or_default();
        let wanted = app
            .state::<TranslatorState>()
            .inner
            .lock()
            .is_ok_and(|inner| inner.wanted.contains(&job.fingerprint));
        let skip = job.target.is_file()
            || job.target.parent().is_some_and(|folder| {
                taken(&claims_of(folder), &me, &job.fingerprint, now(), wanted)
            });
        if !skip {
            // Mark the claim as running before the work starts.
            wake(&app);
            let outcome = match model(&app) {
                Ok(model) => translate(&app, &job, &model, &stop),
                Err(message) => {
                    log(&base(&app), &format!("model: {message}"));
                    Err(Failure::Model(message))
                }
            };
            settle(&app, &job, outcome);
        }
        if let Ok(mut inner) = app.state::<TranslatorState>().inner.lock() {
            inner.running = None;
        }
        wake(&app);
    }
}

fn settle<R: tauri::Runtime>(app: &tauri::AppHandle<R>, job: &Job, outcome: Result<(), Failure>) {
    let translator = app.state::<TranslatorState>();
    match outcome {
        Ok(()) => {
            if let Ok(mut inner) = translator.inner.lock() {
                inner.wanted.remove(&job.fingerprint);
            }
            notify(app, job, Status::new("done", 100.0));
        }
        Err(Failure::Model(message)) => {
            let rest = if message.contains("429") || message.to_lowercase().contains("rate limit") {
                Duration::from_secs(10 * 60)
            } else {
                Duration::from_secs(30 * 60)
            };
            if let Ok(mut inner) = translator.inner.lock() {
                inner.paused_until = Some(Instant::now() + rest);
                inner.queue.push_front(job.clone());
            }
            notify(app, job, Status::new("waiting", 0.0));
        }
        Err(Failure::Paper) => {
            let mut local = load_local(app);
            *local.failures.entry(job.fingerprint.clone()).or_default() += 1;
            save_local(app, &local);
            if let Ok(mut inner) = translator.inner.lock() {
                inner.wanted.remove(&job.fingerprint);
            }
            notify(app, job, Status::new("waiting", 0.0));
        }
        Err(Failure::Stopped) => {}
    }
}

fn translate<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    job: &Job,
    model: &Model,
    stop: &AtomicBool,
) -> Result<(), Failure> {
    let base = base(app);
    let engine = engine(app).ok_or_else(|| Failure::Model("翻译组件缺失。".into()))?;
    let dir = runnable(&engine, &base).map_err(|message| {
        log(&base, &format!("engine: {message}"));
        Failure::Model(message)
    })?;
    notify(app, job, Status::new("translating", 0.0));
    let result = run_engine(
        &dir.join(&engine.executable),
        &dir.join("assets"),
        &base,
        job,
        model,
        stop,
        |value| notify(app, job, Status::new("translating", value)),
    );
    if stop.load(Ordering::SeqCst) {
        return Err(Failure::Stopped);
    }
    result.map_err(|message| {
        let shown = if model.api_key.is_empty() {
            message.clone()
        } else {
            message.replace(&model.api_key, "[key]")
        };
        log(&base, &format!("{}: {shown}", job.fingerprint));
        if message.contains("401") && model.official {
            if let Ok(mut inner) = app.state::<TranslatorState>().inner.lock() {
                inner.stale_token = Some(model.api_key.clone());
            }
        }
        if model_trouble(&message) {
            Failure::Model(message)
        } else {
            Failure::Paper
        }
    })
}

/// Translates `job.source` into `job.target` with the bundled engine, reporting 0–100.
fn run_engine(
    python: &Path,
    assets: &Path,
    base: &Path,
    job: &Job,
    model: &Model,
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
    let key = if model.api_key.is_empty() {
        "none".to_string()
    } else {
        model.api_key.clone()
    };
    let path = |p: &Path| crate::local_process::process_path(p).display().to_string();
    let args: Vec<String> = [
        path(&runner),
        path(&source),
        "--openaicompatible".into(),
        "--openai-compatible-model".into(),
        model.model.clone(),
        "--openai-compatible-base-url".into(),
        base_url(model)?,
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
    // The installation stays untouched: settings, caches and compiled modules live here.
    let home = path(&base.join("home"));
    let tmp = path(&base.join("tmp"));
    let pycache = path(&base.join("pycache"));
    let assets = path(assets);
    let mut env: BTreeMap<String, String> = std::env::vars().collect();
    for (name, value) in [
        ("HOME", home.as_str()),
        ("USERPROFILE", home.as_str()),
        ("TEMP", tmp.as_str()),
        ("TMP", tmp.as_str()),
        ("TMPDIR", tmp.as_str()),
        ("PYTHONPYCACHEPREFIX", pycache.as_str()),
        ("SCIENTIFY_BABELDOC_ASSETS", assets.as_str()),
        ("PDF2ZH_OPENAI_COMPATIBLE_API_KEY", key.as_str()),
        ("PYTHONNOUSERSITE", "1"),
        ("PYTHONUTF8", "1"),
        ("PYTHONIOENCODING", "utf-8"),
        ("PYTHONUNBUFFERED", "1"),
        ("NO_COLOR", "1"),
        ("COLUMNS", "120"),
        ("HF_ENDPOINT", "https://hf-mirror.com"),
    ] {
        env.insert(name.into(), value.into());
    }
    for name in ["VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH", "PYTHONSTARTUP"] {
        env.remove(name);
    }
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
            // Never leave a half-written translation where sync and the reader look.
            let partial = job.target.with_extension("partial");
            std::fs::copy(&produced, &partial)
                .and_then(|_| std::fs::rename(&partial, &job.target))
                .map_err(|e| format!("无法保存译文：{e}"))?;
            let _ = std::fs::remove_dir_all(&work);
            Ok(())
        }
        Some(Err(message)) => Err(message),
        _ => {
            let text =
                String::from_utf8_lossy(&std::fs::read(&log).unwrap_or_default()).into_owned();
            Err(text
                .lines()
                .rfind(|l| !l.trim().is_empty())
                .unwrap_or("翻译引擎意外退出。")
                .to_string())
        }
    }
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

fn status(state: &TranslatorState, target: &Path, fingerprint: &str) -> Status {
    if target.is_file() {
        return Status::new("done", 100.0);
    }
    match state.inner.lock().ok().and_then(|inner| {
        inner
            .running
            .as_ref()
            .filter(|(job, _, _)| job.fingerprint == fingerprint)
            .map(|(_, progress, _)| *progress)
    }) {
        Some(progress) => Status::new("translating", progress),
        None => Status::new("waiting", 0.0),
    }
}

fn paths<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project: &str,
    paper: &str,
) -> Result<(PathBuf, PathBuf, String), String> {
    app.state::<LibraryState>()
        .service
        .translation_paths(project, paper)
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
    Ok(status(
        &app.state::<TranslatorState>(),
        &target,
        &fingerprint,
    ))
}

/// Someone opened the paper in translation: translate it next unless it is done or
/// another device is translating it.
#[tauri::command]
pub async fn translation_open<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
    paper_id: String,
) -> Result<Status, String> {
    trusted(&view)?;
    let (_, target, fingerprint) = paths(&app, &project_id, &paper_id)?;
    let translator = app.state::<TranslatorState>();
    if !target.is_file()
        && crate::collaboration::permissions::require_write(
            &app.state::<AppState>().storage,
            &project_id,
            "library",
        )
        .is_ok()
    {
        let fresh = translator
            .inner
            .lock()
            .map_err(|e| e.to_string())?
            .wanted
            .insert(fingerprint.clone());
        if fresh {
            wake(&app);
        }
    }
    Ok(status(&translator, &target, &fingerprint))
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
            official: false,
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
        assert!(base_url(&model(
            "gemini",
            "https://generativelanguage.googleapis.com/v1beta"
        ))
        .unwrap()
        .ends_with("/openai"));
        assert!(base_url(&model("openai", "not a url")).is_err());
        let official = Model {
            official: true,
            ..model("openai", "https://124.221.115.83:8443")
        };
        assert_eq!(
            base_url(&official).unwrap(),
            "https://124.221.115.83:8443/v1/translate"
        );
    }

    fn claims(device: &str, at: u64, papers: &[(&str, &str)]) -> Claims {
        Claims {
            device: device.into(),
            at,
            papers: papers
                .iter()
                .map(|(fp, state)| (fp.to_string(), state.to_string()))
                .collect(),
        }
    }

    #[test]
    fn devices_of_one_account_translate_each_paper_once() {
        let at = 10_000;
        let others = [
            claims("b", at - 60, &[("p1", "queued"), ("p2", "running")]),
            claims("z", at - 60, &[("p3", "queued")]),
            claims("a", at - LEASE - 1, &[("p4", "running")]),
        ];
        // A device earlier in order that queued it first keeps it; a later one gives way.
        assert!(taken(&others, "c", "p1", at, false));
        assert!(!taken(&others, "a", "p1", at, false));
        assert!(!taken(&others, "c", "p3", at, false));
        // A translation under way is never repeated, even for someone who opened it.
        assert!(taken(&others, "a", "p2", at, true));
        // Someone waiting does not wait behind a queue on another device.
        assert!(!taken(&others, "c", "p1", at, true));
        // A device that stopped renewing its claim loses it.
        assert!(!taken(&others, "c", "p4", at, false));
        // A device's own claim file is not someone else's.
        assert!(!taken(&others, "b", "p1", at, false));
    }

    #[test]
    fn claim_files_round_trip_and_disappear_when_empty() {
        let dir = tempfile::tempdir().unwrap();
        let mine = claims("device-1", 5, &[("p1", "queued")]);
        write_claims(dir.path(), &mine).unwrap();
        std::fs::write(dir.path().join("broken.claims.json"), "{").unwrap();
        std::fs::write(dir.path().join("p1.pdf"), "%PDF-").unwrap();
        assert_eq!(claims_of(dir.path()), vec![mine.clone()]);
        assert!(!dir.path().join("device-1.claims.partial").exists());
        write_claims(dir.path(), &claims("device-1", 6, &[])).unwrap();
        assert!(!dir.path().join("device-1.claims.json").exists());
    }

    #[test]
    fn an_engine_without_the_download_mark_runs_where_it_is() {
        let dir = tempfile::tempdir().unwrap();
        let engine = Engine {
            dir: dir.path().join("babeldoc"),
            executable: PathBuf::from("python/python.exe"),
            stamp: "abc".into(),
        };
        assert_eq!(runnable(&engine, dir.path()).unwrap(), engine.dir);
        assert!(!dir.path().join("engine").exists());
    }

    #[test]
    fn the_diagnostic_log_stays_small_and_on_one_line_per_failure() {
        let dir = tempfile::tempdir().unwrap();
        log(dir.path(), "first\nsecond");
        log(dir.path(), &"x".repeat(2000));
        let text = std::fs::read_to_string(dir.path().join("translator.log")).unwrap();
        assert_eq!(text.lines().count(), 2);
        assert!(text.lines().next().unwrap().ends_with("first second"));
        assert!(text.lines().nth(1).unwrap().len() < 700);
    }

    #[test]
    fn quota_and_network_trouble_pause_instead_of_failing_the_paper() {
        assert!(model_trouble("Error code: 402 - insufficient balance"));
        assert!(model_trouble("RateLimitError: Error code: 429"));
        assert!(model_trouble("APIConnectionError: Connection error."));
        assert!(model_trouble("模型额度不足"));
        assert!(!model_trouble("ValueError: cannot parse page 3"));
    }

    /// Translates a PDF with the engine in `release-resources/babeldoc`:
    /// `SCIENTIFY_TRANSLATE_HOME=… SCIENTIFY_TRANSLATE_PDF=… SCIENTIFY_TRANSLATE_KEY=…
    /// SCIENTIFY_TRANSLATE_BASE=… SCIENTIFY_TRANSLATE_MODEL=… cargo test -p scientify -- --ignored live_translation`
    #[test]
    #[ignore]
    fn live_translation() {
        let var = |name: &str| std::env::var(name).unwrap_or_else(|_| panic!("{name}"));
        let engine = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("release-resources")
            .join("babeldoc");
        let stamp: serde_json::Value =
            serde_json::from_slice(&std::fs::read(engine.join("scientify-babeldoc.json")).unwrap())
                .unwrap();
        let python = engine.join(stamp["executable"].as_str().unwrap());
        let base = PathBuf::from(var("SCIENTIFY_TRANSLATE_HOME")).join("translator");
        let target = base.join("out").join("translated.pdf");
        let _ = std::fs::remove_file(&target);
        let job = Job {
            project: "p".into(),
            fingerprint: "f".repeat(64),
            source: PathBuf::from(var("SCIENTIFY_TRANSLATE_PDF")),
            target: target.clone(),
        };
        let model = Model {
            provider: "openai".into(),
            endpoint: var("SCIENTIFY_TRANSLATE_BASE"),
            model: var("SCIENTIFY_TRANSLATE_MODEL"),
            api_key: var("SCIENTIFY_TRANSLATE_KEY"),
            official: false,
        };
        let started = Instant::now();
        run_engine(
            &python,
            &engine.join("assets"),
            &base,
            &job,
            &model,
            &AtomicBool::new(false),
            |value| println!("progress {value:.0}"),
        )
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
    }
}
