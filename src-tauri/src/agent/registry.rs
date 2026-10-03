//! Native-only conversation -> thread registry. Never accept arbitrary thread ids
//! from imported workspace JSON. Binding changes fail closed.
use super::{valid_key, ThreadHandle};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
#[derive(Serialize, Deserialize)]
pub struct Binding {
    #[serde(default)]
    pub experiment_id: Option<String>,
    project_id: String,
    conversation_id: String,
    domain: String,
    root: PathBuf,
    pub thread_id: String,
    #[serde(default)]
    pub started: bool,
    #[serde(default)]
    pub managed_runs: bool,
    #[serde(default)]
    pub git_tools: bool,
}
fn path(data: &Path, project: &str, conversation: &str) -> Result<PathBuf, String> {
    if !valid_key(project) || !valid_key(conversation) {
        return Err("项目或会话标识无效。".into());
    }
    Ok(data
        .join("agent")
        .join("bindings")
        .join(project)
        .join(format!("{conversation}.json")))
}
pub fn read(
    data: &Path,
    project: &str,
    conversation: &str,
    domain: &str,
    root: &Path,
) -> Result<Option<Binding>, String> {
    let path = path(data, project, conversation)?;
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let binding: Binding =
        serde_json::from_slice(&bytes).map_err(|e| format!("Agent 会话索引损坏：{e}"))?;
    if binding.project_id != project
        || binding.conversation_id != conversation
        || binding.domain != domain
        || binding.root != root
    {
        return Err("该会话绑定的工作区已变化，请新建会话。".into());
    }
    Ok(Some(binding))
}
pub fn bound_root(
    data: &Path,
    project: &str,
    conversation: &str,
    domain: &str,
) -> Result<Option<PathBuf>, String> {
    let path = path(data, project, conversation)?;
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    let binding: Binding =
        serde_json::from_slice(&bytes).map_err(|e| format!("Agent 会话索引损坏：{e}"))?;
    if binding.project_id != project
        || binding.conversation_id != conversation
        || binding.domain != domain
    {
        return Err("该会话绑定的项目或领域不匹配。".into());
    }
    Ok(Some(binding.root))
}
pub fn write(
    data: &Path,
    handle: &ThreadHandle,
    started: bool,
    managed_runs: bool,
    git_tools: bool,
) -> Result<(), String> {
    let target = path(data, &handle.project_id, &handle.conversation_id)?;
    let record = Binding {
        experiment_id: handle.experiment_id.clone(),
        project_id: handle.project_id.clone(),
        conversation_id: handle.conversation_id.clone(),
        domain: handle.domain.clone(),
        root: PathBuf::from(&handle.cwd),
        thread_id: handle.thread_id.clone(),
        started,
        managed_runs,
        git_tools,
    };
    std::fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    let temporary = target.with_extension("pending");
    std::fs::write(
        &temporary,
        serde_json::to_vec(&record).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(temporary, target).map_err(|e| e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binding_survives_restart_and_rejects_another_root_or_domain() {
        let dir = tempfile::tempdir().unwrap();
        let handle = ThreadHandle {
            experiment_id: None,
            thread_id: "thread-a".into(),
            conversation_id: "chat-a".into(),
            project_id: "project-a".into(),
            domain: "code".into(),
            cwd: dir.path().display().to_string(),
            model: "model".into(),
            model_provider: "scientify".into(),
            instruction_sources: vec![],
            sandbox: "workspaceWrite".into(),
            turns: vec![],
            active_turn_id: None,
            fresh_thread: false,
            events: vec![],
        };
        write(dir.path(), &handle, true, true, true).unwrap();
        assert_eq!(
            read(dir.path(), "project-a", "chat-a", "code", dir.path())
                .unwrap()
                .unwrap()
                .thread_id,
            "thread-a"
        );
        assert!(read(dir.path(), "project-a", "chat-a", "literature", dir.path()).is_err());
        assert!(read(
            dir.path(),
            "project-a",
            "chat-a",
            "code",
            Path::new("/another")
        )
        .is_err());
        assert!(read(dir.path(), "project-a", "chat-b", "code", dir.path())
            .unwrap()
            .is_none());
        assert!(read(dir.path(), "../escape", "chat-a", "code", dir.path()).is_err());

        // A legacy thread keeps the capabilities registered when it was created.
        write(dir.path(), &handle, true, false, false).unwrap();
        let legacy = read(dir.path(), "project-a", "chat-a", "code", dir.path())
            .unwrap()
            .unwrap();
        assert!(legacy.started);
        assert_eq!(legacy.thread_id, "thread-a");
        assert!(!legacy.managed_runs);
        assert!(!legacy.git_tools);
        let target = path(dir.path(), "project-a", "chat-a").unwrap();
        let mut old: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&target).unwrap()).unwrap();
        old.as_object_mut().unwrap().remove("managed_runs");
        old.as_object_mut().unwrap().remove("git_tools");
        std::fs::write(&target, serde_json::to_vec(&old).unwrap()).unwrap();
        let legacy = read(dir.path(), "project-a", "chat-a", "code", dir.path())
            .unwrap()
            .unwrap();
        assert!(legacy.started);
        assert_eq!(legacy.thread_id, "thread-a");
        assert!(!legacy.managed_runs);
        assert!(!legacy.git_tools);
    }
}
