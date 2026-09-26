use crate::workspace::{self, MAX_BYTES, MAX_REVISION};
use atomicwrites::{AllowOverwrite, AtomicFile};
use fs2::FileExt;
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub struct Storage {
    directory: PathBuf,
    gate: Mutex<()>,
    // Lock lives beside workspace so migration can publish a complete directory.
    _process_lock: File,
}

fn io_error(e: impl std::fmt::Display) -> String {
    format!("文件操作失败：{e}")
}

fn reject_link(path: &Path) -> Result<(), String> {
    let meta = fs::symlink_metadata(path).map_err(io_error)?;
    let mut linked = meta.file_type().is_symlink();
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        linked |= meta.file_attributes() & 0x400 != 0;
    }
    if linked {
        return Err("工作区不能包含符号链接或目录联接。".into());
    }
    Ok(())
}

/// Check ancestors too: a regular file under a junction is still outside our root.
fn reject_link_ancestors(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors() {
        if ancestor.as_os_str().is_empty() {
            continue;
        }
        match fs::symlink_metadata(ancestor) {
            Ok(_) => reject_link(ancestor)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(())
}

pub fn read_workspace(path: &Path) -> Result<Value, String> {
    reject_link_ancestors(path)?;
    let mut file = File::open(path).map_err(io_error)?;
    if file.metadata().map_err(io_error)?.len() > MAX_BYTES {
        return Err("工作区超过 64 MiB。".into());
    }
    let mut bytes = Vec::new();
    Read::by_ref(&mut file)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    workspace::parse(&bytes)
}

fn atomic_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    reject_link_ancestors(path)?;
    AtomicFile::new(path, AllowOverwrite)
        .write(|file| {
            file.write_all(bytes)?;
            file.sync_all()
        })
        .map_err(io_error)
}

fn encoded(data: &Value) -> Result<Vec<u8>, String> {
    let bytes = serde_json::to_vec(data).map_err(io_error)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err("工作区超过 64 MiB。".into());
    }
    Ok(bytes)
}

