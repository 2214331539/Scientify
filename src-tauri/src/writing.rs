//! LaTeX manuscripts: find a TeX engine, compile in a cache folder, and read back the PDF
//! and SyncTeX. Sources are never written to; only the PDF can be copied back on request.
//! Manuscripts also come in from zip files and Git (Overleaf) and go out as source packages.
use crate::AppState;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsString,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{Manager, State};

const COMPILE_LIMIT: Duration = Duration::from_secs(15 * 60);
const OUTPUT_LIMIT: usize = 512 * 1024;
const LOG_LIMIT: u64 = 8 * 1024 * 1024;
const PDF_LIMIT: u64 = 200 * 1024 * 1024;
const ZIP_LIMIT: u64 = 512 * 1024 * 1024;
const UNPACKED_LIMIT: u64 = 1024 * 1024 * 1024;
const ZIP_ENTRIES: usize = 20_000;
const TARGET: &str = env!("SCIENTIFY_TARGET");
/// The same manifest `scripts/prepare-tectonic.mjs` downloads and verifies the engine from.
const TECTONIC_MANIFEST: &str = include_str!("../../scripts/tectonic-assets.json");

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_owned()
    }
}

fn tectonic_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        serde_json::from_str::<serde_json::Value>(TECTONIC_MANIFEST)
            .ok()
            .and_then(|manifest| manifest["version"].as_str().map(str::to_owned))
            .unwrap_or_default()
    })
}

/// The Tectonic shipped with Scientify. Release bundles place it next to the executable with
/// the target suffix removed; development keeps the suffixed file in `binaries/`.
fn bundled() -> Option<PathBuf> {
    let suffix = std::env::consts::EXE_SUFFIX;
    let suffixed = format!("tectonic-{TARGET}{suffix}");
    let beside = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .map(|dir| [dir.join(format!("tectonic{suffix}")), dir.join(&suffixed)])
        .into_iter()
        .flatten();
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(&suffixed);
    beside
        .chain(std::iter::once(development))
        .find(|path| path.is_file())
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LocalTex {
    distribution: String,
    bin: String,
    latexmk: bool,
    engines: Vec<String>,
}

/// Year-named folders (texlive/2025) newest first, each joined with `tail`.
fn by_year(root: &Path, tail: &[&str]) -> Vec<PathBuf> {
    let mut years: Vec<PathBuf> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    years.sort();
    years.reverse();
    years
        .into_iter()
        .map(|year| tail.iter().fold(year, |path, part| path.join(part)))
        .collect()
}

/// PATH first, then where TeX Live, MiKTeX and MacTeX install by default.
fn tex_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|path| {
            std::env::split_paths(&path)
                .filter(|p| p.is_absolute())
                .collect()
        })
        .unwrap_or_default();
    #[cfg(windows)]
    {
        for tail in [["bin", "windows"], ["bin", "win64"], ["bin", "win32"]] {
            dirs.extend(by_year(Path::new(r"C:\texlive"), &tail));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(local).join(r"Programs\MiKTeX\miktex\bin\x64"));
        }
        if let Some(programs) = std::env::var_os("ProgramFiles") {
            dirs.push(PathBuf::from(programs).join(r"MiKTeX\miktex\bin\x64"));
        }
    }
    #[cfg(target_os = "macos")]
    {
        dirs.push(PathBuf::from("/Library/TeX/texbin"));
        dirs.extend(by_year(
            Path::new("/usr/local/texlive"),
            &["bin", "universal-darwin"],
        ));
    }
    #[cfg(target_os = "linux")]
    {
        for tail in [["bin", "x86_64-linux"], ["bin", "aarch64-linux"]] {
            dirs.extend(by_year(Path::new("/usr/local/texlive"), &tail));
        }
    }
    dirs
}

