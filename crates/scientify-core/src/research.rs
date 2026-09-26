//! Bounded local project file access. Paths from the webview are always relative.
use atomicwrites::{AllowOverwrite, AtomicFile, DisallowOverwrite};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub const MAX_TEXT_BYTES: u64 = 2 * 1024 * 1024;
pub const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResearchFile {
    pub path: String,
    pub name: String,
    pub kind: &'static str,
    pub size: u64,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FileContent {
    pub path: String,
    pub content: String,
    pub version: String,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ImportedPdf {
    pub asset_id: String,
    pub file_name: String,
    pub size: u64,
}

fn io_error(error: impl std::fmt::Display) -> String {
    format!("文件操作失败：{error}")
}

pub fn reject_links(path: &Path) -> Result<(), String> {
    for ancestor in path.ancestors().filter(|p| !p.as_os_str().is_empty()) {
        match fs::symlink_metadata(ancestor) {
            Ok(meta) => {
                let mut linked = meta.file_type().is_symlink();
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    linked |= meta.file_attributes() & 0x400 != 0;
                }
                if linked {
                    return Err("文件路径不能包含符号链接或目录联接。".into());
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(io_error(e)),
        }
    }
    Ok(())
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.len() > 2048
        || value.starts_with(['/', '\\'])
        || value.contains([':', '\0'])
    {
        return Err("文件路径必须是项目内的相对路径。".into());
    }
    let value = value.replace('\\', "/");
    if value.split('/').count() > 32 {
        return Err("目录层级超过 32 层。".into());
    }
    for part in value.split('/') {
        let base = part
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_uppercase();
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.eq_ignore_ascii_case(".git")
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "<>\"|?*".contains(c))
            || matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((base.starts_with("COM") || base.starts_with("LPT"))
                && base.len() == 4
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("文件路径包含不支持的名称或越界片段。".into());
        }
    }
    let path = PathBuf::from(value);
    if path
        .components()
        .any(|c| !matches!(c, Component::Normal(_)))
    {
        return Err("文件路径无效。".into());
    }
    Ok(path)
}

fn bounded_read(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    reject_links(path)?;
    let file = File::open(path).map_err(io_error)?;
    let meta = file.metadata().map_err(io_error)?;
    if !meta.is_file() {
        return Err("所选对象不是普通文件。".into());
    }
    if meta.len() > limit {
        return Err(format!("文件超过 {} MiB 上限。", limit / 1024 / 1024));
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > limit {
        return Err("读取期间文件大小超过限制。".into());
    }
    Ok(bytes)
}

fn version(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn portable(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

pub struct ResearchFiles {
    data_directory: PathBuf,
    gate: Mutex<()>,
}

impl ResearchFiles {
    pub fn new(data_directory: PathBuf) -> Self {
        Self {
            data_directory,
            gate: Mutex::new(()),
        }
    }

    pub fn project_root(&self, id: &str, configured: Option<&str>) -> Result<PathBuf, String> {
        if !valid_id(id) {
            return Err("项目标识无效。".into());
        }
        let configured = configured.filter(|p| !p.trim().is_empty());
        let root = configured
            .map(PathBuf::from)
            .unwrap_or_else(|| self.data_directory.join("projects").join(id));
        if !root.is_absolute() {
            return Err("项目目录必须是绝对路径，请在项目设置中重新选择。".into());
        }
        reject_links(&root)?;
        if configured.is_none() {
            fs::create_dir_all(&root).map_err(io_error)?;
        }
        if !root.is_dir() {
            return Err("项目目录不存在或不可访问，请检查项目路径。".into());
        }
        let root = root.canonicalize().map_err(io_error)?;
        if configured.is_some()
            && self
                .data_directory
                .canonicalize()
                .is_ok_and(|data| root.starts_with(data))
        {
            return Err("项目目录不能指向 Scientify 内部数据目录，请选择独立的源码目录。".into());
        }
        Ok(root)
    }

    fn internal_path(&self, root: &Path, path: &Path) -> bool {
        self.data_directory.canonicalize().is_ok_and(|data| {
            // Canonicalize the nearest existing ancestor for Windows case aliases,
            // including a new file whose own path does not exist yet.
            let resolved = path
                .ancestors()
                .find_map(|ancestor| {
                    ancestor.canonicalize().ok().and_then(|real| {
                        path.strip_prefix(ancestor).ok().map(|tail| real.join(tail))
                    })
                })
                .unwrap_or_else(|| path.to_path_buf());
            let lock = data
                .parent()
                .zip(data.file_name())
                .map(|(parent, name)| parent.join(format!(".{}.lock", name.to_string_lossy())));
            lock.is_some_and(|lock| resolved == lock)
                || (resolved.starts_with(&data) && !root.starts_with(data.join("projects")))
        })
    }

    fn resolve(&self, root: &Path, value: &str, create_parent: bool) -> Result<PathBuf, String> {
        reject_links(root)?;
        let root = root.canonicalize().map_err(io_error)?;
        let path = root.join(relative(value)?);
        if self.internal_path(&root, &path) {
            return Err("编辑器不能访问 Scientify 内部数据文件。".into());
        }
        reject_links(&path)?;
        let parent = path.parent().ok_or("文件路径无效。")?;
        if create_parent {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        let real_parent = parent.canonicalize().map_err(io_error)?;
        if !real_parent.starts_with(&root) {
            return Err("文件路径超出项目目录。".into());
        }
        if path.exists() && !path.canonicalize().map_err(io_error)?.starts_with(&root) {
            return Err("文件路径超出项目目录。".into());
        }
        reject_links(&path)?;
        Ok(path)
    }

    pub fn list(&self, root: &Path) -> Result<Vec<ResearchFile>, String> {
        reject_links(root)?;
        let root = root.canonicalize().map_err(io_error)?;
        let mut entries = Vec::new();
        fn visit(
            files: &ResearchFiles,
            root: &Path,
            dir: &Path,
            depth: usize,
            entries: &mut Vec<ResearchFile>,
        ) -> Result<(), String> {
            if depth > 16 {
                return Ok(());
            }
            for entry in fs::read_dir(dir).map_err(io_error)? {
                let entry = entry.map_err(io_error)?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if matches!(
                    name.as_str(),
                    ".git"
                        | "node_modules"
                        | "target"
                        | "dist"
                        | ".venv"
                        | "__pycache__"
                        | ".scientify"
                ) {
                    continue;
                }
                let path = entry.path();
                if files.internal_path(root, &path) || reject_links(&path).is_err() {
                    continue;
                }
                let meta = fs::symlink_metadata(&path).map_err(io_error)?;
                if !meta.is_dir() && !meta.is_file() {
                    continue;
                }
                if entries.len() >= MAX_ENTRIES {
                    return Err("项目文件超过 10000 项，请选择更具体的项目目录。".into());
                }
                entries.push(ResearchFile {
                    path: portable(path.strip_prefix(root).map_err(io_error)?),
                    name,
                    kind: if meta.is_dir() { "directory" } else { "file" },
                    size: meta.len(),
                });
                if meta.is_dir() {
                    visit(files, root, &path, depth + 1, entries)?;
                }
            }
            Ok(())
        }
        visit(self, &root, &root, 0, &mut entries)?;
        entries.sort_by_key(|a| a.path.to_lowercase());
        Ok(entries)
    }

    pub fn read(&self, root: &Path, path: &str) -> Result<FileContent, String> {
        let real = self.resolve(root, path, false)?;
        let bytes = bounded_read(&real, MAX_TEXT_BYTES)?;
        if bytes.contains(&0) {
            return Err("此文件是二进制文件，不能作为文本编辑。".into());
        }
        let version = version(&bytes);
        let content = String::from_utf8(bytes).map_err(|_| "当前只支持 UTF-8 文本文件。")?;
        Ok(FileContent {
            path: portable(&relative(path)?),
            content,
            version,
        })
    }

    /// Serializes app writes and rejects stale versions; external processes must still be rechecked.
    pub fn write(
        &self,
        root: &Path,
        path: &str,
        content: &str,
        expected: Option<&str>,
    ) -> Result<FileContent, String> {
        if content.len() as u64 > MAX_TEXT_BYTES || content.contains('\0') {
            return Err("正文必须是不超过 2 MiB 的 UTF-8 文本。".into());
        }
        let _guard = self.gate.lock().map_err(io_error)?;
        let real = self.resolve(root, path, true)?;
        let previous = if real.exists() {
            Some(bounded_read(&real, MAX_TEXT_BYTES)?)
        } else {
            None
        };
        match (&previous, expected) {
            (Some(bytes), Some(want)) if version(bytes) == want => (),
            (None, None) => (),
            _ => {
                return Err(
                    "文件已被其他操作修改或同名文件已存在。请重新读取后再保存，当前草稿仍可保留。"
                        .into(),
                )
            }
        }
        if let Some(bytes) = &previous {
            let recovery = self.data_directory.join("recovery").join("files");
            reject_links(&recovery)?;
            fs::create_dir_all(&recovery).map_err(io_error)?;
            let backup = recovery.join(format!(
                "{}.bak",
                version(real.to_string_lossy().as_bytes())
            ));
            reject_links(&backup)?;
            AtomicFile::new(&backup, AllowOverwrite)
                .write(|file| {
                    file.write_all(bytes)?;
                    file.sync_all()
                })
                .map_err(io_error)?;
        }
        reject_links(&real)?;
        // Minimize the external-editor race immediately before the atomic replace.
        if let Some(want) = expected {
            if version(&bounded_read(&real, MAX_TEXT_BYTES)?) != want {
                return Err("保存前检测到外部修改，请重新读取。".into());
            }
        }
        let behavior = if expected.is_some() {
            AllowOverwrite
        } else {
            DisallowOverwrite
        };
        AtomicFile::new(&real, behavior)
            .write(|file| {
                file.write_all(content.as_bytes())?;
                file.sync_all()
            })
            .map_err(io_error)?;
        Ok(FileContent {
            path: portable(&relative(path)?),
            content: content.into(),
            version: version(content.as_bytes()),
        })
    }

    pub fn import_pdf(&self, source: &Path) -> Result<ImportedPdf, String> {
        let bytes = bounded_read(source, MAX_PDF_BYTES)?;
        if !bytes[..bytes.len().min(1024)]
            .windows(5)
            .any(|v| v == b"%PDF-")
        {
            return Err("选择的文件不是有效的 PDF 文件。".into());
        }
        let asset_id = Uuid::new_v4().to_string();
        let directory = self.data_directory.join("assets").join("pdf");
        reject_links(&directory)?;
        fs::create_dir_all(&directory).map_err(io_error)?;
        let path = directory.join(format!("{asset_id}.pdf"));
        AtomicFile::new(&path, DisallowOverwrite)
            .write(|file| {
                file.write_all(&bytes)?;
                file.sync_all()
            })
            .map_err(io_error)?;
        Ok(ImportedPdf {
            asset_id,
            file_name: source
                .file_name()
                .ok_or("文件名称无效。")?
                .to_string_lossy()
                .into_owned(),
            size: bytes.len() as u64,
        })
    }

    pub fn read_pdf(&self, asset_id: &str) -> Result<Vec<u8>, String> {
        let id = Uuid::parse_str(asset_id).map_err(|_| "PDF 资产标识无效。")?;
        if id.to_string() != asset_id {
            return Err("PDF 资产标识无效。".into());
        }
        bounded_read(
            &self
                .data_directory
                .join("assets")
                .join("pdf")
                .join(format!("{id}.pdf")),
            MAX_PDF_BYTES,
        )
    }
}
