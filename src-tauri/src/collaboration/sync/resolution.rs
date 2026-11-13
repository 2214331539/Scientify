//! Preview and resolve the conflict copies made by sync, under the same project lock.
use super::*;
use scientify_core::research::reject_links;

const PREVIEW_BYTES: usize = 256 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictKey {
    pub domain: String,
    pub path: String,
    pub at: String,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Choice {
    Local,
    Remote,
    Both,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    text: Option<String>,
    bytes: u64,
    exists: bool,
    truncated: bool,
    hash: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub token: String,
    local: Version,
    remote: Version,
    can_keep_local: bool,
    can_keep_both: bool,
}

fn find<'a>(state: &'a ProjectSync, key: &ConflictKey) -> Result<&'a Conflict, String> {
    state
        .conflicts
        .iter()
        .find(|c| c.domain == key.domain && c.path == key.path && c.at == key.at)
        .ok_or_else(|| "冲突已处理，请刷新同步面板。".into())
}

fn root(device: &Device<'_>, project: &str, domain: Domain) -> Result<PathBuf, String> {
    match domain {
        Domain::Library => device
            .library
            .root(project)?
            .ok_or_else(|| "请先打开文献文件夹。".into()),
        Domain::Code => crate::research::project_root(device.storage, device.files, project),
        Domain::Asset => Ok(device.data().join("note-assets").join(project)),
        _ => Err("此内容不是文件。".into()),
    }
}

fn safe_target(root: &Path, path: &str) -> Result<PathBuf, String> {
    if !valid_path(path) {
        return Err("同步路径无效。".into());
    }
    let file = target(root, path);
    reject_links(&file)?;
    Ok(file)
}

fn file_version(path: &Path) -> Result<Version, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(value_version(None))
        }
        Err(error) => return Err(error.to_string()),
    };
    let size = file.metadata().map_err(|e| e.to_string())?.len();
    let mut bytes = Vec::new();
    (&mut file)
        .take(PREVIEW_BYTES as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let text = if bytes.contains(&0) {
        None
    } else {
        String::from_utf8(bytes).ok()
    };
    Ok(Version {
        text,
        bytes: size,
        exists: true,
        truncated: size > PREVIEW_BYTES as u64,
        hash: Some(hash_file(path)?),
    })
}

fn value_version(value: Option<&Value>) -> Version {
    let text = value.map(|value| {
        value["body"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| serde_json::to_string_pretty(value).expect("JSON value"))
    });
    Version {
        bytes: text.as_ref().map_or(0, |s| s.len() as u64),
        text,
        exists: value.is_some(),
        truncated: false,
        hash: value.map(record_hash),
    }
}

fn record_versions(
    data: &Value,
    project: &str,
    domain: Domain,
    conflict: &Conflict,
) -> (Option<Value>, Option<Value>) {
    let records = local_records(data, project);
    let value = |id: &str| match records.get(&key(domain, id)) {
        Some(Item::Record { content, .. }) => Some(content.clone()),
        _ => None,
    };
    let local = if conflict.copy.is_empty() {
        conflict.local.clone()
    } else {
        value(&conflict.copy)
    };
    (local, value(&conflict.path))
}

pub(crate) fn preview(
    device: &Device<'_>,
    project: &str,
    key: &ConflictKey,
) -> Result<Preview, String> {
    let state = load_state(device.data(), project)?;
    let conflict = find(&state, key)?;
    let domain = Domain::parse(&conflict.domain).ok_or("同步类型无效。")?;
    let (local, remote) = if domain.is_file() {
        let root = root(device, project, domain)?;
        let local = if conflict.copy.is_empty() {
            value_version(None)
        } else {
            file_version(&safe_target(&root, &conflict.copy)?)?
        };
        (local, file_version(&safe_target(&root, &conflict.path)?)?)
    } else {
        let data = device.storage.load()?.ok_or("工作区尚未载入。")?;
        let (local, remote) = record_versions(&data, project, domain, conflict);
        (
            value_version(local.as_ref()),
            value_version(remote.as_ref()),
        )
    };
    let token = record_hash(&json!([conflict, local.hash, remote.hash]));
    Ok(Preview {
        token,
        can_keep_local: local.exists,
        can_keep_both: local.exists && !conflict.copy.is_empty(),
        local,
        remote,
    })
}