fn find_local() -> Option<LocalTex> {
    tex_dirs().into_iter().find_map(|dir| {
        let engines: Vec<String> = ["pdflatex", "xelatex", "lualatex"]
            .into_iter()
            .filter(|engine| dir.join(exe(engine)).is_file())
            .map(str::to_owned)
            .collect();
        if engines.is_empty() {
            return None;
        }
        let text = dir.to_string_lossy().to_lowercase();
        let distribution = if text.contains("miktex") {
            "MiKTeX"
        } else if text.contains("texlive") || text.contains("texbin") {
            "TeX Live"
        } else {
            "TeX"
        };
        Some(LocalTex {
            distribution: distribution.into(),
            bin: dir.display().to_string(),
            latexmk: dir.join(exe("latexmk")).is_file(),
            engines,
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TexStatus {
    local: Option<LocalTex>,
    /// The bundled Tectonic's version, when the installation has it.
    builtin: Option<String>,
}

#[tauri::command]
pub async fn writing_tex_status() -> Result<TexStatus, String> {
    let local = tauri::async_runtime::spawn_blocking(find_local)
        .await
        .map_err(|e| e.to_string())?;
    Ok(TexStatus {
        local,
        builtin: bundled().map(|_| tectonic_version().to_owned()),
    })
}

fn relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if value.contains('\0')
        || path.is_absolute()
        || path
            .components()
            .any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
    {
        return Err("路径必须是稿件文件夹里的相对路径。".into());
    }
    Ok(path.to_path_buf())
}

#[derive(Debug)]
struct Manuscript {
    dir: PathBuf,
    main: PathBuf,
    stem: String,
    cache: PathBuf,
}

/// Checks that the folder and main document lie inside the project and finds the cache folder.
fn manuscript(
    project_root: &Path,
    data_dir: &Path,
    project: &str,
    folder: &str,
    main: &str,
) -> Result<Manuscript, String> {
    let root = project_root
        .canonicalize()
        .map_err(|_| "写作文件夹不存在。")?;
    let dir = if folder.is_empty() {
        root.clone()
    } else {
        root.join(relative(folder)?)
    };
    let dir = dir.canonicalize().map_err(|_| "稿件文件夹不存在。")?;
    if !dir.starts_with(&root) || !dir.is_dir() {
        return Err("稿件文件夹必须在写作文件夹里。".into());
    }
    scientify_core::research::reject_links(&dir)?;
    let main_rel = relative(main)?;
    if main_rel.extension().and_then(|e| e.to_str()) != Some("tex") {
        return Err("主文档必须是 .tex 文件。".into());
    }
    let main_path = dir
        .join(&main_rel)
        .canonicalize()
        .map_err(|_| format!("找不到主文档 {main}。"))?;
    if !main_path.starts_with(&dir) || !main_path.is_file() {
        return Err(format!("找不到主文档 {main}。"));
    }
    let stem = main_rel
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("主文档名称无效。")?
        .to_owned();
    let project_dir: String = project
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    let key = Sha256::digest(dir.to_string_lossy().as_bytes())
        .iter()
        .take(8)
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    Ok(Manuscript {
        dir,
        main: main_rel,
        stem,
        cache: data_dir
            .join("cache")
            .join("latex")
            .join(if project_dir.is_empty() {
                "project"
            } else {
                &project_dir
            })
            .join(key),
    })
}

// Manuscripts live in the project's writing folder, apart from its code.
fn locate(state: &AppState, project: &str, folder: &str, main: &str) -> Result<Manuscript, String> {
    let root = crate::research::writing_root(&state.storage, &state.files, project)?;
    manuscript(&root, state.storage.directory(), project, folder, main)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CompileRequest {
    folder: String,
    main: String,
    compiler: String,
    /// "auto" uses the computer's TeX when it has the compiler, else the bundled engine.
    #[serde(default = "auto_engine")]
    engine: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    stop_on_error: bool,
    #[serde(default)]
    clean: bool,
    #[serde(default)]
    write_pdf: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompileResult {
    status: &'static str,
    engine: String,
    /// Whether the bundled engine compiled it (it downloads missing packages by itself).
    bundled: bool,
    duration_ms: u64,
    log: String,
    output: String,
    pdf: bool,
    root: String,
}

fn jobs() -> &'static Mutex<HashMap<PathBuf, Arc<AtomicBool>>> {
    static JOBS: OnceLock<Mutex<HashMap<PathBuf, Arc<AtomicBool>>>> = OnceLock::new();
    JOBS.get_or_init(Default::default)
}

enum Step {
    Done(ExitStatus, String),
    Cancelled,
}

/// Keeps the last `OUTPUT_LIMIT` bytes of a stream.
fn tail_reader(mut stream: impl Read + Send + 'static) -> std::thread::JoinHandle<Vec<u8>> {
    std::thread::spawn(move || {
        let mut kept = Vec::new();
        let mut buffer = [0u8; 8192];
        while let Ok(count) = stream.read(&mut buffer) {
            if count == 0 {
                break;
            }
            kept.extend_from_slice(&buffer[..count]);
            if kept.len() > OUTPUT_LIMIT * 2 {
                kept.drain(..kept.len() - OUTPUT_LIMIT);
            }
        }
        if kept.len() > OUTPUT_LIMIT {
            kept.drain(..kept.len() - OUTPUT_LIMIT);
        }
        kept
    })
}

/// Runs one tool in its own process tree, which is ended on cancel or timeout.
fn run_step(mut command: Command, cancel: &AtomicBool, deadline: Instant) -> Result<Step, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::experiments::runner::job::CREATION_FLAGS);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 TeX 程序：{e}"))?;
    #[cfg(windows)]
    let job = match crate::experiments::runner::job::Job::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    #[cfg(unix)]
    let mut group = crate::unix_process::Group::new(child.id());
    let stdout = tail_reader(child.stdout.take().ok_or("无法读取输出。")?);
    let stderr = tail_reader(child.stderr.take().ok_or("无法读取输出。")?);
    #[allow(unused_mut)]
    let mut stop = |child: &mut std::process::Child| {
        #[cfg(windows)]
        let _ = job.terminate();
        #[cfg(unix)]
        group.stop();
        let _ = child.kill();
        let _ = child.wait();
    };
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if cancel.load(Ordering::SeqCst) {
            stop(&mut child);
            return Ok(Step::Cancelled);
        }
        if Instant::now() > deadline {
            stop(&mut child);
            return Err("编译超过 15 分钟，已停止。".into());
        }
        std::thread::sleep(Duration::from_millis(40));
    };
    let mut output = stdout.join().unwrap_or_default();
    output.extend(stderr.join().unwrap_or_default());
    Ok(Step::Done(
        status,
        String::from_utf8_lossy(&output).into_owned(),
    ))
}

fn latexmk_args(m: &Manuscript, compiler: &str, draft: bool, stop: bool) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        match compiler {
            "xelatex" => "-xelatex",
            "lualatex" => "-lualatex",
            _ => "-pdf",
        }
        .into(),
        "-interaction=nonstopmode".into(),
        "-file-line-error".into(),
        "-synctex=1".into(),
        if stop { "-halt-on-error" } else { "-f" }.into(),
    ];
    let mut outdir = OsString::from("-outdir=");
    outdir.push(&m.cache);
    args.push(outdir);
    if draft {
        args.push(r"-usepretex=\PassOptionsToPackage{draft}{graphicx}".into());
    }
    args.push(m.main.clone().into_os_string());
    args
}

/// The packages compiled into the installer by `scripts/prepare-tectonic.mjs`.
fn seed_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    let bundled = app
        .path()
        .resource_dir()
        .ok()
        .map(|dir| dir.join("tectonic-cache"));
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("release-resources")
        .join("tectonic-cache");
    bundled
        .into_iter()
        .chain(std::iter::once(development))
        .find(|dir| dir.join("seed.json").is_file())
}

