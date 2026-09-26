//! Authorized local literature roots. All mutations share one queue and fail closed.
use crate::research::reject_links;
use atomicwrites::{AllowOverwrite, AtomicFile, DisallowOverwrite};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Mutex,
};
use uuid::Uuid;

pub const PDF_LIMIT: u64 = 150 * 1024 * 1024;
const NOTE_LIMIT: u64 = 2 * 1024 * 1024;
type Result<T> = std::result::Result<T, String>;
fn err(e: impl std::fmt::Display) -> String {
    format!("文献文件操作失败：{e}")
}
fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn portable(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}
fn id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|v| v.is_ascii_alphanumeric() || v == b'-' || v == b'_')
}
fn relative(path: &str, root: bool) -> Result<PathBuf> {
    if root && path.is_empty() {
        return Ok(PathBuf::new());
    }
    if path.is_empty() || path.len() > 2048 || path.split('/').count() > 32 || path.contains('\\') {
        return Err("文献路径无效。".into());
    }
    for part in path.split('/') {
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        if part.is_empty()
            || matches!(part, "." | "..")
            || part.eq_ignore_ascii_case(".scientify")
            || part.eq_ignore_ascii_case(".git")
            || part.ends_with([' ', '.'])
            || part
                .chars()
                .any(|c| c.is_control() || "<>:\"|?*".contains(c))
            || matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || ((base.starts_with("COM") || base.starts_with("LPT"))
                && base.len() == 4
                && matches!(base.as_bytes()[3], b'1'..=b'9'))
        {
            return Err("文件名包含保留名称或越界片段。".into());
        }
    }
    Ok(PathBuf::from(path))
}
fn bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    reject_links(path)?;
    let file = File::open(path).map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    if !meta.is_file() || meta.len() > limit {
        return Err("文件类型或大小超出限制。".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes).map_err(err)?;
    if bytes.len() as u64 > limit {
        return Err("读取时文件超过大小限制。".into());
    }
    Ok(bytes)
}
fn pdf_hash(path: &Path) -> Result<String> {
    reject_links(path)?;
    let mut file = File::open(path).map_err(err)?;
    let meta = file.metadata().map_err(err)?;
    if !meta.is_file() || meta.len() > PDF_LIMIT {
        return Err("文件类型或大小超出限制。".into());
    }
    let mut header = [0u8; 1024];
    let count = file.read(&mut header).map_err(err)?;
    if !header[..count].windows(5).any(|v| v == b"%PDF-") {
        return Err("不是有效的 PDF 文件。".into());
    }
    let mut hash = Sha256::new();
    hash.update(&header[..count]);
    let mut buffer = [0u8; 65536];
    let mut size = count as u64;
    loop {
        let n = file.read(&mut buffer).map_err(err)?;
        if n == 0 {
            break;
        }
        size += n as u64;
        if size > PDF_LIMIT {
            return Err("读取时文件超过大小限制。".into());
        }
        hash.update(&buffer[..n]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn write_atomic(path: &Path, bytes: &[u8], overwrite: bool) -> Result<()> {
    reject_links(path)?;
    AtomicFile::new(
        path,
        if overwrite {
            AllowOverwrite
        } else {
            DisallowOverwrite
        },
    )
    .write(|f| {
        f.write_all(bytes)?;
        f.sync_all()
    })
    .map_err(err)
}
fn sidecar(path: &str) -> String {
    format!("{}.notes.md", &path[..path.len() - 4])
}
fn below(path: &str, parent: &str) -> bool {
    path == parent || path.starts_with(&format!("{parent}/"))
}
fn remap(path: &str, from: &str, to: &str) -> String {
    if path == from {
        to.to_string()
    } else {
        format!("{to}{}", &path[from.len()..])
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Binding {
    pub id: String,
    pub path: String,
    pub note_path: String,
    pub fingerprint: String,
}
#[derive(Clone, Serialize, Deserialize)]
struct Index {
    version: u32,
    papers: Vec<Binding>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub path: String,
    pub name: String,
    pub directory: bool,
    pub pdf: bool,
    pub note: bool,
    pub size: u64,
    pub paper_id: Option<String>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Scan {
    pub root: Option<String>,
    pub entries: Vec<Entry>,
    pub papers: Vec<Binding>,
    pub warnings: Vec<String>,
}
#[derive(Serialize)]
pub struct Note {
    pub content: String,
    pub revision: Option<String>,
}
#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Operation {
    Scan,
    Detach,
    Open {
        path: String,
    },
    Mkdir {
        path: String,
    },
    Transfer {
        path: String,
        destination: String,
        copy: bool,
    },
    Delete {
        path: String,
    },
    Relink {
        id: String,
        path: String,
    },
}
pub struct LocalLibrary {
    data: PathBuf,
    gate: Mutex<()>,
    fingerprints: Mutex<BTreeMap<PathBuf, (u64, std::time::SystemTime, String)>>,
}
impl LocalLibrary {
    pub fn new(data: PathBuf) -> Self {
        Self {
            data,
            gate: Mutex::new(()),
            fingerprints: Mutex::new(BTreeMap::new()),
        }
    }
    fn fingerprint(&self, path: &Path) -> Result<String> {
        reject_links(path)?;
        let meta = fs::metadata(path).map_err(err)?;
        let stamp = meta.modified().map_err(err)?;
        if let Some((size, time, hash)) = self.fingerprints.lock().map_err(err)?.get(path) {
            if *size == meta.len() && *time == stamp {
                return Ok(hash.clone());
            }
        }
        let hash = pdf_hash(path)?;
        let after = fs::metadata(path).map_err(err)?;
        if after.len() != meta.len() || after.modified().map_err(err)? != stamp {
            return Err("PDF 在读取时发生变化，请重试。".into());
        }
        self.fingerprints
            .lock()
            .map_err(err)?
            .insert(path.to_path_buf(), (meta.len(), stamp, hash.clone()));
        Ok(hash)
    }
    pub fn invalidate_fingerprints(&self, paths: &[PathBuf]) {
        if paths
            .iter()
            .any(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("pdf")))
        {
            if let Ok(mut cache) = self.fingerprints.lock() {
                cache.clear();
            }
        }
    }
    fn roots(&self) -> Result<BTreeMap<String, String>> {
        let p = self.data.join("literature-roots.json");
        reject_links(&p)?;
        if !p.exists() {
            return Ok(BTreeMap::new());
        }
        let roots: BTreeMap<String, String> = serde_json::from_slice(&bounded(&p, NOTE_LIMIT)?)
            .map_err(|_| "文献根目录映射损坏，已停止修改。")?;
        if roots
            .iter()
            .any(|(id, root)| !id_valid(id) || !Path::new(root).is_absolute())
        {
            return Err("文献根目录映射无效。".into());
        }
        Ok(roots)
    }
    pub fn root(&self, project: &str) -> Result<Option<PathBuf>> {
        if !id_valid(project) {
            return Err("项目标识无效。".into());
        }
        self.roots()?
            .get(project)
            .map(|p| self.check_root(Path::new(p)))
            .transpose()
    }
    fn check_root(&self, root: &Path) -> Result<PathBuf> {
        if !root.is_absolute() {
            return Err("文献根目录必须为绝对路径。".into());
        }
        reject_links(root)?;
        let real = root.canonicalize().map_err(err)?;
        if !real.is_dir() {
            return Err("文献根目录不是文件夹。".into());
        }
        if self
            .data
            .canonicalize()
            .is_ok_and(|data| real.starts_with(&data) || data.starts_with(&real))
        {
            return Err("请选择 Scientify 数据目录之外的独立文献文件夹。".into());
        }
        Ok(real)
    }
    fn resolve(&self, root: &Path, path: &str, allow_root: bool) -> Result<PathBuf> {
        reject_links(root)?;
        let file = root.join(relative(path, allow_root)?);
        reject_links(&file)?;
        if let Some(existing) = file.ancestors().find(|p| p.exists()) {
            if !existing.canonicalize().map_err(err)?.starts_with(root) {
                return Err("文件不在文献目录内。".into());
            }
        }
        Ok(file)
    }
    fn index(&self, root: &Path) -> Result<Index> {
        let file = root.join(".scientify/library.json");
        reject_links(&file)?;
        if root.join(".scientify/operation.json").exists() {
            return Err(
                "上次文件操作未完成，请保留 .scientify/operation.json 并恢复文件后再操作。".into(),
            );
        }
        if !file.exists() {
            return Ok(Index {
                version: 1,
                papers: vec![],
            });
        }
        let index: Index = serde_json::from_slice(&bounded(&file, 8 * 1024 * 1024)?)
            .map_err(|_| "文献索引损坏，已停止写入。")?;
        let (mut ids, mut paths, mut notes) = (HashSet::new(), HashSet::new(), HashSet::new());
        if index.version != 1 || index.papers.len() > 10000 {
            return Err("文献索引版本或数量无效。".into());
        }
        for p in &index.papers {
            self.resolve(root, &p.path, false)?;
            self.resolve(root, &p.note_path, false)?;
            if !id_valid(&p.id)
                || !p.path.to_lowercase().ends_with(".pdf")
                || !p.note_path.to_lowercase().ends_with(".md")
                || !ids.insert(&p.id)
                || !paths.insert(p.path.to_lowercase())
                || !notes.insert(p.note_path.to_lowercase())
            {
                return Err("文献索引包含无效或重复绑定。".into());
            }
        }
        Ok(index)
    }
    fn write_index(&self, root: &Path, index: &Index) -> Result<()> {
        let meta = root.join(".scientify");
        reject_links(&meta)?;
        fs::create_dir_all(&meta).map_err(err)?;
        write_atomic(
            &meta.join("library.json"),
            &serde_json::to_vec_pretty(index).map_err(err)?,
            true,
        )
    }
    pub fn mount(&self, project: &str, root: &Path) -> Result<Scan> {
        let _guard = self.gate.lock().map_err(err)?;
        if !id_valid(project) {
            return Err("项目标识无效。".into());
        }
        let root = self.check_root(root)?;
        let index = self.index(&root)?;
        self.write_index(&root, &index)?;
        let scanned = self.scan_inner(&root)?;
        let mut roots = self.roots()?;
        roots.insert(project.into(), root.to_string_lossy().into_owned());
        reject_links(&self.data)?;
        fs::create_dir_all(&self.data).map_err(err)?;
        write_atomic(
            &self.data.join("literature-roots.json"),
            &serde_json::to_vec_pretty(&roots).map_err(err)?,
            true,
        )?;
        Ok(scanned)
    }
    fn walk(&self, root: &Path) -> Result<Vec<Entry>> {
        fn visit(
            lib: &LocalLibrary,
            root: &Path,
            dir: &Path,
            depth: usize,
            result: &mut Vec<Entry>,
        ) -> Result<()> {
            if depth > 32 {
                return Err("文献目录超过 32 层。".into());
            }
            reject_links(dir)?;
            for item in fs::read_dir(dir).map_err(err)? {
                let item = item.map_err(err)?;
                let path = item.path();
                let name = item.file_name().to_string_lossy().into_owned();
                if name.eq_ignore_ascii_case(".scientify")
                    || name.eq_ignore_ascii_case(".git")
                    || name.starts_with(".atomicwrite")
                    || reject_links(&path).is_err()
                {
                    continue;
                }
                let meta = fs::symlink_metadata(&path).map_err(err)?;
                if !meta.is_dir() && !meta.is_file() {
                    continue;
                }
                let rel = portable(path.strip_prefix(root).map_err(err)?);
                lib.resolve(root, &rel, false)?;
                result.push(Entry {
                    path: rel,
                    name: name.clone(),
                    directory: meta.is_dir(),
                    pdf: name.to_lowercase().ends_with(".pdf"),
                    note: name.to_lowercase().ends_with(".notes.md"),
                    size: meta.len(),
                    paper_id: None,
                });
                if result.len() > 10000 {
                    return Err("文献目录超过 10000 项，请缩小范围。".into());
                }
                if meta.is_dir() {
                    visit(lib, root, &path, depth + 1, result)?;
                }
            }
            Ok(())
        }
        let mut entries = vec![];
        visit(self, root, root, 0, &mut entries)?;
        entries.sort_by_key(|e| e.path.to_lowercase());
        Ok(entries)
    }
    fn scan_inner(&self, root: &Path) -> Result<Scan> {
        let mut index = self.index(root)?;
        let mut entries = self.walk(root)?;
        let mut warnings = vec![];
        let mut changed = false;
        let missing: Vec<_> = index
            .papers
            .iter()
            .filter(|p| !root.join(&p.path).exists())
            .map(|p| p.id.clone())
            .collect();
        let mut candidates: BTreeMap<String, Vec<String>> = BTreeMap::new();
        if !missing.is_empty() {
            for e in entries
                .iter()
                .filter(|e| e.pdf && !index.papers.iter().any(|p| p.path == e.path))
            {
                if let Ok(hash) = self.fingerprint(&root.join(&e.path)) {
                    candidates.entry(hash).or_default().push(e.path.clone());
                }
            }
        }
        for n in 0..index.papers.len() {
            let original = index.papers[n].clone();
            let path = self.resolve(root, &original.path, false)?;
            if path.exists() {
                if let Ok(hash) = self.fingerprint(&path) {
                    if hash != original.fingerprint {
                        warnings.push(format!(
                            "PDF 已被外部替换，原选文位置可能变化：{}",
                            original.path
                        ));
                        index.papers[n].fingerprint = hash;
                        changed = true;
                    }
                }
            } else if let Some(paths) = candidates.get(&original.fingerprint) {
                let same_missing = index
                    .papers
                    .iter()
                    .filter(|p| missing.contains(&p.id) && p.fingerprint == original.fingerprint)
                    .count();
                if paths.len() == 1 && same_missing == 1 {
                    let next = paths[0].clone();
                    let note = sidecar(&next);
                    let old_note = self.resolve(root, &original.note_path, false)?;
                    let new_note = self.resolve(root, &note, false)?;
                    // Never overwrite an existing sidecar after an external rename.
                    if old_note.exists() && old_note != new_note && new_note.exists() {
                        warnings.push(format!(
                            "笔记目标已存在，保留原绑定，请重新关联：{}",
                            original.path
                        ));
                        continue;
                    }
                    let previous = index.clone();
                    index.papers[n].path = next;
                    index.papers[n].note_path = note;
                    let moves = if old_note.exists() && old_note != new_note {
                        vec![(old_note, new_note)]
                    } else {
                        vec![]
                    };
                    self.publish_moves(root, &previous, &index, &moves, false)?;
                    changed = true;
                } else {
                    warnings.push(format!("存在多个相同 PDF，未自动关联：{}", original.path));
                }
            } else {
                warnings.push(format!("PDF 已移除，笔记仍保留：{}", original.path));
            }
        }
        if changed {
            self.write_index(root, &index)?;
            entries = self.walk(root)?;
        }
        for entry in &mut entries {
            entry.paper_id = index
                .papers
                .iter()
                .find(|p| p.path == entry.path)
                .map(|p| p.id.clone());
        }
        Ok(Scan {
            root: Some(root.to_string_lossy().into_owned()),
            entries,
            papers: index.papers,
            warnings,
        })
    }
    fn bind(&self, root: &Path, path: &str, index: &mut Index) -> Result<Binding> {
        if !path.to_lowercase().ends_with(".pdf") {
            return Err("请选择 PDF 文件。".into());
        }
        let full = self.resolve(root, path, false)?;
        let hash = self.fingerprint(&full)?;
        if let Some(p) = index.papers.iter_mut().find(|p| p.path == path) {
            p.fingerprint = hash;
            return Ok(p.clone());
        }
        let note = sidecar(path);
        self.resolve(root, &note, false)?;
        if index
            .papers
            .iter()
            .any(|p| p.note_path.eq_ignore_ascii_case(&note))
        {
            return Err("已有其他文献绑定到该笔记路径。".into());
        }
        let binding = Binding {
            id: Uuid::new_v4().to_string(),
            path: path.into(),
            note_path: note,
            fingerprint: hash,
        };
        index.papers.push(binding.clone());
        Ok(binding)
    }
    pub fn open(&self, project: &str, path: &str) -> Result<Binding> {
        let _g = self.gate.lock().map_err(err)?;
        let root = self.root(project)?.ok_or("请先打开文献文件夹。")?;
        let mut index = self.index(&root)?;
        let result = self.bind(&root, path, &mut index)?;
        self.write_index(&root, &index)?;
        Ok(result)
    }
    pub fn scan(&self, project: &str) -> Result<Scan> {
        let _g = self.gate.lock().map_err(err)?;
        match self.root(project)? {
            Some(root) => self.scan_inner(&root),
            None => Ok(Scan {
                root: None,
                entries: vec![],
                papers: vec![],
                warnings: vec![],
            }),
        }
    }
    pub fn pdf(&self, project: &str, id: &str) -> Result<Vec<u8>> {
        let _g = self.gate.lock().map_err(err)?;
        let root = self.root(project)?.ok_or("请先打开文献文件夹。")?;
        let index = self.index(&root)?;
        let binding = index
            .papers
            .iter()
            .find(|p| p.id == id)
            .ok_or("文献绑定不存在。")?;
        let bytes = bounded(&self.resolve(&root, &binding.path, false)?, PDF_LIMIT)?;
        if !bytes[..bytes.len().min(1024)]
            .windows(5)
            .any(|v| v == b"%PDF-")
        {
            return Err("不是有效的 PDF 文件。".into());
        }
        Ok(bytes)
    }
    pub fn note(&self, project: &str, id: &str) -> Result<Note> {
        let _g = self.gate.lock().map_err(err)?;
        let root = self.root(project)?.ok_or("请先打开文献文件夹。")?;
        let index = self.index(&root)?;
        let binding = index
            .papers
            .iter()
            .find(|p| p.id == id)
            .ok_or("文献绑定不存在。")?;
        self.read_note(&self.resolve(&root, &binding.note_path, false)?)
    }
    fn read_note(&self, path: &Path) -> Result<Note> {
        if !path.exists() {
            return Ok(Note {
                content: String::new(),
                revision: None,
            });
        }
        let bytes = bounded(path, NOTE_LIMIT)?;
        let revision = Some(digest(&bytes));
        let content = String::from_utf8(bytes).map_err(|_| "笔记必须是 UTF-8 文本。")?;
        Ok(Note { content, revision })
    }
    pub fn save_note(
        &self,
        project: &str,
        id: &str,
        content: &str,
        revision: Option<&str>,
        copy: Option<&str>,
    ) -> Result<Note> {
        let _g = self.gate.lock().map_err(err)?;
        if content.len() as u64 > NOTE_LIMIT || content.contains('\0') {
            return Err("笔记应为不超过 2 MiB 的 UTF-8 文本。".into());
        }
        let root = self.root(project)?.ok_or("请先打开文献文件夹。")?;
        let index = self.index(&root)?;
        let binding = index
            .papers
            .iter()
            .find(|p| p.id == id)
            .ok_or("文献绑定不存在。")?;
        let path = self.resolve(&root, copy.unwrap_or(&binding.note_path), false)?;
        if copy.is_some() && (!portable(&path).to_lowercase().ends_with(".md") || path.exists()) {
            return Err("副本必须为尚不存在的 Markdown 文件。".into());
        }
        let current = self.read_note(&path)?;
        if copy.is_none() && current.revision.as_deref() != revision {
            return Err("笔记已被外部修改，当前草稿已保留。请重载或另存副本。".into());
        }
        if current.revision.is_none() && content.is_empty() {
            return Ok(current);
        }
        write_atomic(&path, content.as_bytes(), current.revision.is_some())?;
        Ok(Note {
            content: content.into(),
            revision: Some(digest(content.as_bytes())),
        })
    }
    fn publish_moves(
        &self,
        root: &Path,
        previous: &Index,
        next: &Index,
        plans: &[(PathBuf, PathBuf)],
        copy: bool,
    ) -> Result<()> {
        for (src, dst) in plans {
            validate_tree(src)?;
            reject_links(dst)?;
            if dst.exists() {
                return Err("同名目标已存在，不会覆盖。".into());
            }
            if !dst.parent().is_some_and(Path::is_dir)
                && !plans.iter().any(|(source, target)| {
                    source.is_dir() && dst.parent().is_some_and(|p| p.starts_with(target))
                })
            {
                return Err("目标文件夹不存在。".into());
            }
        }
        let marker = root.join(".scientify/operation.json");
        let mut paths = HashSet::new();
        let mut notes = HashSet::new();
        for p in &next.papers {
            if !paths.insert(p.path.to_lowercase()) || !notes.insert(p.note_path.to_lowercase()) {
                return Err("目标路径已存在文献绑定，请先重新关联缺失文献。".into());
            }
        }
        write_atomic(
            &marker,
            &serde_json::to_vec(
                &serde_json::json!({"copy":copy,"paths":plans,"before":previous,"after":next}),
            )
            .map_err(err)?,
            false,
        )?;
        let mut done = vec![];
        let result = (|| {
            for (src, dst) in plans {
                if copy {
                    copy_tree(src, dst)?;
                } else {
                    move_new(src, dst)?;
                }
                done.push((src.clone(), dst.clone()));
            }
            self.write_index(root, next)
        })();
        if result.is_err() {
            let mut failures = vec![];
            for (src, dst) in done.iter().rev() {
                let r = if copy {
                    remove_owned(dst)
                } else {
                    move_new(dst, src)
                };
                if let Err(e) = r {
                    failures.push(e);
                }
            }
            if !failures.is_empty() {
                return Err(format!(
                    "操作失败且回退未完成；请保留恢复清单：{}",
                    marker.display()
                ));
            }
        }
        fs::remove_file(marker).map_err(err)?;
        result
    }
    pub fn operate(&self, project: &str, op: Operation) -> Result<Scan> {
        if matches!(op, Operation::Scan) {
            return self.scan(project);
        }
        if let Operation::Open { path } = op {
            self.open(project, &path)?;
            return self.scan(project);
        }
        let _g = self.gate.lock().map_err(err)?;
        if matches!(op, Operation::Detach) {
            let mut roots = self.roots()?;
            roots.remove(project);
            write_atomic(
                &self.data.join("literature-roots.json"),
                &serde_json::to_vec_pretty(&roots).map_err(err)?,
                true,
            )?;
            return Ok(Scan {
                root: None,
                entries: vec![],
                papers: vec![],
                warnings: vec![],
            });
        }
        let root = self.root(project)?.ok_or("请先打开文献文件夹。")?;
        self.scan_inner(&root)?;
        let mut index = self.index(&root)?;
        match op {
            Operation::Mkdir { path } => {
                let file = self.resolve(&root, &path, false)?;
                fs::create_dir(file).map_err(err)?;
            }
            Operation::Relink { id, path } => {
                let file = self.resolve(&root, &path, false)?;
                let hash = self.fingerprint(&file)?;
                if index
                    .papers
                    .iter()
                    .any(|p| p.id != id && p.path.eq_ignore_ascii_case(&path))
                {
                    return Err("目标 PDF 已绑定其他笔记。".into());
                }
                let p = index
                    .papers
                    .iter_mut()
                    .find(|p| p.id == id)
                    .ok_or("原文献绑定不存在。")?;
                p.path = path;
                p.fingerprint = hash;
                self.write_index(&root, &index)?;
            }
            Operation::Transfer {
                path,
                destination,
                copy,
            } => {
                let src = self.resolve(&root, &path, false)?;
                let dst = self.resolve(&root, &destination, false)?;
                if src.is_file() && destination.to_lowercase().ends_with(".notes.md") {
                    return Err("不能将普通文件改名为关联笔记。".into());
                }
                if path.eq_ignore_ascii_case(&destination)
                    || below(&destination.to_lowercase(), &path.to_lowercase())
                {
                    return Err("不能移动到自身、子目录或仅修改大小写。".into());
                }
                if !src.is_dir()
                    && path.to_lowercase().ends_with(".pdf")
                    && !destination.to_lowercase().ends_with(".pdf")
                {
                    return Err("PDF 文件必须保留 .pdf 扩展名。".into());
                }
                let entries = self.walk(&root)?;
                for entry in entries.iter().filter(|e| e.pdf && below(&e.path, &path)) {
                    self.bind(&root, &entry.path, &mut index)?;
                }
                self.write_index(&root, &index)?;
                let previous = index.clone();
                let mut next = index.clone();
                let mut plans = vec![(src, dst)];
                for p in next
                    .papers
                    .iter_mut()
                    .filter(|p| !below(&p.path, &path) && below(&p.note_path, &path))
                {
                    if copy {
                        continue;
                    }
                    p.note_path = remap(&p.note_path, &path, &destination);
                }
                // Raw sidecar moves are not allowed to silently break an indexed pair.
                if index.papers.iter().any(|p| p.note_path == path) {
                    return Err("请通过对应 PDF 操作关联笔记。".into());
                }
                for binding in index.papers.iter().filter(|p| below(&p.path, &path)) {
                    let new_path = remap(&binding.path, &path, &destination);
                    let new_note = sidecar(&new_path);
                    let old_note = self.resolve(&root, &binding.note_path, false)?;
                    let note_target = self.resolve(&root, &new_note, false)?;
                    if !below(&binding.note_path, &path) && note_target.exists() {
                        return Err("目标笔记已存在，不会覆盖或重新绑定。".into());
                    }
                    if !below(&binding.note_path, &path) && old_note.exists() {
                        plans.push((old_note, note_target));
                    }
                    let mut p = binding.clone();
                    p.path = new_path;
                    p.note_path = if below(&binding.note_path, &path) {
                        remap(&binding.note_path, &path, &destination)
                    } else {
                        new_note
                    };
                    if copy {
                        p.id = Uuid::new_v4().to_string();
                        next.papers.push(p);
                    } else {
                        let entry = next.papers.iter_mut().find(|b| b.id == p.id).unwrap();
                        *entry = p;
                    }
                }
                self.publish_moves(&root, &previous, &next, &plans, copy)?;
            }
            Operation::Delete { path } => {
                self.delete_inner(&root, &path, &index, |p| trash::delete(p).map_err(err))?;
            }
            _ => return Err("不支持的文献操作。".into()),
        }
        self.scan_inner(&root)
    }
    pub fn delete_with(
        &self,
        project: &str,
        path: &str,
        recycle: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<()> {
        let _g = self.gate.lock().map_err(err)?;
        let root = self.root(project)?.ok_or("请先打开文献文件夹。")?;
        let index = self.index(&root)?;
        self.delete_inner(&root, path, &index, recycle)
    }
    fn delete_inner(
        &self,
        root: &Path,
        path: &str,
        index: &Index,
        recycle: impl FnOnce(&Path) -> Result<()>,
    ) -> Result<()> {
        let src = self.resolve(root, path, false)?;
        if index.papers.iter().any(|p| p.note_path == path) {
            return Err("请通过对应 PDF 操作关联笔记。".into());
        }
        let mut sources = vec![src];
        for p in index
            .papers
            .iter()
            .filter(|p| below(&p.path, path) && !below(&p.note_path, path))
        {
            let note = self.resolve(root, &p.note_path, false)?;
            if note.exists() {
                sources.push(note);
            }
        }
        if sources.len() == 1 && path.to_lowercase().ends_with(".pdf") {
            let note = self.resolve(root, &sidecar(path), false)?;
            if note.exists() {
                sources.push(note);
            }
        }
        // Validate all descendants before moving a folder, including links the tree skips.
        for src in &sources {
            validate_tree(src)?;
        }
        let package = root
            .join(".scientify")
            .join(format!("recycle-{}", Uuid::new_v4()));
        reject_links(&package)?;
        fs::create_dir(&package).map_err(err)?;
        let plans: Vec<_> = sources
            .iter()
            .enumerate()
            .map(|(i, p)| (p.clone(), package.join(i.to_string())))
            .collect();
        write_atomic(
            &package.join("restore.json"),
            &serde_json::to_vec_pretty(&serde_json::json!({"root":root,"paths":plans}))
                .map_err(err)?,
            false,
        )?;
        let mut done = vec![];
        let result = (|| {
            for (src, dst) in &plans {
                move_new(src, dst)?;
                done.push((src, dst));
            }
            recycle(&package)
        })();
        if result.is_err() {
            for (src, dst) in done.iter().rev() {
                if dst.exists() {
                    move_new(dst, src).map_err(|e| {
                        format!("回收失败且回退未完成：{e}；恢复包：{}", package.display())
                    })?;
                }
            }
            remove_owned(&package)?;
        }
        result
    }
    pub fn import_files(
        &self,
        project: &str,
        files: &[(PathBuf, String, Option<String>)],
    ) -> Result<Scan> {
        let _g = self.gate.lock().map_err(err)?;
        let root = self.root(project)?.ok_or("请先打开文献文件夹。")?;
        let previous = self.index(&root)?;
        let mut next = previous.clone();
        let mut created = vec![];
        let result = (|| {
            for (source, name, note) in files {
                let bytes = bounded(source, PDF_LIMIT)?;
                pdf_hash(source)?;
                let mut n = 0;
                let target = loop {
                    let file = if n == 0 {
                        name.clone()
                    } else {
                        format!("{} ({n}).pdf", name.trim_end_matches(".pdf"))
                    };
                    let full = self.resolve(&root, &file, false)?;
                    if !full.exists() && !root.join(sidecar(&file)).exists() {
                        break (file, full);
                    }
                    n += 1;
                };
                write_atomic(&target.1, &bytes, false)?;
                created.push(target.1);
                let binding = self.bind(&root, &target.0, &mut next)?;
                if let Some(note) = note.as_ref().filter(|s| !s.is_empty()) {
                    let p = self.resolve(&root, &binding.note_path, false)?;
                    write_atomic(&p, note.as_bytes(), false)?;
                    created.push(p);
                }
            }
            self.write_index(&root, &next)
        })();
        if result.is_err() {
            for p in created.iter().rev() {
                fs::remove_file(p).map_err(err)?;
            }
        }
        result?;
        self.scan_inner(&root)
    }
    pub fn external_path(&self, project: &str, path: &str) -> Result<PathBuf> {
        let root = self.root(project)?.ok_or("请先打开文献文件夹。")?;
        self.resolve(&root, path, true)
    }
}
fn validate_tree(path: &Path) -> Result<()> {
    reject_links(path)?;
    if path.is_dir() {
        for e in fs::read_dir(path).map_err(err)? {
            let e = e.map_err(err)?;
            if e.file_name()
                .to_string_lossy()
                .eq_ignore_ascii_case(".scientify")
            {
                return Err("文件夹包含内部元数据，不支持移动或复制。".into());
            }
            validate_tree(&e.path())?;
        }
    } else if !path.is_file() {
        return Err("不支持特殊文件。".into());
    }
    Ok(())
}
fn copy_tree(src: &Path, dst: &Path) -> Result<()> {
    validate_tree(src)?;
    if src.is_dir() {
        fs::create_dir(dst).map_err(err)?;
        let result = (|| {
            for entry in fs::read_dir(src).map_err(err)? {
                let entry = entry.map_err(err)?;
                copy_tree(&entry.path(), &dst.join(entry.file_name()))?;
            }
            Ok(())
        })();
        if result.is_err() {
            remove_owned(dst)?;
        }
        result
    } else {
        let mut source = File::open(src).map_err(err)?;
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(dst)
            .map_err(err)?;
        let result = std::io::copy(&mut source, &mut target)
            .and_then(|_| target.sync_all())
            .map_err(err);
        if result.is_err() {
            drop(target);
            fs::remove_file(dst).map_err(err)?;
        }
        result
    }
}
fn remove_owned(path: &Path) -> Result<()> {
    reject_links(path)?;
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(err)
    } else {
        fs::remove_file(path).map_err(err)
    }
}
fn move_new(source: &Path, destination: &Path) -> Result<()> {
    reject_links(source)?;
    reject_links(destination)?;
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        let from: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let to: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        let result = unsafe {
            windows_sys::Win32::Storage::FileSystem::MoveFileExW(from.as_ptr(), to.as_ptr(), 0)
        };
        if result == 0 {
            return Err(err(std::io::Error::last_os_error()));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        if destination.exists() {
            return Err("同名目标已存在，不会覆盖。".into());
        }
        fs::rename(source, destination).map_err(err)
    }
}