pub(crate) fn resolve(
    device: &Device<'_>,
    project: &str,
    key: &ConflictKey,
    token: &str,
    choice: Choice,
) -> Result<(), String> {
    let mut state = load_state(device.data(), project)?;
    let conflict = find(&state, key)?.clone();
    let domain = Domain::parse(&conflict.domain).ok_or("同步类型无效。")?;
    // Taking the server's version only discards local copies, so every member may do it.
    if !matches!(choice, Choice::Remote) {
        super::super::permissions::require_write(device.storage, project, domain.name())?;
    }
    let root = if domain.is_file() {
        Some(root(device, project, domain)?)
    } else {
        None
    };
    let _lease = root
        .as_ref()
        .map(|root| crate::code::Lease::mutation(root))
        .transpose()?;
    let current = preview(device, project, key)?;
    if current.token != token {
        return Err("对比内容已变化，请重新打开对比后再处理。".into());
    }
    if matches!(choice, Choice::Local) && !current.can_keep_local
        || matches!(choice, Choice::Both) && !current.can_keep_both
    {
        return Err("此旧冲突没有可定位的本机副本，请先检查现有文件。".into());
    }
    if !matches!(choice, Choice::Both) {
        if let Some(root) = root {
            if matches!(choice, Choice::Local) {
                let from = safe_target(&root, &conflict.copy)?;
                let bytes = fs::read(&from).map_err(|e| e.to_string())?;
                write_file(&safe_target(&root, &conflict.path)?, &bytes)?;
            }
            if !conflict.copy.is_empty() {
                let copy = safe_target(&root, &conflict.copy)?;
                match fs::remove_file(copy) {
                    Ok(()) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
        } else {
            // Save with the revision we compared; never retry over a concurrent note edit.
            let mut data = device.storage.load()?.ok_or("工作区尚未载入。")?;
            if preview(device, project, key)?.token != token {
                return Err("对比内容已变化，请重新打开对比后再处理。".into());
            }
            let revision = data["revision"].as_u64().unwrap_or(0);
            if matches!(choice, Choice::Local) {
                let (local, _) = record_versions(&data, project, domain, &conflict);
                let mut content = local.ok_or("本机副本已不存在。")?;
                let label = if domain == Domain::Record {
                    "title"
                } else {
                    "name"
                };
                if let Some(original) = conflict.local.as_ref().and_then(|v| v[label].as_str()) {
                    if content[label] == format!("{original}（冲突副本）") {
                        content[label] = json!(original);
                    }
                }
                apply_action(
                    &mut data,
                    project,
                    &RecordAction::Put {
                        domain,
                        id: conflict.path.clone(),
                        content,
                    },
                )?;
            }
            if !conflict.copy.is_empty() {
                apply_action(
                    &mut data,
                    project,
                    &RecordAction::Delete {
                        domain,
                        id: conflict.copy.clone(),
                    },
                )?;
            }
            data["revision"] = json!(revision + 1);
            data["updatedAt"] = json!(scientify_core::workspace::now());
            device.storage.save(data, revision)?;
        }
    }
    state
        .conflicts
        .retain(|c| !(c.domain == key.domain && c.path == key.path && c.at == key.at));
    save_state(device.data(), project, &state)
}

pub(crate) fn set_paused(data: &Path, project: &str, paused: bool) -> Result<(), String> {
    let mut state = load_state(data, project)?;
    state.paused = paused;
    save_state(data, project, &state)
}

/// Count actual changed entries; this is a scan, not a second persistent queue.
pub(crate) fn pending(
    device: &Device<'_>,
    project: &str,
    state: &ProjectSync,
) -> Result<usize, String> {
    let data = device.storage.load()?.ok_or("工作区尚未载入。")?;
    let role = data["projects"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|p| p["id"] == project)
        .and_then(|p| p["collaborationRole"].as_str());
    let mut local = local_records(&data, project);
    let roots = [
        (Domain::Library, device.library.root(project)?),
        (Domain::Code, Some(root(device, project, Domain::Code)?)),
        (Domain::Asset, Some(root(device, project, Domain::Asset)?)),
    ];
    for (domain, root) in roots {
        if let Some(root) = root {
            for (path, item) in scan(&root, domain, &state.entries, &mut 0)? {
                local.insert(key(domain, &path), item);
            }
        }
    }
    let keys: BTreeSet<_> = local.keys().chain(state.entries.keys()).collect();
    Ok(keys
        .into_iter()
        .filter(|key| {
            let Some((domain, _)) = split_key(key) else {
                return false;
            };
            super::super::permissions::can_write(role, domain.name())
                && local.get(*key).map(Item::hash)
                    != state.entries.get(*key).and_then(|e| e.hash.as_deref())
        })
        .count())
}
