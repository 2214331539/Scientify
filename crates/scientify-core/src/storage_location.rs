//! Resolve application-owned data before opening any service or browser profile.
//! Relocation copies and verifies first; the atomic pointer is the commit point.
use crate::storage::Storage;
use atomicwrites::{AllowOverwrite, AtomicFile};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};

const CONFIG: &str = "scientify-storage.json";

fn reject_linked_worktrees(container: &Path) -> Result<(), String> {
    let mut pending = vec![container.join("workspace/projects")];
    while let Some(path) = pending.pop() {
        if !path.exists() {
            continue;
        }
        crate::research::reject_links(&path)?;
        let marker = path.join(".git");
        if marker.is_file()
            || (marker.join("worktrees").is_dir()
                && fs::read_dir(marker.join("worktrees"))
                    .map_err(err)?
                    .next()
                    .is_some())
        {
            return Err("托管代码目录包含 Git worktree 登记，当前不能直接迁移应用数据。请先使用 Git 移除关联 worktree，或将主仓库迁至外部代码目录。原数据保持原位。".into());
        }
        for entry in fs::read_dir(&path).map_err(err)? {
            let entry = entry.map_err(err)?;
            if entry.file_type().map_err(err)?.is_dir()
                && !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | ".venv" | "node_modules" | "target" | "__pycache__")
                )
            {
                pending.push(entry.path());
            }
        }
    }
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Location {
    pub directory: PathBuf,
    pub pending: Option<PathBuf>,
    #[serde(default)]
    pub cleanup: Vec<PathBuf>,
}

pub struct Locator {
    installation: PathBuf,
    previous_roaming: PathBuf,
    previous_local: PathBuf,
}

fn err(error: impl std::fmt::Display) -> String {
    format!("数据位置操作失败：{error}")
}

fn write_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(err)?;
    AtomicFile::new(path, AllowOverwrite)
        .write(|f| {
            f.write_all(&bytes)?;
            f.sync_all()
        })
        .map_err(err)
}

// Check every ancestor, including Windows junctions. Never follow a link while copying or deleting.
fn regular(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                let link = meta.file_type().is_symlink();
                #[cfg(windows)]
                let link = {
                    use std::os::windows::fs::MetadataExt;
                    link || meta.file_attributes() & 0x400 != 0
                };
                if link {
                    return Err(format!(
                        "数据迁移不支持符号链接或目录联接：{}",
                        ancestor.display()
                    ));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(err(e)),
        }
    }
    Ok(())
}

fn normalized(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute()
        || path
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return Err("请选择绝对路径，不允许上级目录跳转。".into());
    }
    regular(path)?;
    fs::create_dir_all(path).map_err(err)?;
    fs::canonicalize(path).map_err(err)
}

fn empty(path: &Path) -> Result<(), String> {
    regular(path)?;
    if path.exists() && fs::read_dir(path).map_err(err)?.next().is_some() {
        return Err("目标数据文件夹必须为空，不能覆盖或合并已有数据。".into());
    }
    Ok(())
}

fn digest(path: &Path) -> Result<Vec<u8>, String> {
    let mut file = fs::File::open(path).map_err(err)?;
    let mut hash = Sha256::new();
    let mut bytes = [0; 64 * 1024];
    loop {
        let n = file.read(&mut bytes).map_err(err)?;
        if n == 0 {
            break;
        }
        hash.update(&bytes[..n]);
    }
    Ok(hash.finalize().to_vec())
}