/// Copies the bundled packages into the engine's cache once (again when an update ships
/// different ones), so common documents compile offline from the first run. Files already in
/// the cache are kept; the marker is written last, so an interrupted copy is redone.
fn seed_cache(seed: &Path, cache: &Path) -> std::io::Result<()> {
    fn copy_missing(from: &Path, to: &Path, top: bool) -> std::io::Result<()> {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            let target = to.join(entry.file_name());
            let kind = entry.file_type()?;
            if kind.is_dir() {
                copy_missing(&entry.path(), &target, false)?;
            } else if kind.is_file()
                && !(top && entry.file_name() == "seed.json")
                && !target.exists()
            {
                std::fs::copy(entry.path(), &target)?;
            }
        }
        Ok(())
    }
    let record = std::fs::read_to_string(seed.join("seed.json"))?;
    let complete = serde_json::from_str::<serde_json::Value>(&record)
        .is_ok_and(|value| value["complete"] == serde_json::Value::Bool(true));
    let marker = cache.join("scientify-seed.json");
    if !complete || std::fs::read_to_string(&marker).ok().as_deref() == Some(record.as_str()) {
        return Ok(());
    }
    copy_missing(seed, cache, true)?;
    std::fs::write(marker, record)
}

/// Whether the engine failed because it could not reach its package server.
fn offline(output: &str) -> bool {
    let text = output.to_lowercase();
    [
        "error sending request",
        "dns error",
        "failed to lookup address",
        "could not resolve",
        "connection refused",
        "connection reset",
        "operation timed out",
        "network is unreachable",
        "no such host is known",
    ]
    .iter()
    .any(|needle| text.contains(needle))
}

fn tectonic_args(m: &Manuscript) -> Vec<OsString> {
    vec![
        "-X".into(),
        "compile".into(),
        m.main.clone().into_os_string(),
        "--outdir".into(),
        m.cache.clone().into_os_string(),
        "--synctex".into(),
        "--keep-logs".into(),
        "--keep-intermediates".into(),
        "--untrusted".into(),
    ]
}

/// Without latexmk: engine, then BibTeX or Biber when the document asks for it, then twice more.
fn compile_by_hand(
    m: &Manuscript,
    bin: &Path,
    compiler: &str,
    stop: bool,
    cancel: &AtomicBool,
    deadline: Instant,
) -> Result<(Option<ExitStatus>, String), String> {
    let mut output = String::new();
    let engine = |output: &mut String| -> Result<Option<ExitStatus>, String> {
        let mut command = Command::new(bin.join(exe(compiler)));
        command
            .current_dir(&m.dir)
            .arg("-interaction=nonstopmode")
            .arg("-file-line-error")
            .arg("-synctex=1");
        if stop {
            command.arg("-halt-on-error");
        }
        let mut outdir = OsString::from("-output-directory=");
        outdir.push(&m.cache);
        command.arg(outdir).arg(&m.main);
        match run_step(command, cancel, deadline)? {
            Step::Done(status, text) => {
                output.push_str(&text);
                Ok(Some(status))
            }
            Step::Cancelled => Ok(None),
        }
    };
    let Some(first) = engine(&mut output)? else {
        return Ok((None, output));
    };
    if stop && !first.success() {
        return Ok((Some(first), output));
    }
    let aux = std::fs::read_to_string(m.cache.join(format!("{}.aux", m.stem))).unwrap_or_default();
    let mut separator = OsString::from(&m.dir);
    separator.push(if cfg!(windows) { ";" } else { ":" });
    let bibliography = if m.cache.join(format!("{}.bcf", m.stem)).is_file() {
        let mut command = Command::new(bin.join(exe("biber")));
        command
            .current_dir(&m.cache)
            .arg("--input-directory")
            .arg(&m.dir)
            .arg(&m.stem);
        Some(command)
    } else if aux.contains("\\bibdata") {
        let mut command = Command::new(bin.join(exe("bibtex")));
        command
            .current_dir(&m.cache)
            .env("BIBINPUTS", &separator)
            .env("BSTINPUTS", &separator)
            .arg(&m.stem);
        Some(command)
    } else {
        None
    };
    if let Some(command) = bibliography {
        match run_step(command, cancel, deadline)? {
            Step::Done(_, text) => output.push_str(&text),
            Step::Cancelled => return Ok((None, output)),
        }
        if engine(&mut output)?.is_none() {
            return Ok((None, output));
        }
    }
    // The last pass settles cross-references; its status is the result.
    let last = engine(&mut output)?;
    Ok((last, output))
}

fn read_capped(path: &Path, limit: u64) -> Option<Vec<u8>> {
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length > limit {
        use std::io::{Seek, SeekFrom};
        file.seek(SeekFrom::Start(length - limit)).ok()?;
    }
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

fn auto_engine() -> String {
    "auto".into()
}

enum Engine<'a> {
    Local(&'a LocalTex),
    Bundled(PathBuf),
}

/// The computer's TeX Live or MiKTeX when asked for or when it has the compiler, otherwise
/// the bundled Tectonic, so a fresh installation compiles without any setup.
fn choose_engine<'a>(
    choice: &str,
    compiler: &str,
    local: Option<&'a LocalTex>,
    bundled: Option<PathBuf>,
) -> Result<Engine<'a>, String> {
    let missing = || "没有找到内置引擎，请重新安装 Scientify。".to_string();
    match (choice, local) {
        ("local", None) => Err("没有找到本机 TeX，请在编译设置里改用内置引擎。".into()),
        ("local", Some(tex)) if !tex.engines.iter().any(|e| e == compiler) => Err(format!(
            "本机的 {} 没有 {compiler}，请换一个编译器。",
            tex.distribution
        )),
        ("local", Some(tex)) => Ok(Engine::Local(tex)),
        ("builtin", _) => bundled.map(Engine::Bundled).ok_or_else(missing),
        (_, Some(tex)) if tex.engines.iter().any(|e| e == compiler) => Ok(Engine::Local(tex)),
        _ => bundled.map(Engine::Bundled).ok_or_else(missing),
    }
}