impl Storage {
    pub fn open(directory: PathBuf) -> Result<Self, String> {
        if !directory.is_absolute() {
            return Err("数据目录必须是绝对路径。".into());
        }
        reject_link_ancestors(&directory)?;
        let parent = directory.parent().ok_or("数据目录无父目录。")?;
        fs::create_dir_all(parent).map_err(io_error)?;
        let name = directory
            .file_name()
            .ok_or("数据目录无效。")?
            .to_string_lossy();
        let lock_path = parent.join(format!(".{name}.lock"));
        reject_link_ancestors(&lock_path)?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(io_error)?;
        file.try_lock_exclusive()
            .map_err(|_| "该数据目录正在被另一个 Scientify 进程使用。".to_string())?;
        Ok(Self {
            directory,
            gate: Mutex::new(()),
            _process_lock: file,
        })
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    fn load_inner(&self) -> Result<Option<Value>, String> {
        let target = self.directory.join("workspace.json");
        reject_link_ancestors(&target)?;
        match fs::symlink_metadata(&target) {
            Ok(_) => read_workspace(&target).map(Some),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(io_error(e)),
        }
    }

    pub fn load(&self) -> Result<Option<Value>, String> {
        let _guard = self.gate.lock().map_err(io_error)?;
        self.load_inner()
    }

    fn commit(&self, next: &Value, current: Option<&Value>) -> Result<(), String> {
        let bytes = encoded(next)?;
        reject_link_ancestors(&self.directory)?;
        fs::create_dir_all(&self.directory).map_err(io_error)?;
        if let Some(old) = current {
            atomic_bytes(
                &self.directory.join("workspace.backup.json"),
                &encoded(old)?,
            )?;
        }
        atomic_bytes(&self.directory.join("workspace.json"), &bytes)
    }

    pub fn save(&self, value: Value, expected_revision: u64) -> Result<Value, String> {
        let next = workspace::validate(value)?;
        let _guard = self.gate.lock().map_err(io_error)?;
        // Never overwrite an unreadable main file with an empty client snapshot.
        let current = self.load_inner()?;
        let revision = current
            .as_ref()
            .and_then(|v| v["revision"].as_u64())
            .unwrap_or(0);
        if revision != expected_revision {
            return Err("工作区已发生变化，请重新载入后再保存。".into());
        }
        if revision >= MAX_REVISION || next["revision"].as_u64() != Some(revision + 1) {
            return Err("提交的工作区版本必须递增一次。".into());
        }
        self.commit(&next, current.as_ref())?;
        Ok(next)
    }

    pub fn restore(&self) -> Result<Value, String> {
        let _guard = self.gate.lock().map_err(io_error)?;
        let backup = read_workspace(&self.directory.join("workspace.backup.json"))?;
        let target = self.directory.join("workspace.json");
        reject_link_ancestors(&target)?;
        if target.exists() {
            fs::copy(
                &target,
                self.directory
                    .join(format!("workspace-unreadable-{}.json", Uuid::new_v4())),
            )
            .map_err(io_error)?;
        }
        atomic_bytes(&target, &encoded(&backup)?)?;
        Ok(backup)
    }

    pub fn import(&self, value: Value) -> Result<Value, String> {
        let mut next = workspace::validate(value)?;
        let _guard = self.gate.lock().map_err(io_error)?;
        let current = self.load_inner()?;
        let revision = current
            .as_ref()
            .and_then(|v| v["revision"].as_u64())
            .unwrap_or(0);
        if revision >= MAX_REVISION {
            return Err("工作区版本超过上限。".into());
        }
        next["revision"] = (revision + 1).into();
        next["updatedAt"] = workspace::now().into();
        // Validate size before creating any before-import artifacts.
        encoded(&next)?;
        reject_link_ancestors(&self.directory)?;
        fs::create_dir_all(&self.directory).map_err(io_error)?;
        if let Some(old) = current.as_ref() {
            atomic_bytes(
                &self
                    .directory
                    .join(format!("workspace-before-import-{}.json", Uuid::new_v4())),
                &encoded(old)?,
            )?;
        }
        self.commit(&next, current.as_ref())?;
        Ok(next)
    }

    pub fn export(&self, destination: &Path) -> Result<(), String> {
        let _guard = self.gate.lock().map_err(io_error)?;
        let data = self.load_inner()?.unwrap_or_else(workspace::empty);
        reject_link_ancestors(destination)?;
        // An export dialog must never overwrite live managed files.
        let parent = destination
            .parent()
            .ok_or("导出路径无效。")?
            .canonicalize()
            .map_err(io_error)?;
        if let Ok(root) = self.directory.canonicalize() {
            if parent.starts_with(root) {
                return Err("请将导出文件保存到工作区数据目录之外。".into());
            }
        }
        atomic_bytes(destination, &encoded(&data)?)
    }

    pub fn migrate_legacy(&self, source: &Path) -> Result<Value, String> {
        let _guard = self.gate.lock().map_err(io_error)?;
        reject_link_ancestors(source)?;
        reject_link_ancestors(&self.directory)?;
        read_workspace(&source.join("workspace.json"))?;
        let read_source = || -> Result<Vec<u8>, String> {
            let mut bytes = Vec::new();
            File::open(source.join("workspace.json"))
                .map_err(io_error)?
                .take(MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(io_error)?;
            workspace::parse(&bytes)?;
            Ok(bytes)
        };
        let before = read_source()?;
        if self.directory.exists()
            && fs::read_dir(&self.directory)
                .map_err(io_error)?
                .next()
                .is_some()
        {
            return Err("新工作区已存在数据，不能覆盖迁移。请使用独立空数据目录。".into());
        }
        let parent = self.directory.parent().ok_or("数据目录无效。")?;
        let staging = parent.join(format!(".migration-{}", Uuid::new_v4()));
        let result = (|| {
            copy_tree(source, &staging)?;
            // Detect ordinary concurrent Electron writes; user must close it first.
            if read_source()? != before {
                return Err("旧工作区在复制期间发生变化，请关闭 Electron 后重试。".into());
            }
            let migrated = read_workspace(&staging.join("workspace.json"))?;
            if self.directory.exists() {
                fs::remove_dir(&self.directory).map_err(io_error)?;
            }
            fs::rename(&staging, &self.directory).map_err(io_error)?;
            Ok(migrated)
        })();
        if result.is_err() && staging.exists() {
            // Only this operation's UUID-named staging directory is removed.
            let _ = fs::remove_dir_all(&staging);
        }
        result
    }
}

fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    reject_link(source)?;
    fs::create_dir(target).map_err(io_error)?;
    for entry in fs::read_dir(source).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        reject_link(&entry.path())?;
        let kind = entry.file_type().map_err(io_error)?;
        let destination = target.join(entry.file_name());
        if kind.is_dir() {
            copy_tree(&entry.path(), &destination)?;
        } else if kind.is_file() {
            fs::copy(entry.path(), &destination).map_err(io_error)?;
            OpenOptions::new()
                .write(true)
                .open(destination)
                .map_err(io_error)?
                .sync_all()
                .map_err(io_error)?;
        } else {
            return Err("旧工作区包含不支持的特殊文件。".into());
        }
    }
    Ok(())
}