fn copy_verified(source: &Path, target: &Path) -> Result<(), String> {
    regular(source)?;
    if source.is_dir() {
        fs::create_dir_all(target).map_err(err)?;
        for entry in fs::read_dir(source).map_err(err)? {
            let entry = entry.map_err(err)?;
            // Lock files are process coordination, never user data.
            if entry.file_name() == ".workspace.lock"
                || entry.file_name() == ".scientify-storage.lock"
            {
                continue;
            }
            copy_verified(&entry.path(), &target.join(entry.file_name()))?;
        }
    } else {
        fs::create_dir_all(target.parent().ok_or("目标路径无效")?).map_err(err)?;
        let mut input = fs::File::open(source).map_err(err)?;
        let mut output = fs::File::create(target).map_err(err)?;
        std::io::copy(&mut input, &mut output).map_err(err)?;
        output.sync_all().map_err(err)?;
        if digest(source)? != digest(target)? {
            return Err("复制校验失败，原数据已保留。".into());
        }
    }
    Ok(())
}

fn relocate_path(text: &str, mappings: &[(PathBuf, PathBuf)]) -> Option<String> {
    #[cfg(windows)]
    fn key(s: &str) -> String {
        s.strip_prefix(r"\\?\").unwrap_or(s).replace('/', "\\")
    }
    #[cfg(not(windows))]
    fn key(s: &str) -> String {
        s.to_string()
    }
    let value = key(text);
    for (source, target) in mappings {
        let prefix = key(&source.to_string_lossy());
        if value.eq_ignore_ascii_case(&prefix)
            || (value
                .get(..prefix.len())
                .is_some_and(|p| p.eq_ignore_ascii_case(&prefix))
                && value
                    .get(prefix.len()..)
                    .is_some_and(|p| p.starts_with(std::path::MAIN_SEPARATOR)))
        {
            // Use the original suffix, preserving non-ASCII names and letter case.
            #[cfg(windows)]
            let original = text.strip_prefix(r"\\?\").unwrap_or(text);
            #[cfg(not(windows))]
            let original = text;
            let suffix = &original[prefix.len()..];
            let mut replacement = target.display().to_string();
            #[cfg(windows)]
            if !text.starts_with(r"\\?\") {
                replacement = replacement
                    .strip_prefix(r"\\?\")
                    .unwrap_or(&replacement)
                    .to_string();
            }
            replacement.push_str(suffix);
            return Some(replacement);
        }
    }
    None
}

fn relocate_json(value: &mut Value, mappings: &[(PathBuf, PathBuf)]) -> bool {
    let mut changed = false;
    match value {
        Value::Object(fields) => {
            for (name, value) in fields {
                if matches!(
                    name.as_str(),
                    "path"
                        | "root"
                        | "cwd"
                        | "agentCwd"
                        | "directory"
                        | "executable"
                        | "workspaceRoot"
                        | "rollout_path"
                        | "writable_roots"
                ) {
                    match value {
                        Value::String(text) => {
                            if let Some(next) = relocate_path(text, mappings) {
                                *text = next;
                                changed = true;
                            }
                        }
                        Value::Array(items) => {
                            for item in items {
                                if let Some(text) = item.as_str() {
                                    if let Some(next) = relocate_path(text, mappings) {
                                        *item = Value::String(next);
                                        changed = true;
                                    }
                                }
                            }
                        }
                        _ => {}
                    }
                }
                changed |= relocate_json(value, mappings);
            }
        }
        Value::Array(items) => {
            for item in items {
                changed |= relocate_json(item, mappings);
            }
        }
        _ => {}
    }
    changed
}

fn rewrite_json(path: &Path, mappings: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let mut value: Value = serde_json::from_slice(&fs::read(path).map_err(err)?).map_err(err)?;
    if relocate_json(&mut value, mappings) {
        write_json(path, &value)?;
    }
    Ok(())
}

fn visit(path: &Path, action: &mut impl FnMut(&Path) -> Result<(), String>) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    regular(path)?;
    if path.is_dir() {
        for entry in fs::read_dir(path).map_err(err)? {
            visit(&entry.map_err(err)?.path(), action)?;
        }
    } else {
        action(path)?;
    }
    Ok(())
}

fn rewrite_owned_metadata(root: &Path, mappings: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let work = root.join("workspace");
    // Do not rewrite user code, credentials, chat text or browser profile files.
    for entry in fs::read_dir(&work).map_err(err)? {
        let p = entry.map_err(err)?.path();
        if p.is_file()
            && p.extension().is_some_and(|e| e == "json")
            && p.file_name().is_some_and(|n| {
                n.to_string_lossy().starts_with("workspace") || n == "literature-roots.json"
            })
        {
            if p.file_name().is_some_and(|n| n == "literature-roots.json") {
                let mut roots: BTreeMap<String, String> =
                    serde_json::from_slice(&fs::read(&p).map_err(err)?).map_err(err)?;
                for root in roots.values_mut() {
                    if let Some(next) = relocate_path(root, mappings) {
                        *root = next;
                    }
                }
                write_json(&p, &roots)?;
            } else {
                rewrite_json(&p, mappings)?;
            }
        }
    }
    for name in ["agent/bindings", "experiments"] {
        visit(&work.join(name), &mut |p| {
            if p.extension().is_some_and(|e| e == "json")
                && (name == "agent/bindings"
                    || p.file_name()
                        .is_some_and(|n| n == "record.json" || n == "request.json"))
            {
                rewrite_json(p, mappings)?;
            }
            Ok(())
        })?;
    }
    for domain in ["code", "literature"] {
        let home = work.join("agent").join(domain);
        for name in ["sessions", "archived_sessions"] {
            visit(&home.join(name), &mut |p| {
                if p.extension().is_some_and(|e| e == "jsonl") {
                    let original = fs::read_to_string(p).map_err(err)?;
                    let mut changed = false;
                    let mut lines = Vec::new();
                    for line in original.lines() {
                        let mut value: Value = serde_json::from_str(line).map_err(err)?;
                        if matches!(
                            value["type"].as_str(),
                            Some("session_meta" | "turn_context")
                        ) && relocate_json(&mut value, mappings)
                        {
                            changed = true;
                            lines.push(serde_json::to_string(&value).map_err(err)?);
                        } else {
                            lines.push(line.to_string());
                        }
                    }
                    if changed {
                        fs::write(p, format!("{}\n", lines.join("\n"))).map_err(err)?;
                    }
                }
                Ok(())
            })?;
        }
        if home.exists() {
            for entry in fs::read_dir(&home).map_err(err)? {
                let p = entry.map_err(err)?.path();
                if p.extension().is_some_and(|e| e == "sqlite") {
                    rewrite_database(&p, mappings)?;
                }
            }
        }
    }
    if work.join("workspace.json").exists() {
        crate::storage::read_workspace(&work.join("workspace.json"))?;
    }
    Ok(())
}

fn rewrite_database(path: &Path, mappings: &[(PathBuf, PathBuf)]) -> Result<(), String> {
    let mut connection = rusqlite::Connection::open(path).map_err(err)?;
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |r| r.get(0))
        .map_err(err)?;
    if check != "ok" {
        return Err("Agent 历史数据库校验失败，原数据已保留。".into());
    }
    let transaction = connection.transaction().map_err(err)?;
    for (table, column) in [
        ("threads", "cwd"),
        ("threads", "rollout_path"),
        ("project_roots", "path"),
        ("rollout_migration_skipped_rollouts", "rollout_path"),
    ] {
        let exists: bool = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(err)?;
        if !exists {
            continue;
        }
        let mut statement = transaction
            .prepare(&format!(
                "SELECT rowid, {column} FROM {table} WHERE {column} IS NOT NULL"
            ))
            .map_err(err)?;
        let rows = statement
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(err)?;
        drop(statement);
        for (rowid, text) in rows {
            if let Some(next) = relocate_path(&text, mappings) {
                transaction
                    .execute(
                        &format!("UPDATE {table} SET {column}=?1 WHERE rowid=?2"),
                        rusqlite::params![next, rowid],
                    )
                    .map_err(err)?;
            }
        }
    }
    transaction.commit().map_err(err)?;
    connection
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(err)
}

impl Locator {
    pub fn new(installation: PathBuf, previous_roaming: PathBuf, previous_local: PathBuf) -> Self {
        Self {
            installation,
            previous_roaming,
            previous_local,
        }
    }
    fn config(&self) -> PathBuf {
        self.installation.join(CONFIG)
    }
    pub fn location(&self) -> Result<Location, String> {
        if self.config().exists() {
            regular(&self.config())?;
            serde_json::from_slice(&fs::read(self.config()).map_err(err)?).map_err(err)
        } else {
            Ok(Location {
                directory: self.installation.join("ScientifyData"),
                pending: None,
                cleanup: vec![],
            })
        }
    }
    pub fn schedule(&self, active: &Path, target: &Path) -> Result<Location, String> {
        let mut location = self.location()?;
        if normalized(&location.directory)? != normalized(active)? {
            return Err("存储位置已变化，请重新启动应用。".into());
        }
        let target = normalized(target)?;
        let active = normalized(active)?;
        reject_linked_worktrees(&active)?;
        let installation = fs::canonicalize(&self.installation).map_err(err)?;
        if target.starts_with(&active)
            || active.starts_with(&target)
            || installation.starts_with(&target)
        {
            return Err("请选择独立的空文件夹，不能使用当前数据目录或安装目录的上级。".into());
        }
        empty(&target)?;
        let probe = target.join(format!(".write-test-{}", uuid::Uuid::new_v4()));
        fs::write(&probe, b"Scientify").map_err(err)?;
        fs::remove_file(probe).map_err(err)?;
        location.pending = Some(target);
        write_json(&self.config(), &location)?;
        Ok(location)
    }
    pub fn cancel(&self) -> Result<Location, String> {
        let mut location = self.location()?;
        location.pending = None;
        write_json(&self.config(), &location)?;
        Ok(location)
    }
    pub fn prepare(&self) -> Result<Location, String> {
        regular(&self.installation)?;
        let lock = fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(self.installation.join(".scientify-storage.lock"))
            .map_err(err)?;
        lock.try_lock_exclusive()
            .map_err(|_| "另一个 Scientify 正在迁移数据。".to_string())?;
        let mut location = self.location()?;
        let first = !self.config().exists();
        let source = location.directory.clone();
        let target = location.pending.clone().unwrap_or_else(|| source.clone());
        let migrating = location.pending.is_some()
            || (first && self.previous_roaming.join("workspace").exists());
        if migrating {
            reject_linked_worktrees(if first {
                &self.previous_roaming
            } else {
                &source
            })?;
            empty(&target)?;
            // Holding Storage's lock rejects a running old application before copying.
            let old_work = if first {
                self.previous_roaming.join("workspace")
            } else {
                source.join("workspace")
            };
            let _source_lock = Storage::open(old_work.clone())?;
            let target = normalized(&target)?;
            let staging = target
                .parent()
                .ok_or("目标路径无效")?
                .join(format!(".scientify-move-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&staging).map_err(err)?;
            let mappings = if first {
                vec![
                    (old_work, target.join("workspace")),
                    (
                        self.previous_roaming.join("browser-profile"),
                        target.join("browser-profile"),
                    ),
                    (
                        self.previous_local.join("EBWebView"),
                        target.join("ui-profile/EBWebView"),
                    ),
                    (
                        self.previous_local.join("workspace-ui-profile"),
                        target.join("workspace-ui-profile"),
                    ),
                ]
            } else {
                vec![(source.clone(), target.clone())]
            };
            let sources = if first {
                mappings.clone()
            } else {
                vec![(source.clone(), target.clone())]
            };
            let result = (|| {
                for (old, new) in &sources {
                    if old.exists() {
                        copy_verified(old, &staging.join(new.strip_prefix(&target).map_err(err)?))?;
                    }
                }
                rewrite_owned_metadata(&staging, &mappings)?;
                fs::write(staging.join(".gitignore"), b"*\n").map_err(err)?;
                write_json(
                    &staging.join("migration.json"),
                    &serde_json::json!({"sources": sources.iter().map(|(p,_)| p).collect::<Vec<_>>(), "verified":true}),
                )?;
                fs::remove_dir(&target).map_err(err)?;
                fs::rename(&staging, &target).map_err(err)?;
                location.directory = target;
                location.pending = None;
                location.cleanup = sources.into_iter().map(|(p, _)| p).collect();
                // If this fails, the source remains authoritative; keep the verified target for recovery.
                write_json(&self.config(), &location)
            })();
            if let Err(error) = result {
                return Err(format!(
                    "{error} 原数据未删除；迁移副本：{}",
                    staging.display()
                ));
            }
            drop(_source_lock);
        } else {
            location.directory = normalized(&location.directory)?;
            fs::create_dir_all(location.directory.join("workspace")).map_err(err)?;
            if !location.directory.join(".gitignore").exists() {
                fs::write(location.directory.join(".gitignore"), b"*\n").map_err(err)?;
            }
            if first {
                write_json(&self.config(), &location)?;
            }
        }
        // Only paths recorded by the successful transaction can be removed.
        let mut remaining = vec![];
        for source in &location.cleanup {
            regular(source)?;
            let canonical = if source.exists() {
                fs::canonicalize(source).map_err(err)?
            } else {
                continue;
            };
            let current = fs::canonicalize(&location.directory).map_err(err)?;
            if canonical.starts_with(&current) || current.starts_with(&canonical) {
                return Err("清理路径与当前数据目录重叠。".into());
            }
            if fs::remove_dir_all(source).is_err() {
                remaining.push(source.clone());
            }
        }
        if location.cleanup != remaining {
            location.cleanup = remaining;
            write_json(&self.config(), &location)?;
        }
        Ok(location)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (tempfile::TempDir, Locator) {
        let dir = tempfile::tempdir().unwrap();
        let install = dir.path().join("install");
        fs::create_dir(&install).unwrap();
        let locator = Locator::new(
            install,
            dir.path().join("roaming"),
            dir.path().join("local"),
        );
        (dir, locator)
    }
    #[test]
    fn migration_preserves_files_keys_history_and_external_roots() {
        let (_dir, locator) = fixture();
        let old = locator.previous_roaming.join("workspace");
        fs::create_dir_all(old.join("agent/code/sessions")).unwrap();
        fs::create_dir_all(old.join("projects/p1")).unwrap();
        fs::write(old.join("projects/p1/main.py"), b"print('science')").unwrap();
        let credentials = br#"{"test-key":"local-fixture"}"#;
        fs::write(old.join("credentials.json"), credentials).unwrap();
        let workspace = crate::workspace::empty();
        write_json(&old.join("workspace.json"), &workspace).unwrap();
        fs::create_dir_all(old.join("agent/bindings/p1")).unwrap();
        write_json(&old.join("agent/bindings/p1/chat.json"), &serde_json::json!({"root":old.join("projects/p1"), "started":true,"threadId":"t1","text":old.display().to_string()})).unwrap();
        let rollout = old.join("agent/code/sessions/history.jsonl");
        fs::write(&rollout, format!("{}\n{}\n", serde_json::json!({"type":"session_meta","payload":{"cwd":old.join("projects/p1")}}), serde_json::json!({"type":"response_item","payload":{"text":old.display().to_string()}}))).unwrap();
        let db = rusqlite::Connection::open(old.join("agent/code/state_5.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE threads (cwd TEXT, rollout_path TEXT);")
            .unwrap();
        db.execute(
            "INSERT INTO threads VALUES (?1,?2)",
            rusqlite::params![
                old.join("projects/p1").display().to_string(),
                rollout.display().to_string()
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO threads VALUES (?1,?2)",
            rusqlite::params!["D:/external/project", rollout.display().to_string()],
        )
        .unwrap();
        drop(db);
        fs::create_dir_all(locator.previous_local.join("EBWebView")).unwrap();
        fs::write(
            locator.previous_local.join("EBWebView/cookie-cache"),
            b"profile",
        )
        .unwrap();
        let location = locator.prepare().unwrap();
        let work = location.directory.join("workspace");
        assert!(!old.exists());
        assert_eq!(
            fs::read(work.join("credentials.json")).unwrap(),
            credentials
        );
        assert_eq!(
            fs::read(work.join("projects/p1/main.py")).unwrap(),
            b"print('science')"
        );
        let binding: Value =
            serde_json::from_slice(&fs::read(work.join("agent/bindings/p1/chat.json")).unwrap())
                .unwrap();
        assert!(binding["root"].as_str().unwrap().contains("ScientifyData"));
        assert_eq!(binding["text"], old.display().to_string());
        let db = rusqlite::Connection::open(work.join("agent/code/state_5.sqlite")).unwrap();
        let paths: Vec<(String, String)> = db
            .prepare("SELECT cwd,rollout_path FROM threads")
            .unwrap()
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(paths[0].0.contains("ScientifyData"));
        assert!(Path::new(&paths[0].1).is_file());
        assert_eq!(paths[1].0, "D:/external/project");
        assert_eq!(
            fs::read(location.directory.join("ui-profile/EBWebView/cookie-cache")).unwrap(),
            b"profile"
        );
        assert!(locator.prepare().unwrap().cleanup.is_empty());
    }
    #[test]
    fn location_changes_only_on_next_start_and_can_be_cancelled() {
        let (dir, locator) = fixture();
        let original = locator.prepare().unwrap();
        fs::write(original.directory.join("workspace/user.txt"), b"saved").unwrap();
        let target = dir.path().join("other-drive");
        let pending = locator.schedule(&original.directory, &target).unwrap();
        assert_eq!(pending.directory, original.directory);
        assert!(original.directory.join("workspace/user.txt").exists());
        assert!(locator.cancel().unwrap().pending.is_none());
        locator.schedule(&original.directory, &target).unwrap();
        let next = locator.prepare().unwrap();
        assert_eq!(
            fs::read(next.directory.join("workspace/user.txt")).unwrap(),
            b"saved"
        );
        assert!(!original.directory.exists());
    }
    #[test]
    fn relocation_protects_managed_worktree_links_before_changing_the_pointer() {
        let (dir, locator) = fixture();
        let original = locator.prepare().unwrap();
        let repo = original
            .directory
            .join("workspace/projects/p1/.git/worktrees/linked");
        fs::create_dir_all(&repo).unwrap();
        fs::write(repo.join("gitdir"), "F:/external/.git").unwrap();
        assert!(locator
            .schedule(&original.directory, &dir.path().join("new-data"))
            .unwrap_err()
            .contains("worktree"));
        assert!(locator.location().unwrap().pending.is_none());
        assert!(repo.join("gitdir").exists());
    }
    #[test]
    fn rejects_live_source_and_nonempty_target_without_deleting_data() {
        let (dir, locator) = fixture();
        fs::create_dir_all(locator.previous_roaming.join("workspace")).unwrap();
        let source_lock = Storage::open(locator.previous_roaming.join("workspace")).unwrap();
        assert!(locator.prepare().unwrap_err().contains("另一个"));
        drop(source_lock);
        let original = locator.prepare().unwrap();
        let target = dir.path().join("occupied");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("do-not-overwrite"), b"safe").unwrap();
        assert!(locator.schedule(&original.directory, &target).is_err());
        assert!(locator
            .schedule(&original.directory, &original.directory.join("nested"))
            .is_err());
        assert_eq!(fs::read(target.join("do-not-overwrite")).unwrap(), b"safe");
        assert!(original.directory.exists());
    }
    #[test]
    fn failed_metadata_validation_leaves_pointer_and_source_intact() {
        let (_dir, locator) = fixture();
        let source = locator.previous_roaming.join("workspace");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("workspace.json"), b"corrupt").unwrap();
        assert!(locator.prepare().is_err());
        assert!(!locator.config().exists());
        assert_eq!(fs::read(source.join("workspace.json")).unwrap(), b"corrupt");
    }
}