#[tauri::command]
pub async fn writing_compile<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    request: CompileRequest,
) -> Result<CompileResult, String> {
    crate::library::trusted(&view)?;
    if request.write_pdf {
        crate::collaboration::permissions::require_write(&state.storage, &project_id, "code")?;
    }
    if !["pdflatex", "xelatex", "lualatex"].contains(&request.compiler.as_str()) {
        return Err("编译器必须是 pdfLaTeX、XeLaTeX 或 LuaLaTeX。".into());
    }
    if !["auto", "local", "builtin"].contains(&request.engine.as_str()) {
        return Err("TeX 环境必须是自动、本机或内置引擎。".into());
    }
    let m = locate(&state, &project_id, &request.folder, &request.main)?;
    let tectonic_cache = state
        .storage
        .directory()
        .join("engines")
        .join("tectonic-cache");
    let seed = seed_dir(view.app_handle());
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut running = jobs().lock().map_err(|e| e.to_string())?;
        if running.contains_key(&m.cache) {
            return Err("这篇稿件正在编译。".into());
        }
        running.insert(m.cache.clone(), cancel.clone());
    }
    let key = m.cache.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let since = SystemTime::now();
        let deadline = started + COMPILE_LIMIT;
        if request.clean {
            let _ = std::fs::remove_dir_all(&m.cache);
        }
        std::fs::create_dir_all(&m.cache).map_err(|e| e.to_string())?;
        let local = find_local();
        let mut by_bundled = false;
        let (engine, outcome) = match choose_engine(
            &request.engine,
            &request.compiler,
            local.as_ref(),
            bundled(),
        )? {
            Engine::Local(tex) => {
                let bin = PathBuf::from(&tex.bin);
                if tex.latexmk && tex.distribution != "MiKTeX" {
                    let mut command = Command::new(bin.join(exe("latexmk")));
                    command.current_dir(&m.dir).args(latexmk_args(
                        &m,
                        &request.compiler,
                        request.draft,
                        request.stop_on_error,
                    ));
                    let label = format!("latexmk · {}", tex.distribution);
                    match run_step(command, &cancel, deadline)? {
                        Step::Done(status, text) => (label, (Some(status), text)),
                        Step::Cancelled => (label, (None, String::new())),
                    }
                } else {
                    (
                        format!("{} · {}", request.compiler, tex.distribution),
                        compile_by_hand(
                            &m,
                            &bin,
                            &request.compiler,
                            request.stop_on_error,
                            &cancel,
                            deadline,
                        )?,
                    )
                }
            }
            Engine::Bundled(tectonic) => {
                by_bundled = true;
                std::fs::create_dir_all(&tectonic_cache).map_err(|e| e.to_string())?;
                if let Some(seed) = &seed {
                    // Only a head start: without it the engine downloads what it needs.
                    let _ = seed_cache(seed, &tectonic_cache);
                }
                let run = |only_cached: bool| {
                    let mut command = Command::new(&tectonic);
                    command
                        .current_dir(&m.dir)
                        .env("TECTONIC_CACHE_DIR", &tectonic_cache)
                        .args(tectonic_args(&m));
                    if only_cached {
                        command.arg("--only-cached");
                    }
                    run_step(command, &cancel, deadline)
                };
                let label = format!("内置引擎 Tectonic {}", tectonic_version());
                match run(false)? {
                    // Offline, the packages already in the cache are still enough for most papers.
                    Step::Done(status, text) if !status.success() && offline(&text) => {
                        match run(true)? {
                            Step::Done(status, more) => {
                                (label, (Some(status), format!("{text}\n{more}")))
                            }
                            Step::Cancelled => (label, (None, text)),
                        }
                    }
                    Step::Done(status, text) => (label, (Some(status), text)),
                    Step::Cancelled => (label, (None, String::new())),
                }
            }
        };
        let pdf_path = m.cache.join(format!("{}.pdf", m.stem));
        // An old PDF from an earlier run does not count as this run's output.
        let fresh = std::fs::metadata(&pdf_path)
            .and_then(|meta| meta.modified())
            .is_ok_and(|modified| modified >= since);
        let (status, output) = outcome;
        let log = read_capped(&m.cache.join(format!("{}.log", m.stem)), LOG_LIMIT)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        if fresh && request.write_pdf {
            std::fs::copy(&pdf_path, m.dir.join(format!("{}.pdf", m.stem)))
                .map_err(|e| e.to_string())?;
        }
        Ok::<_, String>(CompileResult {
            status: match status {
                None => "cancelled",
                Some(status) if status.success() && fresh => "success",
                Some(_) => "failed",
            },
            engine,
            bundled: by_bundled,
            duration_ms: started.elapsed().as_millis() as u64,
            log,
            output,
            pdf: fresh || pdf_path.is_file(),
            root: m.dir.display().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string());
    if let Ok(mut running) = jobs().lock() {
        running.remove(&key);
    }
    result?
}

#[tauri::command]
pub async fn writing_cancel(
    state: State<'_, AppState>,
    project_id: String,
    folder: String,
    main: String,
) -> Result<(), String> {
    let m = locate(&state, &project_id, &folder, &main)?;
    if let Some(flag) = jobs().lock().map_err(|e| e.to_string())?.get(&m.cache) {
        flag.store(true, Ordering::SeqCst);
    }
    Ok(())
}

#[tauri::command]
pub async fn writing_pdf(
    state: State<'_, AppState>,
    project_id: String,
    folder: String,
    main: String,
) -> Result<tauri::ipc::Response, String> {
    let m = locate(&state, &project_id, &folder, &main)?;
    let path = m.cache.join(format!("{}.pdf", m.stem));
    let length = std::fs::metadata(&path)
        .map_err(|_| "还没有编译出 PDF。")?
        .len();
    if length > PDF_LIMIT {
        return Err("PDF 超过 200 MB。".into());
    }
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)
        .map_err(|e| e.to_string())
}

