//! Directory leases coordinate product Git operations with AI turns and runs.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

#[derive(Default)]
struct Activity {
    agents: usize,
    runs: usize,
    writes: usize,
    mutation: bool,
}
fn activities() -> &'static Mutex<HashMap<PathBuf, Activity>> {
    static STATE: OnceLock<Mutex<HashMap<PathBuf, Activity>>> = OnceLock::new();
    STATE.get_or_init(Default::default)
}
enum Kind {
    Agent,
    Run,
    Write,
    Mutation,
    AgentMutation,
}
pub(crate) struct Lease {
    root: PathBuf,
    kind: Kind,
}
impl Lease {
    fn acquire(root: &Path, kind: Kind) -> Result<Self, String> {
        let root = root.canonicalize().map_err(|e| e.to_string())?;
        let mut state = activities().lock().map_err(|e| e.to_string())?;
        let overlapping: Vec<_> = state
            .iter()
            .filter(|(path, _)| root.starts_with(path) || path.starts_with(&root))
            .map(|(_, entry)| entry)
            .collect();
        if overlapping.iter().any(|entry| {
            entry.mutation
                || (matches!(kind, Kind::Mutation) && entry.agents + entry.runs + entry.writes > 0)
        }) {
            return Err("此目录有活动任务或 Git 操作，请等待完成后重试。".into());
        }
        if matches!(kind, Kind::AgentMutation)
            && overlapping
                .iter()
                .any(|entry| entry.runs + entry.writes > 0)
        {
            return Err("此目录有运行或文件写入，暂不能执行 Git 写操作。".into());
        }
        if matches!(kind, Kind::Agent) && overlapping.iter().any(|entry| entry.agents > 0) {
            return Err(
                "此目录已有 AI 任务。请等待任务结束，或选择另一个 worktree 新建会话。".into(),
            );
        }
        let entry = state.entry(root.clone()).or_default();
        match kind {
            Kind::Agent => entry.agents += 1,
            Kind::Run => entry.runs += 1,
            Kind::Write => entry.writes += 1,
            Kind::Mutation | Kind::AgentMutation => entry.mutation = true,
        }
        Ok(Self { root, kind })
    }
    pub(crate) fn agent(root: &Path) -> Result<Self, String> {
        Self::acquire(root, Kind::Agent)
    }
    pub(crate) fn run(root: &Path) -> Result<Self, String> {
        Self::acquire(root, Kind::Run)
    }
    pub(crate) fn mutation(root: &Path) -> Result<Self, String> {
        Self::acquire(root, Kind::Mutation)
    }
    pub(crate) fn write(root: &Path) -> Result<Self, String> {
        Self::acquire(root, Kind::Write)
    }
    pub(crate) fn agent_mutation(root: &Path) -> Result<Self, String> {
        Self::acquire(root, Kind::AgentMutation)
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Ok(mut state) = activities().lock() {
            if let Some(entry) = state.get_mut(&self.root) {
                match self.kind {
                    Kind::Agent => entry.agents -= 1,
                    Kind::Run => entry.runs -= 1,
                    Kind::Write => entry.writes -= 1,
                    Kind::Mutation | Kind::AgentMutation => entry.mutation = false,
                }
                if entry.agents + entry.runs + entry.writes == 0 && !entry.mutation {
                    state.remove(&self.root);
                }
            }
        }
    }
}
pub(crate) fn busy(root: &Path) -> bool {
    activities().lock().is_ok_and(|state| {
        state.iter().any(|(path, entry)| {
            (root.starts_with(path) || path.starts_with(root))
                && (entry.agents + entry.runs + entry.writes > 0 || entry.mutation)
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn separate_directories_can_run_but_mutation_and_same_directory_agents_are_protected() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let agent = Lease::agent(a.path()).unwrap();
        assert!(Lease::agent(a.path()).is_err());
        assert!(Lease::mutation(a.path()).is_err());
        let other = Lease::agent(b.path()).unwrap();
        let run = Lease::run(a.path()).unwrap();
        drop(agent);
        assert!(Lease::mutation(a.path()).is_err());
        drop(run);
        let mutation = Lease::mutation(a.path()).unwrap();
        assert!(Lease::agent(a.path()).is_err());
        assert!(Lease::run(a.path()).is_err());
        drop(mutation);
        assert!(Lease::agent(a.path()).is_ok());
        drop(other);
    }
    #[test]
    fn overlapping_roots_and_approved_agent_mutations_respect_active_runs_and_writes() {
        let directory = tempfile::tempdir().unwrap();
        let child = directory.path().join("nested");
        std::fs::create_dir(&child).unwrap();
        let agent = Lease::agent(&child).unwrap();
        assert!(Lease::agent(directory.path()).is_err());
        assert!(Lease::mutation(directory.path()).is_err());
        let approved = Lease::agent_mutation(&child).unwrap();
        assert!(Lease::write(&child).is_err());
        drop(approved);
        let run = Lease::run(directory.path()).unwrap();
        assert!(Lease::agent_mutation(&child).is_err());
        drop(run);
        let write = Lease::write(&child).unwrap();
        assert!(Lease::agent_mutation(&child).is_err());
        drop(write);
        assert!(Lease::agent_mutation(&child).is_ok());
        drop(agent);
        assert!(!busy(&directory.path().canonicalize().unwrap()));
    }
}
