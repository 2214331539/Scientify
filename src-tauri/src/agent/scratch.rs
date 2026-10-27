//! App-owned intermediate files never belong in a user's literature or code tree.
use scientify_core::research::reject_links;
use std::{
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub struct Scratch {
    path: PathBuf,
    base: PathBuf,
}
impl Scratch {
    pub fn new(container: &Path, project: &str, conversation: &str) -> Result<Self, String> {
        if !scientify_core::workspace::valid_id(project)
            || !scientify_core::workspace::valid_id(conversation)
        {
            return Err("临时任务标识无效。".into());
        }
        let base = container.join("tmp/agent");
        reject_links(&base)?;
        std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
        reject_links(&base)?;
        let base = base.canonicalize().map_err(|e| e.to_string())?;
        let path = base
            .join(project)
            .join(conversation)
            .join(uuid::Uuid::new_v4().to_string());
        reject_links(&path)?;
        std::fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        std::fs::write(
            path.join(".scientify-scratch"),
            b"scientify-agent-scratch-v1",
        )
        .map_err(|e| e.to_string())?;
        Ok(Self { path, base })
    }
    pub fn path(&self) -> &Path {
        &self.path
    }
    pub fn instruction(&self) -> String {
        format!("\n<scientify-execution>本轮临时目录：{}。必须生成的中间文件仅写入这里，不写入文献目录；用户明确指定的成果另行保存到其要求的位置。临时目录任务结束会清理，不作为成果保存位置。常规 PDF 阅读使用论文宿主工具，不通过命令转换。</scientify-execution>", self.path.display())
    }
    fn remove(base: &Path, path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        reject_links(path)?;
        let actual = path.canonicalize().map_err(|e| e.to_string())?;
        let marker = actual.join(".scientify-scratch");
        reject_links(&marker)?;
        if !actual.starts_with(base)
            || actual == base
            || std::fs::read(marker).map_err(|e| e.to_string())? != b"scientify-agent-scratch-v1"
        {
            return Err("拒绝清理不属于 Agent 的临时目录。".into());
        }
        std::fs::remove_dir_all(actual).map_err(|e| e.to_string())
    }
    pub fn cleanup_expired(container: &Path) -> Result<(), String> {
        let base = container.join("tmp/agent");
        if !base.exists() {
            return Ok(());
        }
        reject_links(&base)?;
        let base = base.canonicalize().map_err(|e| e.to_string())?;
        for project in std::fs::read_dir(&base).map_err(|e| e.to_string())? {
            let project = project.map_err(|e| e.to_string())?.path();
            if reject_links(&project).is_err() || !project.is_dir() {
                continue;
            }
            for conversation in std::fs::read_dir(project).map_err(|e| e.to_string())? {
                let conversation = conversation.map_err(|e| e.to_string())?.path();
                if reject_links(&conversation).is_err() || !conversation.is_dir() {
                    continue;
                }
                for task in std::fs::read_dir(conversation).map_err(|e| e.to_string())? {
                    let task = task.map_err(|e| e.to_string())?.path();
                    if reject_links(&task).is_err()
                        || !task.is_dir()
                        || !task.join(".scientify-scratch").is_file()
                    {
                        continue;
                    }
                    if reject_links(&task.join(".scientify-scratch")).is_err() {
                        continue;
                    }
                    let modified = std::fs::metadata(task.join(".scientify-scratch"))
                        .and_then(|m| m.modified())
                        .map_err(|e| e.to_string())?;
                    if SystemTime::now()
                        .duration_since(modified)
                        .unwrap_or_default()
                        > Duration::from_secs(24 * 3600)
                    {
                        Self::remove(&base, &task)?;
                    }
                }
            }
        }
        Ok(())
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        if let Err(error) = Self::remove(&self.base, &self.path) {
            eprintln!("Scientify 临时目录清理失败：{error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn owned_scratch_is_isolated_and_only_owned_files_are_cleaned() {
        let temp = tempfile::tempdir().unwrap();
        let one = Scratch::new(temp.path(), "p1", "c1").unwrap();
        let two = Scratch::new(temp.path(), "p1", "c1").unwrap();
        assert_ne!(one.path(), two.path());
        let path = one.path().to_path_buf();
        std::fs::write(path.join("intermediate.txt"), "extracted").unwrap();
        let outside = temp.path().join("user");
        std::fs::create_dir(&outside).unwrap();
        assert!(Scratch::remove(&one.base, &outside).is_err());
        drop(one);
        assert!(!path.exists());
        assert!(two.path().exists() && outside.exists());
        assert!(Scratch::new(temp.path(), "../user", "c1").is_err());
    }

    #[test]
    fn startup_cleanup_only_removes_expired_owned_tasks() {
        let temp = tempfile::tempdir().unwrap();
        let expired = Scratch::new(temp.path(), "p1", "c1").unwrap();
        let fresh = Scratch::new(temp.path(), "p1", "c1").unwrap();
        let unknown = expired.path.parent().unwrap().join("user-files");
        std::fs::create_dir(&unknown).unwrap();
        std::fs::write(unknown.join("keep.txt"), b"user").unwrap();
        let old = SystemTime::now() - Duration::from_secs(25 * 3600);
        std::fs::OpenOptions::new()
            .write(true)
            .open(expired.path.join(".scientify-scratch"))
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(old))
            .unwrap();
        Scratch::cleanup_expired(temp.path()).unwrap();
        assert!(!expired.path.exists());
        assert!(fresh.path.exists());
        assert_eq!(std::fs::read(unknown.join("keep.txt")).unwrap(), b"user");
    }
}