/// The SyncTeX data as text; the frontend maps source lines and PDF positions with it.
#[tauri::command]
pub async fn writing_synctex(
    state: State<'_, AppState>,
    project_id: String,
    folder: String,
    main: String,
) -> Result<String, String> {
    let m = locate(&state, &project_id, &folder, &main)?;
    tauri::async_runtime::spawn_blocking(move || {
        let plain = m.cache.join(format!("{}.synctex", m.stem));
        let packed = m.cache.join(format!("{}.synctex.gz", m.stem));
        let mut text = String::new();
        if packed.is_file() {
            let file = std::fs::File::open(&packed).map_err(|e| e.to_string())?;
            flate2::read::GzDecoder::new(file)
                .take(256 * 1024 * 1024)
                .read_to_string(&mut text)
                .map_err(|e| e.to_string())?;
        } else if plain.is_file() {
            text = std::fs::read_to_string(&plain).map_err(|e| e.to_string())?;
        } else {
            return Err("这次编译没有生成 SyncTeX。".into());
        }
        Ok(text)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Saves the compiled PDF where the person chooses.
#[tauri::command]
pub async fn writing_export_pdf<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    project_id: String,
    folder: String,
    main: String,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let m = locate(&state, &project_id, &folder, &main)?;
    let source = m.cache.join(format!("{}.pdf", m.stem));
    if !source.is_file() {
        return Err("还没有编译出 PDF。".into());
    }
    let name = format!("{}.pdf", m.stem);
    tauri::async_runtime::spawn_blocking(move || {
        let Some(target) = app
            .dialog()
            .file()
            .set_file_name(&name)
            .add_filter("PDF", &["pdf"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let target = target.into_path().map_err(|e| e.to_string())?;
        std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
        Ok(Some(target.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// A manuscript folder that was just created from a zip or a Git repository.
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Imported {
    folder: String,
    /// Paths inside the new folder, with forward slashes.
    files: Vec<String>,
}

const RESERVED: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

/// A file or folder name that Windows, macOS and Linux all accept.
fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c.is_control() || r#"<>:"/\|?*"#.contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    // Windows drops trailing dots and spaces, which would merge different names.
    let cleaned = cleaned.trim_end_matches(['.', ' ']);
    let stem = cleaned.split('.').next().unwrap_or_default().to_lowercase();
    if cleaned.is_empty() {
        "_".into()
    } else if RESERVED.contains(&stem.as_str()) {
        format!("_{cleaned}")
    } else {
        cleaned.to_owned()
    }
}

/// The parts of an archive path to write, nothing for system clutter, and an error for
/// paths that would escape the folder.
fn entry_path(name: &str) -> Result<Option<Vec<String>>, String> {
    if name.starts_with('/') || name.split('/').any(|part| part == "..") {
        return Err(format!("压缩包里有不安全的路径：{name}"));
    }
    let parts: Vec<&str> = name
        .split('/')
        .filter(|part| !part.is_empty() && *part != ".")
        .collect();
    let Some(last) = parts.last() else {
        return Ok(None);
    };
    if parts[0] == "__MACOSX"
        || last.starts_with("._")
        || [".DS_Store", "Thumbs.db", "desktop.ini"].contains(last)
    {
        return Ok(None);
    }
    Ok(Some(parts.iter().map(|part| safe_name(part)).collect()))
}

/// `base`, or `base 2`, `base 3`… whichever the project folder does not have yet.
fn unique_folder(root: &Path, base: &str) -> String {
    let base = if base.is_empty() || base == "_" {
        "manuscript"
    } else {
        base
    };
    let existing: HashSet<String> = std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().to_lowercase())
        .collect();
    (1..)
        .map(|n| {
            if n == 1 {
                base.to_owned()
            } else {
                format!("{base} {n}")
            }
        })
        .find(|name| {
            let name = name.to_lowercase();
            !existing.contains(&name) && !existing.contains(&format!(".{name}.importing"))
        })
        .unwrap_or_else(|| base.to_owned())
}

/// Unpacks a zip into a new folder of the project. A single top folder that holds
/// everything (what zipping a folder produces) is not kept.
fn unpack(zip: &[u8], root: &Path, hint: &str) -> Result<Imported, String> {
    let items = crate::archive::list(zip, ZIP_ENTRIES)?;
    let mut files = Vec::new();
    let mut total = 0u64;
    for item in &items {
        if let Some(parts) = entry_path(&item.name)? {
            total += item.size;
            if total > UNPACKED_LIMIT {
                return Err("压缩包解压后超过 1 GB。".into());
            }
            files.push((parts, item));
        }
    }
    let Some(first) = files.first().map(|(parts, _)| parts[0].clone()) else {
        return Err("压缩包里没有文件。".into());
    };
    if files
        .iter()
        .all(|(parts, _)| parts.len() > 1 && parts[0] == first)
    {
        for (parts, _) in &mut files {
            parts.remove(0);
        }
    }
    let mut seen = HashSet::new();
    for (parts, _) in &files {
        if !seen.insert(parts.join("/").to_lowercase()) {
            return Err(format!("压缩包里有重名的文件：{}", parts.join("/")));
        }
    }
    let folder = unique_folder(root, &safe_name(hint.trim()));
    let staging = root.join(format!(".{folder}.importing"));
    let _ = std::fs::remove_dir_all(&staging);
    let written = (|| {
        for (parts, item) in &files {
            let path = parts
                .iter()
                .fold(staging.clone(), |path, part| path.join(part));
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            }
            std::fs::write(&path, crate::archive::extract(zip, item)?)
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&staging, root.join(&folder)).map_err(|e| e.to_string())
    })();
    if let Err(error) = written {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error);
    }
    let mut paths: Vec<String> = files.iter().map(|(parts, _)| parts.join("/")).collect();
    paths.sort();
    Ok(Imported {
        folder,
        files: paths,
    })
}

fn writing_folder(state: &AppState, project: &str) -> Result<PathBuf, String> {
    crate::research::writing_root(&state.storage, &state.files, project)
}

/// Lets the person pick a zip (for example Overleaf's "Download source") and unpacks it into
/// a new folder of the project.
#[tauri::command]
pub async fn writing_import_zip<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    project_id: String,
) -> Result<Option<Imported>, String> {
    use tauri_plugin_dialog::DialogExt;
    crate::library::trusted(&view)?;
    crate::collaboration::permissions::require_write(&state.storage, &project_id, "code")?;
    let root = writing_folder(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let Some(picked) = app
            .dialog()
            .file()
            .add_filter("ZIP", &["zip"])
            .blocking_pick_file()
        else {
            return Ok(None);
        };
        let path = picked.into_path().map_err(|e| e.to_string())?;
        if std::fs::metadata(&path).map_err(|e| e.to_string())?.len() > ZIP_LIMIT {
            return Err("压缩包超过 512 MB。".into());
        }
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let hint = path
            .file_stem()
            .map(|stem| stem.to_string_lossy().into_owned())
            .unwrap_or_default();
        unpack(&bytes, &root, &hint).map(Some)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// An address with a password in it would end up in `.git/config`.
fn has_password(url: &str) -> bool {
    url.split_once("://")
        .and_then(|(_, rest)| rest.split('/').next())
        .and_then(|authority| authority.rsplit_once('@'))
        .is_some_and(|(user, _)| user.contains(':'))
}

fn files_in(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
        if out.len() >= ZIP_ENTRIES {
            return;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let path = format!("{prefix}{name}");
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => files_in(&entry.path(), &format!("{path}/"), out),
            Ok(kind) if kind.is_file() => out.push(path),
            _ => {}
        }
    }
}

/// Clones a Git repository (an Overleaf project's Git address, for one) into a new folder.
/// The token goes to Git through the environment: not on the command line, not saved.
#[tauri::command]
pub async fn writing_clone<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    url: String,
    name: String,
    token: Option<String>,
) -> Result<Imported, String> {
    crate::library::trusted(&view)?;
    crate::collaboration::permissions::require_write(&state.storage, &project_id, "code")?;
    let url = url.trim().to_owned();
    crate::experiments::catalog::clone_url(&url)?;
    if has_password(&url) {
        return Err("地址里不要带密码或令牌，把令牌填在下面。".into());
    }
    let token = token
        .map(|token| token.trim().to_owned())
        .filter(|token| !token.is_empty());
    if let Some(token) = &token {
        if !url.starts_with("https://") {
            return Err("令牌只能用于 https 地址。".into());
        }
        if token.chars().any(char::is_control) {
            return Err("令牌无效。".into());
        }
    }
    let root = writing_folder(&state, &project_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let folder = unique_folder(&root, &safe_name(name.trim()));
        let target = root.join(&folder);
        let mut command = crate::research::git_command(&root)?;
        command
            .args(["-c", "protocol.ext.allow=never", "clone", "--quiet", "--"])
            .arg(&url)
            .arg(&target);
        if let Some(token) = &token {
            use base64::Engine;
            let basic = base64::engine::general_purpose::STANDARD.encode(format!("git:{token}"));
            command
                .env("GIT_CONFIG_COUNT", "1")
                .env("GIT_CONFIG_KEY_0", "http.extraHeader")
                .env(
                    "GIT_CONFIG_VALUE_0",
                    format!("Authorization: Basic {basic}"),
                );
        }
        let (status, _, error) =
            crate::research::bounded_git_within(command, Duration::from_secs(30 * 60))?;
        if !status.success() {
            // The folder did not exist before, so whatever is there came from this clone.
            let _ = std::fs::remove_dir_all(&target);
            let message = String::from_utf8_lossy(&error);
            let message = message.trim().trim_start_matches("fatal: ");
            return Err(
                if message.contains("Authentication failed") || message.contains(" 403") {
                    "令牌不对或已过期，请在 Overleaf 的账户设置里重新生成。".into()
                } else {
                    format!("克隆失败：{message}")
                },
            );
        }
        let mut files = Vec::new();
        files_in(&target, "", &mut files);
        files.sort();
        Ok(Imported { folder, files })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// The chosen files of a manuscript as (name in the zip, path on disk), plus the compiled
/// .bbl next to the main document when asked for (arXiv wants it).
fn source_entries(
    m: &Manuscript,
    files: &[String],
    bbl: bool,
) -> Result<Vec<(String, PathBuf)>, String> {
    let mut entries = Vec::new();
    for file in files {
        let path = m
            .dir
            .join(relative(file)?)
            .canonicalize()
            .map_err(|_| format!("找不到 {file}。"))?;
        if !path.starts_with(&m.dir) || !path.is_file() {
            return Err(format!("找不到 {file}。"));
        }
        entries.push((
            file.replace('\\', "/").trim_start_matches("./").to_owned(),
            path,
        ));
    }
    if bbl {
        let path = m.cache.join(format!("{}.bbl", m.stem));
        if !path.is_file() {
            return Err("还没有 .bbl，请先编译一次。".into());
        }
        let name = m
            .main
            .with_extension("bbl")
            .to_string_lossy()
            .replace('\\', "/");
        if !entries
            .iter()
            .any(|(entry, _)| entry.eq_ignore_ascii_case(&name))
        {
            entries.push((name, path));
        }
    }
    if entries.is_empty() {
        return Err("没有选中文件。".into());
    }
    Ok(entries)
}

/// Saves the chosen manuscript files as a zip where the person chooses.
#[tauri::command]
pub async fn writing_export_source<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    state: State<'_, AppState>,
    project_id: String,
    folder: String,
    main: String,
    files: Vec<String>,
    bbl: bool,
) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let m = locate(&state, &project_id, &folder, &main)?;
    let entries = source_entries(&m, &files, bbl)?;
    let name = format!(
        "{}.zip",
        m.dir
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| m.stem.clone())
    );
    tauri::async_runtime::spawn_blocking(move || {
        let Some(target) = app
            .dialog()
            .file()
            .set_file_name(&name)
            .add_filter("ZIP", &["zip"])
            .blocking_save_file()
        else {
            return Ok(None);
        };
        let target = target.into_path().map_err(|e| e.to_string())?;
        let written = (|| {
            let file = std::fs::File::create(&target).map_err(|e| e.to_string())?;
            let mut writer = crate::archive::Writer::new(std::io::BufWriter::new(file));
            for (entry, path) in &entries {
                writer.add(entry, &std::fs::read(path).map_err(|e| e.to_string())?)?;
            }
            writer.finish().map(|_| ())
        })();
        if let Err(error) = written {
            let _ = std::fs::remove_file(&target);
            return Err(error);
        }
        Ok(Some(target.display().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manuscripts_stay_inside_the_project() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join("paper/sections")).unwrap();
        std::fs::write(project.join("paper/main.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(project.join("paper/notes.md"), "").unwrap();
        std::fs::write(temp.path().join("outside.tex"), "").unwrap();
        let data = temp.path().join("data");
        let m = manuscript(&project, &data, "p-1", "paper", "main.tex").unwrap();
        assert_eq!(m.stem, "main");
        assert!(m.dir.ends_with("paper"));
        assert!(m
            .cache
            .starts_with(data.join("cache").join("latex").join("p-1")));
        let again = manuscript(&project, &data, "p-1", "paper", "./main.tex").unwrap();
        assert_eq!(again.cache, m.cache);
        assert!(manuscript(&project, &data, "p-1", "", "paper/main.tex").is_ok());
        for (folder, main) in [
            ("../", "outside.tex"),
            ("paper", "../../outside.tex"),
            ("paper", "notes.md"),
            ("paper", "missing.tex"),
            ("missing", "main.tex"),
            ("paper", "C:/main.tex"),
        ] {
            assert!(
                manuscript(&project, &data, "p-1", folder, main).is_err(),
                "{folder} {main}"
            );
        }
    }

    #[test]
    fn compile_arguments_keep_outputs_in_the_cache() {
        let m = Manuscript {
            dir: PathBuf::from("paper"),
            main: PathBuf::from("main.tex"),
            stem: "main".into(),
            cache: PathBuf::from("cache"),
        };
        let args = |a: Vec<OsString>| {
            a.into_iter()
                .map(|s| s.to_string_lossy().into_owned())
                .collect::<Vec<_>>()
        };
        let latexmk = args(latexmk_args(&m, "xelatex", true, false));
        assert_eq!(latexmk[0], "-xelatex");
        assert!(latexmk.contains(&"-f".to_owned()));
        assert!(latexmk.contains(&"-outdir=cache".to_owned()));
        assert!(latexmk.contains(&"-synctex=1".to_owned()));
        assert!(latexmk.iter().any(|a| a.starts_with("-usepretex=")));
        assert_eq!(latexmk.last().unwrap(), "main.tex");
        assert!(
            args(latexmk_args(&m, "pdflatex", false, true)).contains(&"-halt-on-error".to_owned())
        );
        let tectonic = args(tectonic_args(&m));
        assert!(tectonic.contains(&"--untrusted".to_owned()));
        assert!(tectonic.windows(2).any(|w| w == ["--outdir", "cache"]));
    }

    #[test]
    fn the_bundled_engine_comes_from_the_pinned_manifest() {
        let manifest: serde_json::Value = serde_json::from_str(TECTONIC_MANIFEST).unwrap();
        assert!(!tectonic_version().is_empty());
        let asset = &manifest["assets"][TARGET];
        assert!(
            asset["file"]
                .as_str()
                .is_some_and(|file| file.contains(tectonic_version())),
            "no Tectonic pinned for {TARGET}"
        );
        assert_eq!(asset["sha256"].as_str().map(str::len), Some(64));
    }

    #[test]
    fn local_tex_is_preferred_and_the_bundled_engine_covers_the_rest() {
        let tex = LocalTex {
            distribution: "TeX Live".into(),
            bin: "bin".into(),
            latexmk: true,
            engines: vec!["pdflatex".into()],
        };
        let engine = Some(PathBuf::from("tectonic"));
        let pick = |choice, compiler, local, bundled| match choose_engine(
            choice, compiler, local, bundled,
        ) {
            Ok(Engine::Local(_)) => "local".to_owned(),
            Ok(Engine::Bundled(_)) => "bundled".to_owned(),
            Err(error) => error,
        };
        assert_eq!(
            pick("auto", "pdflatex", Some(&tex), engine.clone()),
            "local"
        );
        assert_eq!(
            pick("auto", "xelatex", Some(&tex), engine.clone()),
            "bundled"
        );
        assert_eq!(pick("auto", "pdflatex", None, engine.clone()), "bundled");
        assert_eq!(
            pick("builtin", "pdflatex", Some(&tex), engine.clone()),
            "bundled"
        );
        assert_eq!(pick("local", "pdflatex", Some(&tex), None), "local");
        assert!(pick("local", "xelatex", Some(&tex), engine.clone()).contains("没有 xelatex"));
        assert!(pick("local", "pdflatex", None, engine).contains("本机 TeX"));
        assert!(pick("auto", "pdflatex", None, None).contains("重新安装"));
    }

    fn zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut writer = crate::archive::Writer::new(Vec::new());
        for (name, text) in files {
            writer.add(name, text.as_bytes()).unwrap();
        }
        writer.finish().unwrap()
    }

    #[test]
    fn zips_unpack_into_a_new_folder_without_their_wrapper_or_clutter() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        std::fs::create_dir(root.join("Paper")).unwrap();
        let bytes = zip(&[
            ("Paper/main.tex", "\\documentclass{article}"),
            ("Paper/figs/plot.png", "png"),
            ("Paper/.DS_Store", ""),
            ("__MACOSX/Paper/._main.tex", ""),
            ("Paper/con.tex", "reserved"),
            ("Paper/a?b.tex", "odd"),
        ]);
        let imported = unpack(&bytes, root, "Paper").unwrap();
        assert_eq!(
            imported.folder, "Paper 2",
            "an existing folder is never reused"
        );
        assert_eq!(
            imported.files,
            ["_con.tex", "a_b.tex", "figs/plot.png", "main.tex"]
        );
        let dir = root.join("Paper 2");
        assert_eq!(
            std::fs::read_to_string(dir.join("main.tex")).unwrap(),
            "\\documentclass{article}"
        );
        assert!(!root.join(".Paper 2.importing").exists());
        // Overleaf zips have no wrapper folder; files stay where they are.
        let flat = unpack(&zip(&[("main.tex", "x"), ("sec/a.tex", "y")]), root, "").unwrap();
        assert_eq!(flat.folder, "manuscript");
        assert_eq!(flat.files, ["main.tex", "sec/a.tex"]);
    }

    #[test]
    fn zips_that_escape_the_folder_or_collide_are_refused_whole() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        for files in [
            vec![("main.tex", "x"), ("../evil.tex", "x")],
            vec![("main.tex", "x"), ("/etc/evil", "x")],
            vec![("a/../../evil", "x")],
            vec![("Main.tex", "x"), ("main.tex", "y")],
            vec![(".DS_Store", "")],
        ] {
            assert!(unpack(&zip(&files), root, "bad").is_err(), "{files:?}");
        }
        assert_eq!(
            std::fs::read_dir(root).unwrap().count(),
            0,
            "nothing is left behind"
        );
    }

    #[test]
    fn bundled_packages_seed_the_cache_once_without_overwriting() {
        let temp = tempfile::tempdir().unwrap();
        let seed = temp.path().join("seed");
        let cache = temp.path().join("cache");
        std::fs::create_dir_all(seed.join("files/ab")).unwrap();
        std::fs::write(seed.join("files/ab/article.cls"), "seeded").unwrap();
        std::fs::write(seed.join("formats.fmt"), "format").unwrap();
        // An incomplete seed (the build skipped the warm-up) is ignored.
        std::fs::write(seed.join("seed.json"), r#"{"complete":false}"#).unwrap();
        seed_cache(&seed, &cache).unwrap();
        assert!(!cache.exists());
        let record = r#"{"complete":true,"key":"k1"}"#;
        std::fs::write(seed.join("seed.json"), record).unwrap();
        std::fs::create_dir_all(cache.join("files/ab")).unwrap();
        std::fs::write(cache.join("files/ab/article.cls"), "downloaded").unwrap();
        seed_cache(&seed, &cache).unwrap();
        assert_eq!(
            std::fs::read_to_string(cache.join("files/ab/article.cls")).unwrap(),
            "downloaded",
            "what the engine already has is kept"
        );
        assert_eq!(
            std::fs::read_to_string(cache.join("formats.fmt")).unwrap(),
            "format"
        );
        assert!(!cache.join("seed.json").exists());
        assert_eq!(
            std::fs::read_to_string(cache.join("scientify-seed.json")).unwrap(),
            record
        );
        std::fs::remove_file(cache.join("formats.fmt")).unwrap();
        seed_cache(&seed, &cache).unwrap();
        assert!(
            !cache.join("formats.fmt").exists(),
            "seeded once per release"
        );
        std::fs::write(seed.join("seed.json"), r#"{"complete":true,"key":"k2"}"#).unwrap();
        seed_cache(&seed, &cache).unwrap();
        assert!(
            cache.join("formats.fmt").exists(),
            "a new seed is copied again"
        );
    }

    #[test]
    fn network_failures_are_told_apart_from_document_errors() {
        assert!(offline(
            "error: failed to retrieve bundle: error sending request for url (https://relay.fullyjustified.net/default_bundle_v33.tar)"
        ));
        assert!(offline(
            "dns error: No such host is known. (os error 11001)"
        ));
        assert!(!offline("! LaTeX Error: File `foo.sty' not found."));
        assert!(!offline("! Undefined control sequence."));
    }

    #[test]
    fn clone_addresses_keep_secrets_out_of_git_config() {
        assert!(has_password("https://git:token@git.overleaf.com/abc"));
        assert!(!has_password("https://git@git.overleaf.com/abc"));
        assert!(!has_password("https://git.overleaf.com/abc"));
        assert!(!has_password("git@github.com:me/paper.git"));
    }

    #[test]
    fn source_packages_hold_only_manuscript_files_and_the_bbl() {
        let temp = tempfile::tempdir().unwrap();
        let project = temp.path().join("project");
        std::fs::create_dir_all(project.join("paper/figs")).unwrap();
        std::fs::write(project.join("paper/main.tex"), "\\documentclass{article}").unwrap();
        std::fs::write(project.join("paper/figs/a.png"), "png").unwrap();
        std::fs::write(project.join("secret.txt"), "").unwrap();
        let m = manuscript(
            &project,
            &temp.path().join("data"),
            "p",
            "paper",
            "main.tex",
        )
        .unwrap();
        let files = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let entries = source_entries(&m, &files(&["main.tex", "figs/a.png"]), false).unwrap();
        let names: Vec<&str> = entries.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, ["main.tex", "figs/a.png"]);
        assert!(source_entries(&m, &files(&["../secret.txt"]), false).is_err());
        assert!(
            source_entries(&m, &files(&["main.tex"]), true).is_err(),
            "no bbl yet"
        );
        std::fs::create_dir_all(&m.cache).unwrap();
        std::fs::write(m.cache.join("main.bbl"), "").unwrap();
        let entries = source_entries(&m, &files(&["main.tex"]), true).unwrap();
        assert_eq!(entries.last().unwrap().0, "main.bbl");
        assert!(source_entries(&m, &[], false).is_err());
    }
}
