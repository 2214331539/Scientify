//! Project sync: keep a project's files and records the same on every device.
//!
//! Each device remembers, per project, the revision and content hash of every
//! synced file and record as of its last sync. A sync pulls what the server
//! changed since the device's cursor, scans the local folders and records, and
//! then for each item:
//! - applies the remote change when the local copy is unchanged since the last sync;
//! - pushes the local change when the remote copy is unchanged;
//! - keeps both when both changed: the remote version keeps the name and the
//!   local one is saved as a conflict copy, so no edit is lost.
//!
//! Edits made by the AI agent or other programs are found by the scan, so no
//! save hook has to report them.

use scientify_core::{library::LocalLibrary, research::ResearchFiles, storage::Storage};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::UNIX_EPOCH,
};

const PULL_PAGE: u64 = 500;
const PUSH_BATCH: usize = 100;
const PUSH_BATCH_BYTES: usize = 4 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 200 * 1024 * 1024;
const MAX_FILES: usize = 20_000;
const CONFLICTS_KEPT: usize = 50;

/// Folders a code root never syncs: environments, caches and version control.
const CODE_SKIP: &[&str] = &[
    ".git",
    ".hg",
    ".svn",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "node_modules",
    ".ipynb_checkpoints",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".tox",
];
/// Project fields that follow it to other devices; folders and shelf settings stay local.
const PROJECT_FIELDS: &[&str] = &["name", "question", "color", "description"];
/// Experiment fields that only make sense on this device.
const EXPERIMENT_LOCAL: &[&str] = &["python", "root"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub(crate) enum Domain {
    Library,
    Code,
    Asset,
    Project,
    Record,
    Experiment,
    Run,
}

impl Domain {
    const ALL: [Domain; 7] = [
        Domain::Library,
        Domain::Code,
        Domain::Asset,
        Domain::Project,
        Domain::Record,
        Domain::Experiment,
        Domain::Run,
    ];
    pub(crate) fn name(self) -> &'static str {
        match self {
            Domain::Library => "library",
            Domain::Code => "code",
            Domain::Asset => "asset",
            Domain::Project => "project",
            Domain::Record => "record",
            Domain::Experiment => "experiment",
            Domain::Run => "run",
        }
    }
    fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|domain| domain.name() == value)
    }
    fn is_file(self) -> bool {
        matches!(self, Domain::Library | Domain::Code | Domain::Asset)
    }
    fn collection(self) -> Option<&'static str> {
        match self {
            Domain::Record => Some("records"),
            Domain::Experiment => Some("experiments"),
            Domain::Run => Some("runs"),
            _ => None,
        }
    }
}

fn key(domain: Domain, path: &str) -> String {
    format!("{}/{path}", domain.name())
}

fn split_key(key: &str) -> Option<(Domain, &str)> {
    let (domain, path) = key.split_once('/')?;
    Some((Domain::parse(domain)?, path))
}

/// What this device last agreed with the server about one file or record.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct Entry {
    pub revision: u64,
    /// `None` once the item is deleted everywhere.
    pub hash: Option<String>,
    pub size: u64,
    /// File modification time in milliseconds, to skip rehashing unchanged files.
    pub modified: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Conflict {
    pub domain: String,
    pub path: String,
    /// Where this device's version was kept, or empty when the remote one won.
    pub copy: String,
    pub at: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct ProjectSync {
    /// Server change number this device has fully processed.
    pub since: u64,
    pub entries: BTreeMap<String, Entry>,
    pub conflicts: Vec<Conflict>,
    pub last_sync_at: Option<String>,
    pub last_error: Option<String>,
}

fn state_path(data: &Path, project: &str) -> PathBuf {
    data.join("collaboration")
        .join("projects")
        .join(format!("{project}.json"))
}

pub(crate) fn load_state(data: &Path, project: &str) -> Result<ProjectSync, String> {
    match fs::read(state_path(data, project)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "项目同步记录格式无效。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(ProjectSync::default()),
        Err(error) => Err(error.to_string()),
    }
}

fn save_state(data: &Path, project: &str, state: &ProjectSync) -> Result<(), String> {
    let path = state_path(data, project);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let bytes = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
    scientify_core::storage::write_atomic_bytes(&path, &bytes)
}

/// Keep the failure where the settings page can show it.
pub(crate) fn record_error(data: &Path, project: &str, error: &str) {
    if let Ok(mut state) = load_state(data, project) {
        state.last_error = Some(error.into());
        let _ = save_state(data, project, &state);
    }
}

/// Projects being synced right now; a second request for one returns at once.
fn running() -> &'static Mutex<HashSet<String>> {
    static RUNNING: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    RUNNING.get_or_init(Default::default)
}

pub(crate) struct Running(String);

impl Running {
    pub(crate) fn start(project: &str) -> Result<Self, String> {
        let mut set = running().lock().map_err(|error| error.to_string())?;
        if !set.insert(project.into()) {
            return Err("正在同步，请稍候。".into());
        }
        Ok(Self(project.into()))
    }
}

impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut set) = running().lock() {
            set.remove(&self.0);
        }
    }
}

/// The local side of a sync: this device's stores and where new folders go.
pub(crate) struct Device<'a> {
    pub storage: &'a Storage,
    pub files: &'a ResearchFiles,
    pub library: &'a LocalLibrary,
    pub device_id: String,
    /// A new device puts a synced project's literature folder under here.
    pub documents: PathBuf,
}

impl Device<'_> {
    fn data(&self) -> &Path {
        self.storage.directory()
    }
}

pub(crate) struct Page {
    entities: Vec<Value>,
    next_since: u64,
    has_more: bool,
}

/// The server, over HTTP in the app and in memory in tests.
pub(crate) enum Remote<'a> {
    Http {
        state: &'a crate::AppState,
        endpoint: String,
    },
    #[cfg(test)]
    Memory(&'a memory::Server),
}

impl Remote<'_> {
    async fn pull(&self, project: &str, since: u64) -> Result<Page, String> {
        match self {
            Remote::Http { state, endpoint } => {
                let value = super::auth_request(
                    state,
                    endpoint,
                    &format!("/projects/{project}/entities?since={since}&limit={PULL_PAGE}"),
                    reqwest::Method::GET,
                    None,
                )
                .await?;
                Ok(Page {
                    entities: value["entities"].as_array().cloned().unwrap_or_default(),
                    next_since: value["nextSince"].as_u64().unwrap_or(since),
                    has_more: value["hasMore"] == true,
                })
            }
            #[cfg(test)]
            Remote::Memory(server) => Ok(server.pull(project, since)),
        }
    }

    async fn push(
        &self,
        project: &str,
        device: &str,
        changes: Vec<Value>,
    ) -> Result<Value, String> {
        match self {
            Remote::Http { state, endpoint } => {
                super::auth_request(
                    state,
                    endpoint,
                    &format!("/projects/{project}/entities"),
                    reqwest::Method::POST,
                    Some(json!({"deviceId": device, "changes": changes})),
                )
                .await
            }
            #[cfg(test)]
            Remote::Memory(server) => Ok(server.push(project, device, &changes)),
        }
    }

    /// Store file content and return its blob id; identical content is stored once.
    async fn upload(
        &self,
        project: &str,
        bytes: Vec<u8>,
        content_type: &str,
    ) -> Result<String, String> {
        match self {
            Remote::Http { state, endpoint } => {
                let sha256 = format!("{:x}", Sha256::digest(&bytes));
                let presign = super::auth_request(
                    state,
                    endpoint,
                    &format!("/projects/{project}/blobs/presign-upload"),
                    reqwest::Method::POST,
                    Some(
                        json!({"sha256": sha256, "size": bytes.len(), "contentType": content_type}),
                    ),
                )
                .await?;
                let id = presign["blob"]["id"]
                    .as_str()
                    .ok_or("服务器没有返回文件标识。")?
                    .to_string();
                if presign["existing"] == true {
                    return Ok(id);
                }
                let url = presign["uploadUrl"]
                    .as_str()
                    .ok_or("服务器没有返回 OSS 上传地址。")?;
                let response = reqwest::Client::new()
                    .put(url)
                    .header("content-type", content_type)
                    .body(bytes)
                    .send()
                    .await
                    .map_err(|error| format!("OSS 上传失败：{error}"))?;
                if !response.status().is_success() {
                    return Err(format!("OSS 上传失败（HTTP {}）。", response.status()));
                }
                super::auth_request(
                    state,
                    endpoint,
                    &format!("/blobs/{id}/complete"),
                    reqwest::Method::POST,
                    None,
                )
                .await?;
                Ok(id)
            }
            #[cfg(test)]
            Remote::Memory(server) => {
                let _ = (project, content_type);
                Ok(server.upload(bytes))
            }
        }
    }

    async fn download(&self, blob: &str) -> Result<Vec<u8>, String> {
        match self {
            Remote::Http { state, endpoint } => super::download_blob(state, endpoint, blob).await,
            #[cfg(test)]
            Remote::Memory(server) => server.download(blob),
        }
    }
}

