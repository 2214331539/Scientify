//! Standard Git semantics over a validated project/worktree root.
use crate::{code, research, AppState};
use scientify_core::{
    research::{reject_links, ResearchFiles},
    storage::Storage,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
};
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub root: String,
    pub branch: Option<String>,
    pub head: String,
    pub locked: bool,
    pub missing: bool,
    pub busy: bool,
    pub changes: Option<usize>,
}
#[derive(Serialize)]
pub struct Commit {
    pub sha: String,
    pub subject: String,
    pub author: String,
    pub time: String,
}
#[derive(Serialize)]
pub struct Branch {
    pub name: String,
    pub current: bool,
}
#[derive(Serialize)]
pub struct Stash {
    pub id: String,
    pub sha: String,
    pub subject: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub root: String,
    pub repository: bool,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub changes: Vec<research::GitChange>,
    pub branches: Vec<Branch>,
    pub history: Vec<Commit>,
    pub stashes: Vec<Stash>,
    pub worktrees: Vec<Worktree>,
    pub busy: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Action {
    pub kind: String,
    pub path: Option<String>,
    pub name: Option<String>,
    pub message: Option<String>,
    pub revision: Option<String>,
    pub target: Option<String>,
    pub include_untracked: Option<bool>,
    /// A SHA identifies the stash even if another window changes its numeric index.
    pub expected_sha: Option<String>,
    pub expected_diff: Option<String>,
}
fn output(root: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = research::git_command(root)?;
    command.env("GIT_LITERAL_PATHSPECS", "1").args(args);
    let (status, bytes, error) = research::bounded_git_full(command)?;
    if !status.success() {
        return Err(format!("Git: {}", String::from_utf8_lossy(&error).trim()));
    }
    String::from_utf8(bytes).map_err(|_| "Git 输出不是 UTF-8。".into())
}
pub(crate) fn repository_root(root: &Path) -> Result<PathBuf, String> {
    reject_links(root)?;
    let start = root.canonicalize().map_err(|e| e.to_string())?;
    let ancestor = start
        .ancestors()
        .find(|dir| dir.join(".git").exists())
        .ok_or("此目录尚未初始化 Git。")?;
    reject_links(&ancestor.join(".git"))?;
    let top = output(ancestor, &["rev-parse", "--show-toplevel"])?;
    let top = PathBuf::from(top.trim())
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if !start.starts_with(&top) {
        return Err("Git 工作目录不属于所选目录。".into());
    }
    reject_links(&top)?;
    Ok(top)
}
fn canonical(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() || value.contains('\0') {
        return Err("worktree 必须使用绝对路径。".into());
    }
    reject_links(&path)?;
    path.canonicalize()
        .map_err(|_| "worktree 目录不存在，请刷新。".into())
}
fn future_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("worktree 必须使用绝对路径。".into());
    }
    reject_links(path)?;
    let ancestor = path
        .ancestors()
        .find(|p| p.exists())
        .ok_or("目标目录的父目录不存在。")?;
    Ok(ancestor
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(path.strip_prefix(ancestor).map_err(|e| e.to_string())?))
}
pub(crate) fn protect_internal_data(storage: &Storage, path: &Path) -> Result<(), String> {
    let data = storage
        .directory()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let container = if data.file_name().is_some_and(|n| n == "workspace") {
        data.parent().unwrap_or(&data)
    } else {
        &data
    };
    let projects = data.join("projects");
    if container.starts_with(path)
        || (path.starts_with(container) && !(path.starts_with(&projects) && path != projects))
    {
        return Err("worktree 不能访问 Scientify 的内部数据、凭据或浏览缓存目录。".into());
    }
    Ok(())
}
pub(crate) fn repository_for(storage: &Storage, root: &Path) -> Result<PathBuf, String> {
    let repo = repository_root(root)?;
    let data = storage
        .directory()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    if root.starts_with(data) && repo != root {
        return Err("托管代码目录尚未初始化 Git，不能使用安装目录的父仓库。".into());
    }
    Ok(repo)
}
pub(crate) fn inspect_project(storage: &Storage, root: &Path) -> Result<Snapshot, String> {
    let data = storage
        .directory()
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let mut snapshot = inspect_with(root, !root.starts_with(data))?;
    if Path::new(&snapshot.root) != root {
        snapshot.root = root.display().to_string();
        snapshot.changes.clear();
        snapshot.error = Some(
            "所选实验目录位于 Git 仓库内部；请在实验管理中关联仓库根目录来操作完整仓库。".into(),
        );
    }
    Ok(snapshot)
}
fn read_project(storage: &Storage, root: &Path) -> Result<Snapshot, String> {
    match inspect_project(storage, root) {
        Ok(snapshot) => Ok(snapshot),
        Err(error) => {
            // The directory was already validated by resolve. A Git failure
            // must not prevent editing or running its ordinary files.
            let data = storage
                .directory()
                .canonicalize()
                .map_err(|e| e.to_string())?;
            let repository = root.join(".git").exists()
                || (!root.starts_with(data) && root.ancestors().any(|p| p.join(".git").exists()));
            let mut snapshot = empty_snapshot(root, repository);
            snapshot.error = Some(error);
            Ok(snapshot)
        }
    }
}
pub(crate) fn worktrees(root: &Path) -> Result<Vec<Worktree>, String> {
    let text = output(root, &["worktree", "list", "--porcelain", "-z"])?;
    let mut result = Vec::new();
    let mut current: Option<Worktree> = None;
    for field in text.split('\0') {
        if let Some(path) = field.strip_prefix("worktree ") {
            if let Some(tree) = current.take() {
                result.push(tree);
            }
            let resolved = canonical(path).ok();
            current = Some(Worktree {
                root: resolved
                    .as_ref()
                    .map_or_else(|| path.into(), |p| p.display().to_string()),
                branch: None,
                head: String::new(),
                locked: false,
                missing: resolved.is_none(),
                busy: resolved.as_ref().is_some_and(|p| code::busy(p)),
                changes: None,
            });
        } else if let Some(tree) = current.as_mut() {
            if let Some(head) = field.strip_prefix("HEAD ") {
                tree.head = head.into();
            }
            if let Some(branch) = field.strip_prefix("branch refs/heads/") {
                tree.branch = Some(branch.into());
            }
            if field.starts_with("locked") {
                tree.locked = true;
            }
        }
    }
    if let Some(tree) = current {
        result.push(tree);
    }
    Ok(result)
}
pub(crate) fn resolve(
    storage: &Storage,
    files: &ResearchFiles,
    project: &str,
    selected: Option<&str>,
) -> Result<PathBuf, String> {
    if let Some(selected) = selected {
        let requested = canonical(selected)?;
        protect_internal_data(storage, &requested)?;
        let data = storage.load()?.ok_or("项目不存在。")?;
        for experiment in data["experiments"].as_array().ok_or("实验列表无效。")? {
            if experiment["project"] == project {
                let root = crate::experiments::catalog::root_of(storage, files, &data, experiment);
                if root.as_ref().is_ok_and(|root| *root == requested) {
                    return if experiment["archived"] == true {
                        Err("此实验已归档，请恢复后再执行。".into())
                    } else {
                        Ok(requested)
                    };
                }
            }
        }
        for experiment in data["experiments"].as_array().unwrap() {
            if experiment["project"] == project && experiment["archived"] != true {
                if let Ok(root) =
                    crate::experiments::catalog::root_of(storage, files, &data, experiment)
                {
                    if let Ok(repo) = repository_for(storage, &root) {
                        if worktrees(&repo)?
                            .iter()
                            .any(|tree| !tree.missing && Path::new(&tree.root) == requested)
                        {
                            return Ok(requested);
                        }
                    }
                }
            }
        }
    }
    let base = research::project_root(storage, files, project)?;
    reject_links(&base)?;
    let base = base.canonicalize().map_err(|e| e.to_string())?;
    protect_internal_data(storage, &base)?;
    let Some(selected) = selected else {
        return Ok(base);
    };
    let requested = canonical(selected)?;
    protect_internal_data(storage, &requested)?;
    if requested == base {
        return Ok(requested);
    }
    let repo = repository_for(storage, &base)?;
    if worktrees(&repo)?
        .iter()
        .any(|tree| !tree.missing && Path::new(&tree.root) == requested)
    {
        return Ok(requested);
    }
    Err("所选目录不是此项目仓库登记的 worktree，请刷新目录列表。".into())
}
fn text_rows(text: &str, fields: usize) -> Result<Vec<Vec<String>>, String> {
    text.lines()
        .map(|line| {
            let row: Vec<_> = line.split('\0').map(str::to_string).collect();
            if row.len() != fields {
                return Err("Git 记录格式无法识别。".into());
            }
            Ok(row)
        })
        .collect()
}
pub(crate) fn inspect(root: &Path) -> Result<Snapshot, String> {
    inspect_with(root, true)
}
fn empty_snapshot(root: &Path, repository: bool) -> Snapshot {
    Snapshot {
        root: root.display().to_string(),
        repository,
        branch: None,
        head: None,
        changes: vec![],
        branches: vec![],
        history: vec![],
        stashes: vec![],
        worktrees: vec![],
        busy: code::busy(root),
        error: None,
    }
}
fn inspect_with(root: &Path, ancestors: bool) -> Result<Snapshot, String> {
    let repo = if root.join(".git").exists()
        || (ancestors && root.ancestors().any(|dir| dir.join(".git").exists()))
    {
        Some(repository_root(root)?)
    } else {
        None
    };
    let root = repo.as_deref().unwrap_or(root);
    let mut snapshot = empty_snapshot(root, repo.is_some());
    if !snapshot.repository {
        return Ok(snapshot);
    }
    snapshot.head = research::git_head(root).ok();
    snapshot.branch = output(root, &["symbolic-ref", "--quiet", "--short", "HEAD"])
        .ok()
        .map(|s| s.trim().into());
    snapshot.changes = research::git_status(root)?;
    snapshot.branches = output(
        root,
        &["for-each-ref", "--format=%(refname:short)", "refs/heads/"],
    )?
    .lines()
    .map(|name| Branch {
        name: name.into(),
        current: snapshot.branch.as_deref() == Some(name),
    })
    .collect();
    if snapshot.head.is_some() {
        snapshot.history = text_rows(
            &output(root, &["log", "-100", "--format=%H%x00%s%x00%an%x00%aI"])?,
            4,
        )?
        .into_iter()
        .map(|r| Commit {
            sha: r[0].clone(),
            subject: r[1].clone(),
            author: r[2].clone(),
            time: r[3].clone(),
        })
        .collect();
    }
    snapshot.stashes = text_rows(
        &output(root, &["stash", "list", "--format=%gd%x00%H%x00%gs"])?,
        3,
    )?
    .into_iter()
    .map(|r| Stash {
        id: r[0].clone(),
        sha: r[1].clone(),
        subject: r[2].clone(),
    })
    .collect();
    snapshot.worktrees = worktrees(root)?;
    for tree in &mut snapshot.worktrees {
        if !tree.missing {
            tree.changes = research::git_status(Path::new(&tree.root))
                .ok()
                .map(|c| c.len());
        }
    }
    Ok(snapshot)
}
fn file_path(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.contains(['\0', ':', '\\'])
        || value
            .split('/')
            .any(|p| p.is_empty() || p == "." || p == ".." || p.eq_ignore_ascii_case(".git"))
        || Path::new(value)
            .components()
            .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("必须选择仓库内的文件。".into());
    }
    Ok(())
}
fn revision(root: &Path, value: &str) -> Result<String, String> {
    if value.starts_with('-') || value.len() > 256 || value.contains(['\0', '\n']) {
        return Err("Git revision 无效。".into());
    }
    Ok(output(
        root,
        &[
            "rev-parse",
            "--verify",
            "--end-of-options",
            &format!("{value}^{{commit}}"),
        ],
    )?
    .trim()
    .into())
}
fn branch_name(root: &Path, value: &str) -> Result<(), String> {
    if value.starts_with('-') || value.len() > 200 || value.contains(['\0', '\n']) {
        return Err("分支名称无效。".into());
    }
    output(root, &["check-ref-format", "--branch", value])?;
    Ok(())
}
pub(crate) fn diff(
    root: &Path,
    path: &str,
    staged: bool,
    commit: Option<&str>,
) -> Result<String, String> {
    if let Some(commit) = commit {
        let sha = revision(root, commit)?;
        if path.is_empty() {
            return output(
                root,
                &["show", "--format=", "--no-ext-diff", "--no-textconv", &sha],
            );
        }
        file_path(path)?;
        return output(
            root,
            &[
                "show",
                "--format=",
                "--no-ext-diff",
                "--no-textconv",
                &sha,
                "--",
                path,
            ],
        );
    }
    file_path(path)?;
    let changes = research::git_status(root)?;
    let change = changes
        .iter()
        .find(|c| c.path == path)
        .ok_or("文件不在当前更改列表中，请刷新。")?;
    if change.status == "??" {
        if staged {
            return Err("此文件尚未暂存。".into());
        }
        reject_links(&root.join(path))?;
        use std::io::Read;
        let file = std::fs::File::open(root.join(path)).map_err(|e| e.to_string())?;
        if file.metadata().map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
            return Ok("Binary or large untracked file".into());
        }
        let mut data = Vec::new();
        file.take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut data)
            .map_err(|e| e.to_string())?;
        if data.len() > 2 * 1024 * 1024 || data.contains(&0) {
            return Ok("Binary or large untracked file".into());
        }
        let text = String::from_utf8(data).map_err(|_| "文件不是 UTF-8。")?;
        return Ok(format!(
            "@@ -0,0 +1,{} @@\n{}",
            text.lines().count(),
            text.lines()
                .map(|line| format!("+{line}\n"))
                .collect::<String>()
        ));
    }
    let mut args = vec!["diff", "--no-ext-diff", "--no-textconv", "--no-renames"];
    if staged {
        args.push("--cached");
    }
    args.extend(["--", path]);
    output(root, &args)
}
fn repo_lock(root: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let common = output(
        root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let common = canonical(common.trim())?;
    Ok(LOCKS
        .get_or_init(Default::default)
        .lock()
        .map_err(|e| e.to_string())?
        .entry(common)
        .or_default()
        .clone())
}
fn required(value: &Option<String>) -> Result<&str, String> {
    value
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| "Git 操作缺少参数。".into())
}
#[cfg(test)]
fn action(root: &Path, input: &Action) -> Result<String, String> {
    action_for(root, input, false)
}
pub(crate) fn project_action(
    storage: &Storage,
    root: &Path,
    input: &Action,
    agent: bool,
) -> Result<String, String> {
    protect_internal_data(storage, root)?;
    if matches!(input.kind.as_str(), "worktree-add" | "worktree-remove") {
        protect_internal_data(
            storage,
            &future_directory(Path::new(required(&input.target)?))?,
        )?;
    }
    if input.kind == "worktree-remove" {
        let target = canonical(required(&input.target)?)?;
        let data = storage.load()?.ok_or("项目不存在。")?;
        let files = ResearchFiles::new(storage.directory().to_path_buf());
        if data["experiments"].as_array().is_some_and(|items| {
            items.iter().any(|experiment| {
                crate::experiments::catalog::root_of(storage, &files, &data, experiment)
                    .is_ok_and(|root| root == target)
            })
        }) {
            return Err(
                "此 worktree 已登记为实验，请先在实验管理中移除登记，再删除 worktree 目录。".into(),
            );
        }
    }
    action_for(root, input, agent)
}
fn action_for(root: &Path, input: &Action, agent: bool) -> Result<String, String> {
    if input.kind == "init" {
        let _lease = if agent {
            code::Lease::agent_mutation(root)?
        } else {
            code::Lease::mutation(root)?
        };
        if root.join(".git").exists() {
            return Err("此目录已属于 Git 仓库。".into());
        }
        return output(root, &["init"]);
    }
    let repo = repository_root(root)?;
    if repo != root {
        return Err("请先选择 Git 仓库根目录。".into());
    }
    let lock = repo_lock(root)?;
    let _lock = lock.lock().map_err(|e| e.to_string())?;
    let target = if input.kind == "worktree-remove" {
        canonical(required(&input.target)?)?
    } else {
        root.to_path_buf()
    };
    let _lease = if agent && target == root {
        code::Lease::agent_mutation(&target)?
    } else {
        code::Lease::mutation(&target)?
    };
    match input.kind.as_str() {
        "stage" | "unstage" | "restore" => {
            let path = required(&input.path)?;
            file_path(path)?;
            let changes = research::git_status(root)?;
            let change = changes
                .iter()
                .find(|c| c.path == path)
                .ok_or("文件不在当前更改列表中，请刷新。")?;
            if input.kind == "stage" {
                reject_links(&root.join(path))?;
                output(root, &["add", "--", path])
            } else if input.kind == "unstage" {
                if research::git_head(root).is_err() {
                    output(root, &["update-index", "--force-remove", "--", path])
                } else {
                    let mut paths = vec!["restore", "--staged", "--", path];
                    if let Some(old) = change.old_path.as_deref() {
                        file_path(old)?;
                        paths.push(old);
                    }
                    output(root, &paths)
                }
            } else {
                if change.status == "??" || change.status.contains('U') {
                    return Err("未跟踪文件和冲突文件不能直接恢复。".into());
                }
                if input.expected_diff.as_deref() != Some(diff(root, path, false, None)?.as_str()) {
                    return Err("文件差异已变化，请重新检查后再恢复。".into());
                }
                reject_links(&root.join(path))?;
                // Restore only the worktree from its index, retaining staged edits.
                output(root, &["restore", "--worktree", "--", path])
            }
        }
        "commit" => {
            let message = required(&input.message)?;
            if message.len() > 16000 || message.contains('\0') {
                return Err("提交说明过长或无效。".into());
            }
            output(root, &["commit", "-m", message])?;
            research::git_head(root)
        }
        "branch-create" => {
            let name = required(&input.name)?;
            branch_name(root, name)?;
            let sha = revision(root, input.revision.as_deref().unwrap_or("HEAD"))?;
            output(root, &["branch", name, &sha])
        }
        "branch-switch" | "branch-delete" => {
            let name = required(&input.name)?;
            branch_name(root, name)?;
            if input.kind == "branch-switch" {
                output(root, &["switch", "--", name])
            } else {
                output(root, &["branch", "-d", "--", name])
            }
        }
        "stash-save" => {
            let message = input.message.as_deref().unwrap_or("Scientify");
            if message.len() > 4000 || message.contains('\0') {
                return Err("Stash 说明无效。".into());
            }
            let mut args = vec!["stash", "push", "-m", message];
            if input.include_untracked.unwrap_or(false) {
                args.push("--include-untracked");
            }
            output(root, &args)
        }
        "stash-apply" | "stash-pop" => {
            let id = required(&input.name)?;
            let snapshot = inspect(root)?;
            let selected = snapshot
                .stashes
                .iter()
                .find(|s| s.id == id && input.expected_sha.as_deref() == Some(&s.sha))
                .ok_or("Stash 列表已变化，请刷新。")?;
            output(
                root,
                &[
                    "stash",
                    if input.kind == "stash-pop" {
                        "pop"
                    } else {
                        "apply"
                    },
                    &selected.id,
                ],
            )
        }
        "worktree-add" => {
            let value = required(&input.target)?;
            let target = PathBuf::from(value);
            if !target.is_absolute()
                || target.exists()
                || target
                    .components()
                    .any(|c| matches!(c, Component::ParentDir))
            {
                return Err("请选择尚不存在的 worktree 绝对目录。".into());
            }
            let resolved = future_directory(&target)?;
            if worktrees(root)?
                .iter()
                .any(|tree| resolved.starts_with(Path::new(&tree.root)))
            {
                return Err("worktree 目录不能放在已有 worktree 内部。".into());
            }
            let start = input.revision.as_deref().unwrap_or("HEAD");
            if let Some(name) = input.name.as_deref().filter(|n| !n.is_empty()) {
                branch_name(root, name)?;
                let sha = revision(root, start)?;
                output(root, &["worktree", "add", "-b", name, value, &sha])
            } else {
                branch_name(root, start)?;
                output(root, &["worktree", "add", value, start])
            }
        }
        "worktree-remove" => {
            let trees = worktrees(root)?;
            if target == root
                || trees
                    .first()
                    .is_some_and(|tree| Path::new(&tree.root) == target)
                || !trees
                    .iter()
                    .any(|tree| Path::new(&tree.root) == target && !tree.locked)
            {
                return Err("不能移除当前、主仓库或未登记的 worktree。".into());
            }
            if !research::git_status(&target)?.is_empty() {
                return Err("worktree 有未提交更改，请先 commit 或 stash。".into());
            }
            output(root, &["worktree", "remove", required(&input.target)?])
        }
        _ => Err("不支持的 Git 操作。".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(kind: &str) -> Action {
        Action {
            kind: kind.into(),
            path: None,
            name: None,
            message: None,
            revision: None,
            target: None,
            include_untracked: None,
            expected_sha: None,
            expected_diff: None,
        }
    }
    fn fixture() -> tempfile::TempDir {
        let temp = tempfile::tempdir().unwrap();
        output(temp.path(), &["init", "-b", "main"]).unwrap();
        output(temp.path(), &["config", "user.name", "Fixture"]).unwrap();
        output(
            temp.path(),
            &["config", "user.email", "fixture@example.test"],
        )
        .unwrap();
        output(temp.path(), &["config", "core.autocrlf", "false"]).unwrap();
        std::fs::write(temp.path().join("train.py"), "print(1)\n").unwrap();
        output(temp.path(), &["add", "--", "train.py"]).unwrap();
        output(temp.path(), &["commit", "-m", "baseline"]).unwrap();
        temp
    }
    #[test]
    fn index_and_worktree_have_separate_diffs_and_commit_does_not_include_other_files() {
        let repo = fixture();
        let root = repo.path().canonicalize().unwrap();
        std::fs::write(root.join("train.py"), "print(2)\n").unwrap();
        let mut add = request("stage");
        add.path = Some("train.py".into());
        action(&root, &add).unwrap();
        std::fs::write(root.join("train.py"), "print(3)\n").unwrap();
        std::fs::write(root.join("other.py"), "unrelated\n").unwrap();
        let staged = diff(&root, "train.py", true, None).unwrap();
        let unstaged = diff(&root, "train.py", false, None).unwrap();
        assert!(staged.contains("-print(1)"));
        assert!(staged.contains("+print(2)"));
        assert!(unstaged.contains("-print(2)"));
        assert!(unstaged.contains("+print(3)"));
        let mut commit = request("commit");
        commit.message = Some("staged only".into());
        let sha = action(&root, &commit).unwrap();
        assert_eq!(
            output(&root, &["show", &format!("{sha}:train.py")]).unwrap(),
            "print(2)\n"
        );
        assert!(output(&root, &["show", &format!("{sha}:other.py")]).is_err());
        assert_eq!(inspect(&root).unwrap().history[0].subject, "staged only");
        assert!(diff(&root, "", false, Some(&sha))
            .unwrap()
            .contains("train.py"));
    }
    #[test]
    fn rename_unstage_and_unborn_index_do_not_delete_working_files() {
        let repo = fixture();
        let root = repo.path().canonicalize().unwrap();
        output(&root, &["mv", "train.py", "renamed.py"]).unwrap();
        assert_eq!(
            inspect(&root).unwrap().changes[0].old_path.as_deref(),
            Some("train.py")
        );
        let mut unstage = request("unstage");
        unstage.path = Some("renamed.py".into());
        action(&root, &unstage).unwrap();
        assert!(root.join("renamed.py").is_file());
        assert_eq!(output(&root, &["ls-files"]).unwrap().trim(), "train.py");
        let unborn = tempfile::tempdir().unwrap();
        let root = unborn.path().canonicalize().unwrap();
        output(&root, &["init"]).unwrap();
        std::fs::write(root.join("file.txt"), "first").unwrap();
        let mut add = request("stage");
        add.path = Some("file.txt".into());
        action(&root, &add).unwrap();
        std::fs::write(root.join("file.txt"), "second").unwrap();
        unstage.path = Some("file.txt".into());
        action(&root, &unstage).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("file.txt")).unwrap(),
            "second"
        );
        assert!(output(&root, &["ls-files"]).unwrap().is_empty());
    }
    #[test]
    fn worktrees_are_real_git_directories_and_execution_blocks_source_replacement() {
        let repo = fixture();
        let root = repo.path().canonicalize().unwrap();
        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("new loss");
        let mut add = request("worktree-add");
        add.name = Some("feature/new-loss".into());
        add.target = Some(target.display().to_string());
        action(&root, &add).unwrap();
        let target = target.canonicalize().unwrap();
        assert!(target.join(".git").is_file());
        assert_eq!(repository_root(&target).unwrap(), target);
        assert_eq!(
            inspect(&target).unwrap().branch.as_deref(),
            Some("feature/new-loss")
        );
        std::fs::create_dir(target.join("subdir")).unwrap();
        assert_eq!(repository_root(&target.join("subdir")).unwrap(), target);
        let lease = code::Lease::agent(&root).unwrap();
        let mut switch = request("branch-switch");
        switch.name = Some("feature/new-loss".into());
        assert!(action(&root, &switch).is_err());
        std::fs::write(target.join("train.py"), "print(4)\n").unwrap();
        let mut stage = request("stage");
        stage.path = Some("train.py".into());
        action(&target, &stage).unwrap();
        assert!(inspect(&root).unwrap().changes.is_empty());
        let mut remove = request("worktree-remove");
        remove.target = Some(target.display().to_string());
        assert!(action(&root, &remove).is_err());
        drop(lease);
        assert!(action(&root, &switch).unwrap_err().contains("already"));
    }
    #[test]
    fn restore_uses_index_and_rejects_changed_diff_stash_preserves_untracked_by_choice() {
        let repo = fixture();
        let root = repo.path().canonicalize().unwrap();
        std::fs::write(root.join("train.py"), "print(2)\n").unwrap();
        let mut restore = request("restore");
        restore.path = Some("train.py".into());
        restore.expected_diff = Some(diff(&root, "train.py", false, None).unwrap());
        std::fs::write(root.join("train.py"), "print(3)\n").unwrap();
        assert!(action(&root, &restore).is_err());
        restore.expected_diff = Some(diff(&root, "train.py", false, None).unwrap());
        action(&root, &restore).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("train.py")).unwrap(),
            "print(1)\n"
        );
        std::fs::write(root.join("train.py"), "modified\n").unwrap();
        std::fs::write(root.join("new.txt"), "untracked").unwrap();
        let save = request("stash-save");
        action(&root, &save).unwrap();
        assert!(root.join("new.txt").exists());
        let stash = inspect(&root).unwrap().stashes.remove(0);
        let mut apply = request("stash-pop");
        apply.name = Some(stash.id);
        apply.expected_sha = Some("bad-sha".into());
        assert!(action(&root, &apply).is_err());
        apply.expected_sha = Some(stash.sha);
        action(&root, &apply).unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("train.py")).unwrap(),
            "modified\n"
        );
    }
    #[test]
    fn root_resolution_accepts_registered_worktrees_and_rejects_unrelated_roots() {
        let repo = fixture();
        let root = repo.path().canonicalize().unwrap();
        let data = tempfile::tempdir().unwrap();
        let storage = Storage::open(data.path().join("data")).unwrap();
        let files = ResearchFiles::new(storage.directory().to_path_buf());
        let mut workspace = scientify_core::workspace::empty();
        workspace["projects"] = serde_json::json!([{"id":"p1","name":"Fixture","space":"personal","question":"test","createdAt":"2026-10-02","path":root}]);
        workspace["revision"] = serde_json::json!(1);
        storage.save(workspace, 0).unwrap();
        let parent = tempfile::tempdir().unwrap();
        let target = parent.path().join("worktree");
        let mut add = request("worktree-add");
        add.name = Some("feature/isolation".into());
        add.target = Some(target.display().to_string());
        action(&root, &add).unwrap();
        assert_eq!(
            resolve(&storage, &files, "p1", Some(target.to_str().unwrap())).unwrap(),
            target.canonicalize().unwrap()
        );
        assert!(resolve(
            &storage,
            &files,
            "p1",
            Some(parent.path().to_str().unwrap())
        )
        .is_err());
        let mut escape = request("stage");
        escape.path = Some("../outside".into());
        assert!(action(&root, &escape).is_err());
    }
    #[test]
    fn managed_project_never_inherits_the_installation_repository() {
        let parent = fixture();
        let parent_root = parent.path().canonicalize().unwrap();
        let storage = Storage::open(parent_root.join("ScientifyData/workspace")).unwrap();
        let files = ResearchFiles::new(storage.directory().to_path_buf());
        let managed = files.project_root("p1", None).unwrap();
        let mut workspace = scientify_core::workspace::empty();
        workspace["projects"] = serde_json::json!([{"id":"p1","name":"Fixture","space":"personal","question":"test","createdAt":"2026-10-02"}]);
        workspace["revision"] = serde_json::json!(1);
        storage.save(workspace, 0).unwrap();
        assert_eq!(repository_root(&managed).unwrap(), parent_root);
        assert!(repository_for(&storage, &managed).is_err());
        let snapshot = inspect_project(&storage, &managed).unwrap();
        assert!(!snapshot.repository);
        assert_eq!(Path::new(&snapshot.root), managed);
        assert!(resolve(&storage, &files, "p1", Some(parent_root.to_str().unwrap())).is_err());
        let parent_head = research::git_head(&parent_root).unwrap();
        project_action(&storage, &managed, &request("init"), false).unwrap();
        assert!(managed.join(".git").is_dir());
        assert_eq!(repository_for(&storage, &managed).unwrap(), managed);
        assert_eq!(research::git_head(&parent_root).unwrap(), parent_head);
    }
    #[test]
    fn manual_and_agent_worktrees_cannot_be_created_in_private_app_data() {
        let repo = fixture();
        let root = repo.path().canonicalize().unwrap();
        let data = tempfile::tempdir().unwrap();
        let storage = Storage::open(data.path().join("workspace")).unwrap();
        std::fs::create_dir_all(storage.directory()).unwrap();
        let mut add = request("worktree-add");
        add.name = Some("feature/private-data".into());
        for folder in [
            "workspace/agent/code/unsafe",
            "browser-profile/unsafe",
            "workspace/experiments/unsafe",
        ] {
            add.target = Some(data.path().join(folder).display().to_string());
            for agent in [false, true] {
                let error = project_action(&storage, &root, &add, agent).unwrap_err();
                assert!(error.contains("内部数据"), "{folder}: {error}");
            }
        }
        let target = storage.directory().join("projects/p1/new-loss");
        add.target = Some(target.display().to_string());
        project_action(&storage, &root, &add, false).unwrap();
        assert!(target.join(".git").is_file());
        let browser = data.path().join("browser-profile");
        std::fs::create_dir_all(&browser).unwrap();
        let mut workspace = scientify_core::workspace::empty();
        workspace["projects"] = serde_json::json!([{"id":"p1","name":"Fixture","space":"personal","question":"test","createdAt":"2026-10-02","path":browser}]);
        workspace["revision"] = serde_json::json!(1);
        storage.save(workspace, 0).unwrap();
        let files = ResearchFiles::new(storage.directory().to_path_buf());
        assert!(resolve(&storage, &files, "p1", None)
            .unwrap_err()
            .contains("内部数据"));
    }
    #[test]
    fn broken_git_metadata_does_not_hide_a_valid_code_directory() {
        let data = tempfile::tempdir().unwrap();
        let storage = Storage::open(data.path().join("workspace")).unwrap();
        let files = ResearchFiles::new(storage.directory().to_path_buf());
        let root = files.project_root("p1", None).unwrap();
        std::fs::write(root.join(".git"), "invalid Git metadata").unwrap();
        std::fs::write(root.join("train.py"), "print(1)\n").unwrap();
        let snapshot = read_project(&storage, &root).unwrap();
        assert!(snapshot.repository);
        assert!(snapshot.error.is_some());
        assert_eq!(Path::new(&snapshot.root), root);
        assert_eq!(files.read(&root, "train.py").unwrap().content, "print(1)\n");
    }
}
#[tauri::command]
pub async fn code_git_inspect(
    state: State<'_, AppState>,
    project_id: String,
    workspace_root: Option<String>,
) -> Result<Snapshot, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        read_project(
            &storage,
            &resolve(&storage, &files, &project_id, workspace_root.as_deref())?,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn code_git_diff(
    state: State<'_, AppState>,
    project_id: String,
    workspace_root: Option<String>,
    path: String,
    staged: bool,
    commit: Option<String>,
) -> Result<String, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        diff(
            &repository_for(
                &storage,
                &resolve(&storage, &files, &project_id, workspace_root.as_deref())?,
            )?,
            &path,
            staged,
            commit.as_deref(),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn code_git_action(
    state: State<'_, AppState>,
    project_id: String,
    workspace_root: Option<String>,
    request: Action,
) -> Result<String, String> {
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        project_action(
            &storage,
            &resolve(&storage, &files, &project_id, workspace_root.as_deref())?,
            &request,
            false,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