/// A file or record as it is on this device now.
#[derive(Clone, Debug)]
enum Item {
    File {
        path: PathBuf,
        hash: String,
        size: u64,
        modified: i64,
    },
    Record {
        hash: String,
        content: Value,
    },
}

impl Item {
    fn hash(&self) -> &str {
        match self {
            Item::File { hash, .. } | Item::Record { hash, .. } => hash,
        }
    }
    fn entry(&self, revision: u64) -> Entry {
        match self {
            Item::File {
                hash,
                size,
                modified,
                ..
            } => Entry {
                revision,
                hash: Some(hash.clone()),
                size: *size,
                modified: *modified,
            },
            Item::Record { hash, .. } => Entry {
                revision,
                hash: Some(hash.clone()),
                ..Entry::default()
            },
        }
    }
}

/// What to do with one item, from the hashes at the last sync, here and remotely.
#[derive(Debug, PartialEq, Eq)]
enum Plan {
    Nothing,
    /// Only this device changed it.
    Push,
    /// Only the server changed it, or this device deleted what the server edited.
    Apply,
    /// Both sides made the same change.
    Adopt,
    /// Both sides edited it differently.
    Conflict,
    /// The server deleted what this device edited; keep the edit.
    KeepLocal,
}

/// `remote` is `None` when the server has nothing newer, `Some(None)` for a deletion.
fn plan(base: Option<&str>, local: Option<&str>, remote: Option<Option<&str>>) -> Plan {
    let local_changed = base != local;
    let Some(remote) = remote else {
        return if local_changed {
            Plan::Push
        } else {
            Plan::Nothing
        };
    };
    if !local_changed {
        return Plan::Apply;
    }
    if local == remote {
        return Plan::Adopt;
    }
    match (local, remote) {
        (Some(_), Some(_)) => Plan::Conflict,
        (Some(_), None) => Plan::KeepLocal,
        _ => Plan::Apply,
    }
}

/// The server's path rules, so nothing is pushed that it would refuse.
pub(crate) fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 1024
        && !path.starts_with('/')
        && !path
            .chars()
            .any(|c| matches!(c, '\0' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && part.trim() == part)
}

/// Whether a file or folder (by project-relative path) takes part in sync.
fn include(domain: Domain, rel: &str, name: &str, dir: bool) -> bool {
    if !valid_path(rel) {
        return false;
    }
    let lower = name.to_ascii_lowercase();
    if !dir
        && (name.starts_with("~$")
            || [".tmp", ".part", ".crdownload", ".download", ".swp"]
                .iter()
                .any(|suffix| lower.ends_with(suffix))
            || matches!(lower.as_str(), ".ds_store" | "thumbs.db" | "desktop.ini"))
    {
        return false;
    }
    match domain {
        // The library index and operation marker are per device; note images travel.
        Domain::Library => {
            if rel == ".scientify" {
                return dir;
            }
            if let Some(rest) = rel.strip_prefix(".scientify/") {
                return (dir && rest == "note-assets") || rest.starts_with("note-assets/");
            }
            !name.starts_with('.')
        }
        Domain::Code => {
            if name.starts_with(".scientify") {
                return false;
            }
            if dir {
                !CODE_SKIP.contains(&name)
            } else {
                !lower.ends_with(".pyc") && !lower.ends_with(".pyo")
            }
        }
        Domain::Asset => !name.starts_with('.'),
        _ => false,
    }
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = fs::File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0; 1 << 16];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn modified_ms(meta: &fs::Metadata) -> i64 {
    meta.modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map_or(0, |duration| duration.as_millis() as i64)
}

/// Every syncable file under `root`, reusing the last hash when size and time match.
fn scan(
    root: &Path,
    domain: Domain,
    known: &BTreeMap<String, Entry>,
    skipped: &mut usize,
) -> Result<BTreeMap<String, Item>, String> {
    let mut found = BTreeMap::new();
    if !root.is_dir() {
        return Ok(found);
    }
    let mut pending = vec![(root.to_path_buf(), String::new())];
    while let Some((dir, prefix)) = pending.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(entries) => entries,
            Err(error) if prefix.is_empty() => {
                return Err(format!("无法读取同步目录：{error}"));
            }
            Err(_) => {
                *skipped += 1;
                continue;
            }
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_symlink() {
                continue;
            }
            let rel = if prefix.is_empty() {
                name.clone()
            } else {
                format!("{prefix}/{name}")
            };
            if !include(domain, &rel, &name, kind.is_dir()) {
                continue;
            }
            if kind.is_dir() {
                pending.push((entry.path(), rel));
                continue;
            }
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if !kind.is_file() || meta.len() > MAX_FILE_BYTES {
                *skipped += 1;
                continue;
            }
            let (size, modified) = (meta.len(), modified_ms(&meta));
            let cached = known
                .get(&key(domain, &rel))
                .filter(|entry| entry.size == size && entry.modified == modified)
                .and_then(|entry| entry.hash.clone());
            let hash = match cached.map_or_else(|| hash_file(&entry.path()), Ok) {
                Ok(hash) => hash,
                Err(_) => {
                    *skipped += 1;
                    continue;
                }
            };
            found.insert(
                rel,
                Item::File {
                    path: entry.path(),
                    hash,
                    size,
                    modified,
                },
            );
            if found.len() > MAX_FILES {
                return Err("同步目录中的文件超过 20000 个，请整理后再同步。".into());
            }
        }
    }
    Ok(found)
}

/// JSON with sorted keys, so equal records hash alike on every device.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut fields: Vec<_> = map.iter().collect();
            fields.sort_by(|left, right| left.0.cmp(right.0));
            Value::Object(
                fields
                    .into_iter()
                    .map(|(name, value)| (name.clone(), canonical(value)))
                    .collect(),
            )
        }
        Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
        other => other.clone(),
    }
}

fn record_hash(content: &Value) -> String {
    format!(
        "{:x}",
        Sha256::digest(canonical(content).to_string().as_bytes())
    )
}

fn record_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

fn project_meta(project: &Value) -> Value {
    let mut meta = Map::new();
    for field in PROJECT_FIELDS {
        if let Some(value) = project.get(*field).filter(|value| !value.is_null()) {
            meta.insert((*field).into(), value.clone());
        }
    }
    Value::Object(meta)
}

/// The synced view of each project record: project info, notes, the default
/// experiment (other experiments point at folders on one device) and runs.
fn local_records(data: &Value, project: &str) -> BTreeMap<String, Item> {
    let mut found = BTreeMap::new();
    let mut add = |domain: Domain, id: &str, content: Value| {
        let hash = record_hash(&content);
        found.insert(key(domain, id), Item::Record { hash, content });
    };
    if let Some(info) = data["projects"]
        .as_array()
        .and_then(|projects| projects.iter().find(|item| item["id"] == project))
    {
        add(Domain::Project, "meta", project_meta(info));
    }
    for domain in [Domain::Record, Domain::Experiment, Domain::Run] {
        let list = domain.collection().unwrap();
        for item in data[list].as_array().into_iter().flatten() {
            let Some(id) = item["id"].as_str().filter(|id| record_id(id)) else {
                continue;
            };
            if item["project"] != project
                || (domain == Domain::Experiment && item["source"] != "project")
            {
                continue;
            }
            let mut content = item.clone();
            if domain == Domain::Experiment {
                if let Some(fields) = content.as_object_mut() {
                    for field in EXPERIMENT_LOCAL {
                        fields.remove(*field);
                    }
                }
            }
            add(domain, id, content);
        }
    }
    found
}

#[derive(Debug)]
enum RecordAction {
    Put {
        domain: Domain,
        id: String,
        content: Value,
    },
    Delete {
        domain: Domain,
        id: String,
    },
    /// Keep this device's version of a conflicting note or run under a new id.
    Copy {
        domain: Domain,
        content: Value,
    },
}

fn apply_action(data: &mut Value, project: &str, action: &RecordAction) -> Result<(), String> {
    match action {
        RecordAction::Put {
            domain: Domain::Project,
            content,
            ..
        } => {
            let target = data["projects"]
                .as_array_mut()
                .and_then(|projects| projects.iter_mut().find(|item| item["id"] == project))
                .ok_or("项目不存在。")?;
            for field in PROJECT_FIELDS {
                match content.get(*field).filter(|value| !value.is_null()) {
                    Some(value) => target[*field] = value.clone(),
                    None if *field != "name" => {
                        if let Some(fields) = target.as_object_mut() {
                            fields.remove(*field);
                        }
                    }
                    None => {}
                }
            }
        }
        RecordAction::Put {
            domain,
            id,
            content,
        } => {
            let list = domain.collection().ok_or("同步类型无效。")?;
            let items = data[list].as_array_mut().ok_or("工作区格式无效。")?;
            let mut next = content.clone();
            next["id"] = json!(id);
            next["project"] = json!(project);
            match items.iter_mut().find(|item| item["id"] == id.as_str()) {
                Some(existing) => {
                    if *domain == Domain::Experiment {
                        for field in EXPERIMENT_LOCAL {
                            if let Some(value) = existing.get(*field) {
                                next[*field] = value.clone();
                            }
                        }
                    }
                    *existing = next;
                }
                None => {
                    if *domain == Domain::Experiment && next.get("root").is_none() {
                        next["root"] = json!("");
                    }
                    items.push(next);
                }
            }
        }
        RecordAction::Delete { domain, id } => {
            // The default experiment belongs to the project and is never removed.
            if *domain == Domain::Project || (*domain == Domain::Experiment && id == project) {
                return Ok(());
            }
            let list = domain.collection().ok_or("同步类型无效。")?;
            if let Some(items) = data[list].as_array_mut() {
                items.retain(|item| !(item["id"] == id.as_str() && item["project"] == project));
            }
        }
        RecordAction::Copy { domain, content } => {
            let list = domain.collection().ok_or("同步类型无效。")?;
            data[list]
                .as_array_mut()
                .ok_or("工作区格式无效。")?
                .push(content.clone());
        }
    }
    Ok(())
}

/// Apply record changes in one workspace save, retrying if the app saved meanwhile.
fn apply_records(
    storage: &Storage,
    project: &str,
    actions: &[RecordAction],
) -> Result<Value, String> {
    for _ in 0..3 {
        let data = storage.load()?.ok_or("工作区尚未载入。")?;
        let revision = data["revision"].as_u64().unwrap_or(0);
        let mut next = data.clone();
        for action in actions {
            apply_action(&mut next, project, action)?;
        }
        next["revision"] = json!(revision + 1);
        next["updatedAt"] = json!(scientify_core::workspace::now());
        match storage.save(next, revision) {
            Ok(saved) => return Ok(saved),
            Err(error) if error.contains("已发生变化") => continue,
            Err(error) => return Err(error),
        }
    }
    Err("工作区正被频繁修改，稍后再同步。".into())
}

fn conflict_record(domain: Domain, content: &Value, project: &str) -> Value {
    let mut copy = content.clone();
    copy["id"] = json!(uuid::Uuid::new_v4().to_string());
    copy["project"] = json!(project);
    let label = if domain == Domain::Record {
        "title"
    } else {
        "name"
    };
    let current = copy[label].as_str().unwrap_or_default().to_string();
    copy[label] = json!(format!("{current}（冲突副本）"));
    copy
}

/// `notes/a.md` becomes `notes/a (冲突副本 abc123 20261102-0930).md`.
fn conflict_name(rel: &str, device: &str, at: &str) -> String {
    let (dir, file) = rel
        .rsplit_once('/')
        .map_or(("", rel), |(dir, file)| (dir, file));
    let (stem, extension) = match file.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() => (stem, format!(".{extension}")),
        _ => (file, String::new()),
    };
    let short: String = device.chars().take(6).collect();
    let name = format!("{stem} (冲突副本 {short} {at}){extension}");
    if dir.is_empty() {
        name
    } else {
        format!("{dir}/{name}")
    }
}

fn target(root: &Path, rel: &str) -> PathBuf {
    rel.split('/')
        .fold(root.to_path_buf(), |path, part| path.join(part))
}

/// The file still has the size and time the scan saw, so nobody edited it since.
fn untouched(path: &Path, size: u64, modified: i64) -> bool {
    fs::metadata(path).is_ok_and(|meta| meta.len() == size && modified_ms(&meta) == modified)
}

/// Write through a temporary file in the same folder, then move it into place.
fn write_file(path: &Path, bytes: &[u8]) -> Result<Entry, String> {
    let parent = path.parent().ok_or("同步路径无效。")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary = parent.join(format!(".scientify-sync-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = fs::File::create(&temporary)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temporary, path)
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    let meta = fs::metadata(path).map_err(|error| error.to_string())?;
    Ok(Entry {
        revision: 0,
        hash: Some(format!("{:x}", Sha256::digest(bytes))),
        size: meta.len(),
        modified: modified_ms(&meta),
    })
}

/// A synced project without a literature folder on this device gets one in Documents.
fn ensure_library(device: &Device<'_>, project: &str, info: &Value) -> Result<PathBuf, String> {
    if let Some(root) = device.library.root(project)? {
        return Ok(root);
    }
    let name = info["name"].as_str().unwrap_or_default();
    let clean: String = name
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .trim_end_matches('.')
        .chars()
        .take(60)
        .collect();
    let short: String = project.chars().take(8).collect();
    let folder = device
        .documents
        .join("Scientify")
        .join(if clean.is_empty() {
            format!("project-{short}")
        } else {
            format!("{clean} ({short})")
        });
    fs::create_dir_all(&folder).map_err(|error| format!("无法创建文献文件夹：{error}"))?;
    device.library.mount(project, &folder)?;
    Ok(folder)
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Outcome {
    pub pulled: usize,
    pub applied: usize,
    pub pushed: usize,
    pub conflicts: usize,
    pub skipped: usize,
    /// Remote changes left for the next sync, for example while an agent edits code.
    pub deferred: usize,
    pub errors: Vec<String>,
    pub changed: BTreeSet<&'static str>,
    pub library_root: Option<String>,
    pub last_sync_at: String,
}

fn remote_revision(entity: &Value) -> u64 {
    entity["revision"].as_u64().unwrap_or(0)
}

fn remote_hash(entity: &Value) -> Option<&str> {
    if entity["deleted"] == true {
        None
    } else {
        entity["hash"].as_str()
    }
}

/// Sync one project with the server. Safe to repeat: every step is idempotent.
pub(crate) async fn sync(
    device: &Device<'_>,
    remote: &Remote<'_>,
    project: &str,
) -> Result<Outcome, String> {
    let data = device.storage.load()?.ok_or("工作区尚未载入。")?;
    let info = data["projects"]
        .as_array()
        .and_then(|projects| projects.iter().find(|item| item["id"] == project))
        .cloned()
        .ok_or("项目不存在。")?;
    let role = info["collaborationRole"]
        .as_str()
        .ok_or("该项目没有开启云同步。")?
        .to_string();
    let can_push = |domain: Domain| match role.as_str() {
        "owner" | "editor" => true,
        "reviewer" => domain == Domain::Record,
        _ => false,
    };
    let mut state = load_state(device.data(), project)?;
    let mut outcome = Outcome::default();

    // 1. Everything the server changed since this device last caught up.
    let mut remote_items: BTreeMap<String, Value> = BTreeMap::new();
    let mut cursor = state.since;
    loop {
        let page = remote.pull(project, cursor).await?;
        for entity in page.entities {
            let (Some(domain), Some(path)) = (
                entity["domain"].as_str().and_then(Domain::parse),
                entity["path"].as_str(),
            ) else {
                continue;
            };
            remote_items.insert(key(domain, path), entity);
        }
        if page.next_since <= cursor && page.has_more {
            return Err("同步服务器返回的进度无效。".into());
        }
        cursor = cursor.max(page.next_since);
        if !page.has_more {
            break;
        }
    }
    outcome.pulled = remote_items.len();

    // 2. The project's folders on this device, and what is in them now.
    let mut roots: BTreeMap<Domain, PathBuf> = BTreeMap::new();
    match ensure_library(device, project, &info) {
        Ok(root) => {
            outcome.library_root = Some(root.display().to_string());
            roots.insert(Domain::Library, root);
        }
        Err(error) => outcome.errors.push(format!("文献文件夹：{error}")),
    }
    match crate::research::project_root(device.storage, device.files, project) {
        Ok(root) => {
            roots.insert(Domain::Code, root);
        }
        Err(error) => outcome.errors.push(format!("代码目录：{error}")),
    }
    roots.insert(
        Domain::Asset,
        device.data().join("note-assets").join(project),
    );
    let mut local: BTreeMap<String, Item> = local_records(&data, project);
    for (domain, root) in &roots {
        for (rel, item) in scan(root, *domain, &state.entries, &mut outcome.skipped)? {
            local.insert(key(*domain, &rel), item);
        }
    }
    let code_busy = roots
        .get(&Domain::Code)
        .is_some_and(|root| crate::code::busy(root));

    // 3. Decide per item.
    let keys: BTreeSet<String> = local
        .keys()
        .chain(remote_items.keys())
        .chain(state.entries.keys())
        .cloned()
        .collect();
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M").to_string();
    let mut downloads: Vec<(String, Value)> = Vec::new();
    let mut records: Vec<RecordAction> = Vec::new();
    let mut record_keys: Vec<(String, u64)> = Vec::new();
    let mut pushes: Vec<(String, u64)> = Vec::new();
    let mut deferred_from: Option<u64> = None;
    for item_key in keys {
        let Some((domain, path)) = split_key(&item_key) else {
            continue;
        };
        let base = state.entries.get(&item_key);
        let base_revision = base.map_or(0, |entry| entry.revision);
        let here = local.get(&item_key);
        let newer = remote_items
            .get(&item_key)
            .filter(|entity| remote_revision(entity) > base_revision);
        let decision = plan(
            base.and_then(|entry| entry.hash.as_deref()),
            here.map(Item::hash),
            newer.map(remote_hash),
        );
        let defer = |entity: &Value, from: &mut Option<u64>| {
            let seq = entity["changeSeq"].as_u64().unwrap_or(1);
            *from = Some(from.map_or(seq, |current: u64| current.min(seq)));
        };
        match decision {
            Plan::Nothing => {}
            Plan::Push => {
                if can_push(domain) {
                    pushes.push((item_key.clone(), base_revision));
                }
            }
            Plan::KeepLocal => {
                if can_push(domain) {
                    pushes.push((item_key.clone(), remote_revision(newer.unwrap())));
                }
            }
            Plan::Adopt => {
                let revision = remote_revision(newer.unwrap());
                let entry = here.map_or(
                    Entry {
                        revision,
                        ..Entry::default()
                    },
                    |item| item.entry(revision),
                );
                state.entries.insert(item_key.clone(), entry);
            }
            Plan::Apply | Plan::Conflict => {
                let entity = newer.unwrap().clone();
                if domain == Domain::Code && code_busy {
                    defer(&entity, &mut deferred_from);
                    outcome.deferred += 1;
                    continue;
                }
                let conflict = decision == Plan::Conflict;
                if domain.is_file() {
                    if conflict {
                        let root = &roots[&domain];
                        let copy = conflict_name(path, &device.device_id, &stamp);
                        let from = target(root, path);
                        let to = target(root, &copy);
                        if fs::rename(&from, &to).is_err() {
                            defer(&entity, &mut deferred_from);
                            outcome.deferred += 1;
                            continue;
                        }
                        state.conflicts.push(Conflict {
                            domain: domain.name().into(),
                            path: path.into(),
                            copy: copy.clone(),
                            at: scientify_core::workspace::now(),
                        });
                        outcome.conflicts += 1;
                        // The copy is new here; push it this round.
                        if let Ok(meta) = fs::metadata(&to) {
                            if let Some(Item::File { hash, .. }) = here {
                                local.insert(
                                    key(domain, &copy),
                                    Item::File {
                                        path: to.clone(),
                                        hash: hash.clone(),
                                        size: meta.len(),
                                        modified: modified_ms(&meta),
                                    },
                                );
                                if can_push(domain) {
                                    pushes.push((key(domain, &copy), 0));
                                }
                            }
                        }
                    }
                    downloads.push((item_key.clone(), entity));
                } else {
                    let revision = remote_revision(&entity);
                    if conflict {
                        if let (Some(Item::Record { content, .. }), true) =
                            (here, matches!(domain, Domain::Record | Domain::Run))
                        {
                            records.push(RecordAction::Copy {
                                domain,
                                content: conflict_record(domain, content, project),
                            });
                        }
                        state.conflicts.push(Conflict {
                            domain: domain.name().into(),
                            path: path.into(),
                            copy: String::new(),
                            at: scientify_core::workspace::now(),
                        });
                        outcome.conflicts += 1;
                    }
                    records.push(match remote_hash(&entity) {
                        None => RecordAction::Delete {
                            domain,
                            id: path.into(),
                        },
                        Some(_) => RecordAction::Put {
                            domain,
                            id: path.into(),
                            content: entity["content"].clone(),
                        },
                    });
                    record_keys.push((item_key.clone(), revision));
                }
            }
        }
    }

    // 4. Apply remote file changes.
    let mut library_paths = Vec::new();
    for (item_key, entity) in downloads {
        let (domain, path) = split_key(&item_key).unwrap();
        let root = &roots[&domain];
        let file = target(root, path);
        let revision = remote_revision(&entity);
        // A conflict already moved the local file aside; otherwise make sure it
        // was not edited between the scan and now.
        if let Some(Item::File { size, modified, .. }) = local.get(&item_key) {
            if file.exists() && !untouched(&file, *size, *modified) {
                outcome.deferred += 1;
                let seq = entity["changeSeq"].as_u64().unwrap_or(1);
                deferred_from = Some(deferred_from.map_or(seq, |current| current.min(seq)));
                continue;
            }
        }
        let result = match (remote_hash(&entity), entity["blobId"].as_str()) {
            (None, _) => match fs::remove_file(&file) {
                Ok(()) => Ok(Entry {
                    revision,
                    ..Entry::default()
                }),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Entry {
                    revision,
                    ..Entry::default()
                }),
                Err(error) => Err(error.to_string()),
            },
            (Some(hash), Some(blob)) => match remote.download(blob).await {
                Ok(bytes) if format!("{:x}", Sha256::digest(&bytes)) == hash => {
                    write_file(&file, &bytes).map(|entry| Entry { revision, ..entry })
                }
                Ok(_) => Err("下载的文件内容校验失败。".into()),
                Err(error) => Err(error),
            },
            (Some(_), None) => Err("同步记录缺少文件内容。".into()),
        };
        match result {
            Ok(entry) => {
                state.entries.insert(item_key.clone(), entry);
                outcome.applied += 1;
                outcome.changed.insert(domain.name());
                if domain == Domain::Library {
                    library_paths.push(file);
                }
            }
            Err(error) => {
                outcome.errors.push(format!("{path}：{error}"));
                let seq = entity["changeSeq"].as_u64().unwrap_or(1);
                deferred_from = Some(deferred_from.map_or(seq, |current| current.min(seq)));
            }
        }
    }
    if !library_paths.is_empty() {
        device.library.invalidate_fingerprints(&library_paths);
    }

    // 5. Apply remote record changes in one save.
    if !records.is_empty() {
        match apply_records(device.storage, project, &records) {
            Ok(saved) => {
                let now = local_records(&saved, project);
                for (item_key, revision) in record_keys {
                    let entry = now.get(&item_key).map_or(
                        Entry {
                            revision,
                            ..Entry::default()
                        },
                        |item| item.entry(revision),
                    );
                    let (domain, _) = split_key(&item_key).unwrap();
                    outcome.changed.insert(domain.name());
                    state.entries.insert(item_key, entry);
                    outcome.applied += 1;
                }
                // Conflict copies are new records; push them with the rest.
                for (item_key, item) in &now {
                    if !local.contains_key(item_key) && !state.entries.contains_key(item_key) {
                        let (domain, _) = split_key(item_key).unwrap();
                        if can_push(domain) {
                            pushes.push((item_key.clone(), 0));
                        }
                        local.insert(item_key.clone(), item.clone());
                    }
                }
            }
            Err(error) => {
                outcome.errors.push(error);
                deferred_from = Some(state.since + 1);
            }
        }
    }

    // 6. Push local changes: upload new file content first, then the records.
    let mut changes: Vec<(String, Value, Option<Item>)> = Vec::new();
    for (item_key, base_revision) in pushes {
        let (domain, path) = split_key(&item_key).unwrap();
        let item = local.get(&item_key).cloned();
        let change = match &item {
            None => {
                json!({"domain": domain.name(), "path": path, "baseRevision": base_revision, "deleted": true})
            }
            Some(Item::Record { hash, content }) => json!({
                "domain": domain.name(), "path": path, "baseRevision": base_revision,
                "hash": hash, "content": content,
            }),
            Some(Item::File {
                path: file,
                hash,
                size,
                ..
            }) => {
                let bytes = match fs::read(file) {
                    Ok(bytes) => bytes,
                    Err(error) => {
                        outcome.errors.push(format!("{path}：{error}"));
                        continue;
                    }
                };
                match remote
                    .upload(project, bytes, super::content_type_for_path(path))
                    .await
                {
                    Ok(blob) => json!({
                        "domain": domain.name(), "path": path, "baseRevision": base_revision,
                        "hash": hash, "size": size, "blobId": blob,
                    }),
                    Err(error) => {
                        outcome.errors.push(format!("{path}：{error}"));
                        continue;
                    }
                }
            }
        };
        changes.push((item_key, change, item));
    }
    let mut batch: Vec<(String, Value, Option<Item>)> = Vec::new();
    let mut batch_bytes = 0;
    let mut sent = changes.into_iter().peekable();
    while let Some(next) = sent.next() {
        batch_bytes += next.1.to_string().len();
        batch.push(next);
        let full =
            batch.len() >= PUSH_BATCH || batch_bytes >= PUSH_BATCH_BYTES || sent.peek().is_none();
        if !full {
            continue;
        }
        let payload: Vec<Value> = batch.iter().map(|(_, change, _)| change.clone()).collect();
        let result = remote.push(project, &device.device_id, payload).await?;
        for accepted in result["accepted"].as_array().into_iter().flatten() {
            let (Some(domain), Some(path)) = (
                accepted["domain"].as_str().and_then(Domain::parse),
                accepted["path"].as_str(),
            ) else {
                continue;
            };
            let item_key = key(domain, path);
            let revision = accepted["revision"].as_u64().unwrap_or(0);
            let item = batch
                .iter()
                .find(|(candidate, _, _)| *candidate == item_key)
                .and_then(|(_, _, item)| item.clone());
            let entry = item.map_or(
                Entry {
                    revision,
                    ..Entry::default()
                },
                |item| item.entry(revision),
            );
            state.entries.insert(item_key, entry);
            outcome.pushed += 1;
        }
        for rejected in result["rejected"].as_array().into_iter().flatten() {
            // A conflict means someone pushed first; the next sync merges it.
            if rejected["conflict"] != true {
                outcome.errors.push(format!(
                    "{}：{}",
                    rejected["path"].as_str().unwrap_or_default(),
                    rejected["message"]
                        .as_str()
                        .unwrap_or("服务器拒绝了这项修改。")
                ));
            }
        }
        batch.clear();
        batch_bytes = 0;
    }

    // 7. Remember how far this device got; unapplied changes are pulled again.
    state.since = match deferred_from {
        Some(seq) => seq.saturating_sub(1).max(state.since),
        None => cursor,
    };
    if state.conflicts.len() > CONFLICTS_KEPT {
        let extra = state.conflicts.len() - CONFLICTS_KEPT;
        state.conflicts.drain(..extra);
    }
    outcome.last_sync_at = scientify_core::workspace::now();
    state.last_sync_at = Some(outcome.last_sync_at.clone());
    state.last_error = outcome.errors.first().cloned();
    save_state(device.data(), project, &state)?;
    Ok(outcome)
}

#[cfg(test)]
pub(crate) mod memory {
    //! The sync rules of `server/src/sync.mjs`, in memory, for device tests.
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::{collections::BTreeMap, sync::Mutex};

    #[derive(Default)]
    pub(crate) struct Server {
        inner: Mutex<Inner>,
    }

    #[derive(Default)]
    struct Inner {
        seq: BTreeMap<String, u64>,
        entities: BTreeMap<(String, String, String), Value>,
        blobs: BTreeMap<String, Vec<u8>>,
    }

    impl Server {
        pub(crate) fn pull(&self, project: &str, since: u64) -> super::Page {
            let inner = self.inner.lock().unwrap();
            let mut rows: Vec<Value> = inner
                .entities
                .iter()
                .filter(|((p, _, _), row)| {
                    p == project && row["changeSeq"].as_u64().unwrap() > since
                })
                .map(|(_, row)| row.clone())
                .collect();
            rows.sort_by_key(|row| row["changeSeq"].as_u64().unwrap());
            let next_since = rows
                .last()
                .map_or(since, |row| row["changeSeq"].as_u64().unwrap());
            super::Page {
                entities: rows,
                next_since,
                has_more: false,
            }
        }

        pub(crate) fn push(&self, project: &str, device: &str, changes: &[Value]) -> Value {
            let mut inner = self.inner.lock().unwrap();
            let mut seq = inner.seq.get(project).copied().unwrap_or(0);
            let (mut accepted, mut rejected) = (vec![], vec![]);
            for change in changes {
                let domain = change["domain"].as_str().unwrap().to_string();
                let path = change["path"].as_str().unwrap().to_string();
                let id = (project.to_string(), domain.clone(), path.clone());
                let deleted = change["deleted"] == true;
                let current = inner.entities.get(&id).cloned();
                let revision = current
                    .as_ref()
                    .map_or(0, |row| row["revision"].as_u64().unwrap());
                if let Some(row) = &current {
                    let same = (row["deleted"] == true) == deleted
                        && (deleted || row["hash"] == change["hash"]);
                    if same {
                        accepted
                            .push(json!({"domain": domain, "path": path, "revision": revision}));
                        continue;
                    }
                }
                if current.is_none() && deleted {
                    accepted.push(json!({"domain": domain, "path": path, "revision": 0}));
                    continue;
                }
                if change["baseRevision"].as_u64() != Some(revision) {
                    rejected.push(json!({"domain": domain, "path": path, "conflict": true, "serverRevision": revision}));
                    continue;
                }
                seq += 1;
                inner.entities.insert(
                    id,
                    json!({
                        "domain": domain, "path": path, "revision": revision + 1, "changeSeq": seq,
                        "deleted": deleted,
                        "hash": if deleted { Value::Null } else { change["hash"].clone() },
                        "size": change["size"], "blobId": if deleted { Value::Null } else { change["blobId"].clone() },
                        "content": if deleted { Value::Null } else { change["content"].clone() },
                        "deviceId": device,
                    }),
                );
                accepted.push(json!({"domain": domain, "path": path, "revision": revision + 1, "changeSeq": seq}));
            }
            inner.seq.insert(project.into(), seq);
            json!({"accepted": accepted, "rejected": rejected, "changeSeq": seq})
        }

        pub(crate) fn upload(&self, bytes: Vec<u8>) -> String {
            let id = format!("{:x}", Sha256::digest(&bytes));
            self.inner.lock().unwrap().blobs.insert(id.clone(), bytes);
            id
        }

        pub(crate) fn download(&self, blob: &str) -> Result<Vec<u8>, String> {
            self.inner
                .lock()
                .unwrap()
                .blobs
                .get(blob)
                .cloned()
                .ok_or_else(|| "文件不存在。".into())
        }

        pub(crate) fn entity(&self, project: &str, domain: &str, path: &str) -> Option<Value> {
            self.inner
                .lock()
                .unwrap()
                .entities
                .get(&(project.into(), domain.into(), path.into()))
                .cloned()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use scientify_core::workspace;

    const PROJECT: &str = "project-shared-01";

    /// One simulated device: its own data folder, documents folder and stores.
    struct Machine {
        _temp: tempfile::TempDir,
        storage: Storage,
        files: ResearchFiles,
        library: LocalLibrary,
        documents: PathBuf,
        id: String,
    }

    impl Machine {
        fn new(id: &str, role: &str) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let storage = Storage::open(temp.path().join("ScientifyData/workspace")).unwrap();
            let files = ResearchFiles::new(storage.directory().to_path_buf());
            let library = LocalLibrary::new(storage.directory().to_path_buf());
            let documents = temp.path().join("Documents");
            let mut data = workspace::empty();
            let now = workspace::now();
            data["projects"] = json!([{
                "id": PROJECT, "name": "Shared study", "question": "Why?", "createdAt": now,
                "updatedAt": now, "collaborationRole": role,
            }]);
            data["revision"] = json!(1);
            storage.save(data, 0).unwrap();
            Self {
                _temp: temp,
                storage,
                files,
                library,
                documents,
                id: id.into(),
            }
        }

        fn device(&self) -> Device<'_> {
            Device {
                storage: &self.storage,
                files: &self.files,
                library: &self.library,
                device_id: self.id.clone(),
                documents: self.documents.clone(),
            }
        }

        async fn sync(&self, server: &memory::Server) -> Outcome {
            sync(&self.device(), &Remote::Memory(server), PROJECT)
                .await
                .unwrap()
        }

        fn library_root(&self) -> PathBuf {
            self.library.root(PROJECT).unwrap().expect("library folder")
        }

        fn code_root(&self) -> PathBuf {
            crate::research::project_root(&self.storage, &self.files, PROJECT).unwrap()
        }

        fn edit(&self, change: impl FnOnce(&mut Value)) {
            let mut data = self.storage.load().unwrap().unwrap();
            let revision = data["revision"].as_u64().unwrap();
            change(&mut data);
            data["revision"] = json!(revision + 1);
            self.storage.save(data, revision).unwrap();
        }

        fn records(&self) -> Vec<Value> {
            self.storage.load().unwrap().unwrap()["records"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        }
    }

    fn note(id: &str, title: &str, body: &str) -> Value {
        let now = workspace::now();
        json!({"id": id, "project": PROJECT, "type": "note", "title": title, "body": body,
               "status": "draft", "createdAt": now, "updatedAt": now})
    }

    fn write(path: PathBuf, text: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
        // Make the next scan see a different modification time.
        std::thread::sleep(std::time::Duration::from_millis(20));
    }

    #[test]
    fn plans_follow_the_last_synced_hash() {
        assert_eq!(plan(Some("a"), Some("a"), None), Plan::Nothing);
        assert_eq!(plan(Some("a"), Some("b"), None), Plan::Push);
        assert_eq!(plan(None, Some("b"), None), Plan::Push);
        assert_eq!(plan(Some("a"), None, None), Plan::Push);
        assert_eq!(plan(None, None, None), Plan::Nothing);
        assert_eq!(plan(Some("a"), Some("a"), Some(Some("c"))), Plan::Apply);
        assert_eq!(plan(Some("a"), Some("a"), Some(None)), Plan::Apply);
        assert_eq!(plan(Some("a"), Some("c"), Some(Some("c"))), Plan::Adopt);
        assert_eq!(plan(Some("a"), Some("b"), Some(Some("c"))), Plan::Conflict);
        assert_eq!(plan(None, Some("b"), Some(Some("c"))), Plan::Conflict);
        assert_eq!(plan(Some("a"), Some("b"), Some(None)), Plan::KeepLocal);
        assert_eq!(plan(Some("a"), None, Some(Some("c"))), Plan::Apply);
        assert_eq!(plan(Some("a"), None, Some(None)), Plan::Adopt);
    }

    #[test]
    fn only_project_content_takes_part() {
        assert!(include(Domain::Library, "papers/a.pdf", "a.pdf", false));
        assert!(include(
            Domain::Library,
            "papers/a.notes.md",
            "a.notes.md",
            false
        ));
        assert!(include(Domain::Library, ".scientify", ".scientify", true));
        assert!(include(
            Domain::Library,
            ".scientify/note-assets",
            "note-assets",
            true
        ));
        assert!(include(
            Domain::Library,
            ".scientify/note-assets/x.png",
            "x.png",
            false
        ));
        assert!(!include(
            Domain::Library,
            ".scientify/library.json",
            "library.json",
            false
        ));
        assert!(!include(
            Domain::Library,
            ".scientify/operation.json",
            "operation.json",
            false
        ));
        assert!(!include(Domain::Library, "a/.hidden", ".hidden", false));
        assert!(!include(
            Domain::Library,
            "~$draft.docx",
            "~$draft.docx",
            false
        ));
        assert!(include(Domain::Code, "src/train.py", "train.py", false));
        assert!(include(Domain::Code, ".github", ".github", true));
        for skipped in [".git", ".venv", "venv", "__pycache__", "node_modules"] {
            assert!(!include(Domain::Code, skipped, skipped, true));
        }
        assert!(!include(Domain::Code, "a.pyc", "a.pyc", false));
        assert!(!include(Domain::Code, "data/x:y.csv", "x:y.csv", false));
        assert!(!include(Domain::Code, " lead.py", " lead.py", false));
    }

    #[test]
    fn record_hashes_ignore_key_order() {
        let left = json!({"b": 1, "a": {"y": [1, {"d": 2, "c": 3}], "x": "s"}});
        let right = json!({"a": {"x": "s", "y": [1, {"c": 3, "d": 2}]}, "b": 1});
        assert_eq!(record_hash(&left), record_hash(&right));
        assert_ne!(record_hash(&left), record_hash(&json!({"b": 2})));
    }

    #[test]
    fn conflict_copies_stay_next_to_the_original() {
        assert_eq!(
            conflict_name("notes/a.notes.md", "abcdef123", "20261102-0930"),
            "notes/a.notes (冲突副本 abcdef 20261102-0930).md"
        );
        assert_eq!(
            conflict_name("README", "dev", "t"),
            "README (冲突副本 dev t)"
        );
    }

    #[tokio::test]
    async fn a_second_device_receives_the_whole_project() {
        let server = memory::Server::default();
        let first = Machine::new("device-a", "owner");
        let second = Machine::new("device-b", "owner");
        // Device A: literature with a paired note and image, code with an
        // environment that must stay local, and a project note.
        first.sync(&server).await;
        let library = first.library_root();
        write(library.join("papers/paper.pdf"), "%PDF-1.7 bytes");
        write(
            library.join("papers/paper.notes.md"),
            "# Notes\n![fig](../.scientify/note-assets/fig.png)",
        );
        write(library.join(".scientify/note-assets/fig.png"), "png bytes");
        let code = first.code_root();
        write(code.join("train.py"), "print('train')");
        write(code.join(".venv/lib/site.py"), "local only");
        write(code.join("__pycache__/train.cpython-312.pyc"), "cache");
        first.edit(|data| {
            data["records"] = json!([note("note-1", "Plan", "Read the paper")]);
            data["projects"][0]["question"] = json!("Does it scale?");
        });
        let pushed = first.sync(&server).await;
        assert!(pushed.errors.is_empty(), "{:?}", pushed.errors);
        assert!(server
            .entity(PROJECT, "code", ".venv/lib/site.py")
            .is_none());

        let received = second.sync(&server).await;
        assert!(received.errors.is_empty(), "{:?}", received.errors);
        let library = second.library_root();
        // The library hands back canonical paths (`\\?\C:\...` on Windows).
        assert!(library
            .canonicalize()
            .unwrap()
            .starts_with(second.documents.canonicalize().unwrap()));
        assert_eq!(
            fs::read_to_string(library.join("papers/paper.pdf")).unwrap(),
            "%PDF-1.7 bytes"
        );
        assert!(library.join("papers/paper.notes.md").is_file());
        assert!(library.join(".scientify/note-assets/fig.png").is_file());
        assert_eq!(
            fs::read_to_string(second.code_root().join("train.py")).unwrap(),
            "print('train')"
        );
        assert!(!second.code_root().join(".venv").exists());
        assert_eq!(second.records()[0]["body"], "Read the paper");
        let data = second.storage.load().unwrap().unwrap();
        assert_eq!(data["projects"][0]["question"], "Does it scale?");

        // Nothing left to do on either side.
        let again = second.sync(&server).await;
        assert_eq!((again.applied, again.pushed), (0, 0));
        let again = first.sync(&server).await;
        assert_eq!((again.applied, again.pushed), (0, 0));
    }

    #[tokio::test]
    async fn edits_and_deletions_travel_both_ways() {
        let server = memory::Server::default();
        let first = Machine::new("device-a", "owner");
        let second = Machine::new("device-b", "owner");
        first.sync(&server).await;
        write(first.code_root().join("train.py"), "v1");
        write(first.library_root().join("old.pdf"), "old");
        first.edit(|data| data["records"] = json!([note("note-1", "Plan", "v1")]));
        first.sync(&server).await;
        second.sync(&server).await;

        write(second.code_root().join("train.py"), "v2 from b");
        fs::remove_file(second.library_root().join("old.pdf")).unwrap();
        second.edit(|data| data["records"][0]["body"] = json!("v2 from b"));
        let outcome = second.sync(&server).await;
        assert_eq!(outcome.pushed, 3, "{outcome:?}");

        let outcome = first.sync(&server).await;
        assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
        assert_eq!(
            fs::read_to_string(first.code_root().join("train.py")).unwrap(),
            "v2 from b"
        );
        assert!(!first.library_root().join("old.pdf").exists());
        assert_eq!(first.records()[0]["body"], "v2 from b");
    }

    #[tokio::test]
    async fn concurrent_edits_keep_both_versions() {
        let server = memory::Server::default();
        let first = Machine::new("device-a", "owner");
        let second = Machine::new("device-b", "owner");
        first.sync(&server).await;
        write(first.code_root().join("train.py"), "base");
        first.edit(|data| data["records"] = json!([note("note-1", "Plan", "base")]));
        first.sync(&server).await;
        second.sync(&server).await;

        write(first.code_root().join("train.py"), "from a");
        first.edit(|data| data["records"][0]["body"] = json!("from a"));
        write(second.code_root().join("train.py"), "from b");
        second.edit(|data| data["records"][0]["body"] = json!("from b"));
        first.sync(&server).await;
        let outcome = second.sync(&server).await;
        assert_eq!(outcome.conflicts, 2, "{outcome:?}");

        // B keeps A's version under the original names and its own as copies.
        let code = second.code_root();
        assert_eq!(fs::read_to_string(code.join("train.py")).unwrap(), "from a");
        let copies: Vec<_> = fs::read_dir(&code)
            .unwrap()
            .flatten()
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains("冲突副本"))
            .collect();
        assert_eq!(copies.len(), 1);
        assert_eq!(fs::read_to_string(code.join(&copies[0])).unwrap(), "from b");
        let records = second.records();
        assert!(records
            .iter()
            .any(|r| r["id"] == "note-1" && r["body"] == "from a"));
        assert!(records
            .iter()
            .any(|r| r["title"] == "Plan（冲突副本）" && r["body"] == "from b"));

        // A then receives B's copies, so both devices hold both versions.
        first.sync(&server).await;
        assert!(first.code_root().join(&copies[0]).is_file());
        assert_eq!(first.records().len(), 2);
    }

    #[tokio::test]
    async fn viewers_receive_but_never_push() {
        let server = memory::Server::default();
        let owner = Machine::new("device-a", "owner");
        let viewer = Machine::new("device-v", "viewer");
        owner.sync(&server).await;
        write(owner.code_root().join("train.py"), "owner");
        owner.sync(&server).await;
        viewer.sync(&server).await;
        assert!(viewer.code_root().join("train.py").is_file());
        write(viewer.code_root().join("mine.py"), "viewer edit");
        let outcome = viewer.sync(&server).await;
        assert_eq!(outcome.pushed, 0);
        assert!(server.entity(PROJECT, "code", "mine.py").is_none());
    }

    #[tokio::test]
    async fn the_default_experiment_converges_without_copies() {
        let server = memory::Server::default();
        let first = Machine::new("device-a", "owner");
        let second = Machine::new("device-b", "owner");
        first.edit(|data| data["experiments"][0]["purpose"] = json!("baseline"));
        first.sync(&server).await;
        let outcome = second.sync(&server).await;
        let data = second.storage.load().unwrap().unwrap();
        let experiments = data["experiments"].as_array().unwrap();
        assert_eq!(experiments.len(), 1, "{outcome:?}");
        assert_eq!(experiments[0]["purpose"], "baseline");
        assert_eq!(experiments[0]["root"], "");
    }

    /// One device talking to a real collaboration server over HTTP.
    struct Live {
        _temp: tempfile::TempDir,
        state: crate::AppState,
        library: LocalLibrary,
        documents: PathBuf,
        id: String,
        project: String,
    }

    impl Live {
        fn new(id: &str, project: &str) -> Self {
            let temp = tempfile::tempdir().unwrap();
            let storage = Storage::open(temp.path().join("ScientifyData/workspace")).unwrap();
            let files = ResearchFiles::new(storage.directory().to_path_buf());
            let library = LocalLibrary::new(storage.directory().to_path_buf());
            let mut data = workspace::empty();
            let now = workspace::now();
            data["projects"] = json!([{
                "id": project, "name": "Live study", "question": "", "createdAt": now,
                "updatedAt": now, "collaborationRole": "owner",
            }]);
            data["revision"] = json!(1);
            storage.save(data, 0).unwrap();
            let documents = temp.path().join("Documents");
            Self {
                state: crate::AppState {
                    storage: std::sync::Arc::new(storage),
                    files: std::sync::Arc::new(files),
                    legacy: temp.path().join("legacy"),
                },
                _temp: temp,
                library,
                documents,
                id: id.into(),
                project: project.into(),
            }
        }

        fn sign_in(&self, tokens: &Value) {
            super::super::write_auth(
                &self.state,
                &super::super::AuthTokens {
                    access_token: tokens["accessToken"].as_str().unwrap().into(),
                    refresh_token: tokens["refreshToken"].as_str().unwrap().into(),
                    user_id: tokens["user"]["id"].as_str().unwrap().into(),
                    phone: tokens["user"]["phone"].as_str().unwrap().into(),
                },
            )
            .unwrap();
        }

        async fn sync(&self, endpoint: &str) -> Outcome {
            let device = Device {
                storage: &self.state.storage,
                files: &self.state.files,
                library: &self.library,
                device_id: self.id.clone(),
                documents: self.documents.clone(),
            };
            let remote = Remote::Http {
                state: &self.state,
                endpoint: endpoint.into(),
            };
            let outcome = sync(&device, &remote, &self.project).await.unwrap();
            assert!(outcome.errors.is_empty(), "{:?}", outcome.errors);
            outcome
        }

        fn edit(&self, change: impl FnOnce(&mut Value)) {
            let mut data = self.state.storage.load().unwrap().unwrap();
            let revision = data["revision"].as_u64().unwrap();
            change(&mut data);
            data["revision"] = json!(revision + 1);
            self.state.storage.save(data, revision).unwrap();
        }

        fn records(&self) -> Vec<Value> {
            self.state.storage.load().unwrap().unwrap()["records"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        }
    }

    /// Same account on two devices against a running server; records only, so
    /// no OSS access is needed. Start `server/` in development mode, then run
    /// `SCIENTIFY_E2E_ENDPOINT=http://127.0.0.1:8090 cargo test -p scientify
    /// --lib live_server -- --ignored` (DEV_SMS_CODE defaults to 123456).
    #[tokio::test]
    #[ignore]
    async fn live_server_keeps_one_account_in_sync_on_two_devices() {
        let Ok(endpoint) = std::env::var("SCIENTIFY_E2E_ENDPOINT") else {
            return;
        };
        let code = std::env::var("SCIENTIFY_E2E_CODE").unwrap_or_else(|_| "123456".into());
        let project = format!("live-{}", uuid::Uuid::new_v4());
        let first = Live::new("device-a", &project);
        let second = Live::new("device-b", &project);
        let phone = "13900000001";
        // Device A signs in by code; device B gets its own tokens for the same account.
        super::super::request_json(
            &endpoint,
            "/auth/send-code",
            reqwest::Method::POST,
            None,
            Some(json!({"phone": phone})),
        )
        .await
        .unwrap();
        let login = super::super::request_json(
            &endpoint,
            "/auth/login",
            reqwest::Method::POST,
            None,
            Some(json!({"phone": phone, "code": code})),
        )
        .await
        .unwrap();
        first.sign_in(&login);
        let other = super::super::request_json(
            &endpoint,
            "/auth/refresh",
            reqwest::Method::POST,
            None,
            Some(json!({"refreshToken": login["refreshToken"]})),
        )
        .await
        .unwrap();
        second.sign_in(&other);
        super::super::auth_request(
            &first.state,
            &endpoint,
            "/projects",
            reqwest::Method::POST,
            Some(json!({"name": "Live study", "id": project})),
        )
        .await
        .unwrap();

        first.edit(|data| {
            data["records"] = json!([note("note-1", "Plan", "from a")]);
            data["records"][0]["project"] = json!(project);
            data["projects"][0]["question"] = json!("Does it travel?");
        });
        first.sync(&endpoint).await;
        second.sync(&endpoint).await;
        assert_eq!(second.records()[0]["body"], "from a");
        let data = second.state.storage.load().unwrap().unwrap();
        assert_eq!(data["projects"][0]["question"], "Does it travel?");

        second.edit(|data| data["records"][0]["body"] = json!("from b"));
        second.sync(&endpoint).await;
        first.sync(&endpoint).await;
        assert_eq!(first.records()[0]["body"], "from b");

        first.edit(|data| data["records"][0]["body"] = json!("a2"));
        second.edit(|data| data["records"][0]["body"] = json!("b2"));
        first.sync(&endpoint).await;
        let outcome = second.sync(&endpoint).await;
        assert_eq!(outcome.conflicts, 1, "{outcome:?}");
        let records = second.records();
        assert!(records
            .iter()
            .any(|r| r["id"] == "note-1" && r["body"] == "a2"));
        assert!(records
            .iter()
            .any(|r| r["body"] == "b2" && r["id"] != "note-1"));
        first.sync(&endpoint).await;
        assert_eq!(first.records().len(), 2);

        first.edit(|data| {
            data["records"]
                .as_array_mut()
                .unwrap()
                .retain(|r| r["id"] == "note-1")
        });
        first.sync(&endpoint).await;
        second.sync(&endpoint).await;
        assert_eq!(second.records().len(), 1);
        // A sync with nothing new changes nothing on either side.
        let quiet = second.sync(&endpoint).await;
        assert_eq!((quiet.applied, quiet.pushed), (0, 0));
    }
}
