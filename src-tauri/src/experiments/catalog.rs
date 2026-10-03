use crate::{git, AppState};
use scientify_core::{
    research::{reject_links, ResearchFiles},
    storage::Storage,
};
use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::State;

pub(crate) fn root_of(
    storage: &Storage,
    files: &ResearchFiles,
    data: &Value,
    experiment: &Value,
) -> Result<PathBuf, String> {
    if experiment["source"] == "project" {
        let project = data["projects"]
            .as_array()
            .and_then(|items| items.iter().find(|p| p["id"] == experiment["project"]))
            .ok_or("实验所属项目不存在。")?;
        files.project_root(
            project["id"].as_str().ok_or("项目标识无效。")?,
            project["path"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| project["repo"].as_str().filter(|s| !s.trim().is_empty())),
        )
    } else {
        checked_root(
            storage,
            experiment["root"].as_str().ok_or("实验目录无效。")?,
        )
    }
}

fn checked_root(storage: &Storage, value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if !path.is_absolute() || value.contains('\0') || !path.is_dir() {
        return Err("实验目录必须是可访问的本地绝对路径。".into());
    }
    reject_links(path)?;
    let root = path.canonicalize().map_err(|e| e.to_string())?;
    git::protect_internal_data(storage, &root)?;
    Ok(root)
}

fn check_overlap(
    storage: &Storage,
    files: &ResearchFiles,
    data: &Value,
    root: &Path,
    skip: Option<&str>,
) -> Result<(), String> {
    for experiment in data["experiments"].as_array().ok_or("实验列表无效。")? {
        if experiment["id"].as_str() == skip {
            continue;
        }
        if let Ok(other) = root_of(storage, files, data, experiment) {
            if root.starts_with(&other) || other.starts_with(root) {
                return Err("该目录与已登记实验的目录相同或相互包含，请选择独立目录。".into());
            }
        }
    }
    Ok(())
}

pub(crate) fn validate_changes(
    storage: &Storage,
    files: &ResearchFiles,
    old: Option<&Value>,
    next: &Value,
) -> Result<(), String> {
    for experiment in next["experiments"].as_array().ok_or("实验列表无效。")? {
        let before = old
            .and_then(|d| d["experiments"].as_array())
            .and_then(|items| items.iter().find(|e| e["id"] == experiment["id"]));
        if before.is_some_and(|e| {
            e["root"] == experiment["root"]
                && e["source"] == experiment["source"]
                && e["project"] == experiment["project"]
        }) {
            continue;
        }
        // Legacy project directories are already validated by the project/file service.
        if experiment["source"] == "project" {
            continue;
        }
        let root = root_of(storage, files, next, experiment)?;
        check_overlap(storage, files, next, &root, experiment["id"].as_str())?;
    }
    Ok(())
}

pub(crate) fn owner(
    storage: &Storage,
    files: &ResearchFiles,
    project: &str,
    root: &Path,
) -> Result<Option<String>, String> {
    let data = storage.load()?.ok_or("项目不存在。")?;
    for experiment in data["experiments"].as_array().ok_or("实验列表无效。")? {
        if experiment["project"] == project
            && experiment["archived"] != true
            && root_of(storage, files, &data, experiment).is_ok_and(|p| p == root)
        {
            return Ok(experiment["id"].as_str().map(str::to_owned));
        }
    }
    Ok(None)
}

pub(crate) fn keeps_binding(old: &Value, next: &Value, id: Option<&str>) -> bool {
    let Some(id) = id else {
        return true;
    };
    let find = |data: &Value| {
        data["experiments"]
            .as_array()
            .and_then(|items| items.iter().find(|e| e["id"] == id))
            .cloned()
    };
    match (find(old), find(next)) {
        (Some(before), Some(after)) => {
            after["archived"] != true
                && before["root"] == after["root"]
                && before["source"] == after["source"]
                && before["project"] == after["project"]
        }
        _ => false,
    }
}

#[derive(Serialize)]
pub struct Prepared {
    id: String,
    root: String,
    source: String,
}

#[tauri::command]
pub async fn experiment_prepare<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    state: State<'_, AppState>,
    project_id: String,
    source: String,
    directory: Option<String>,
) -> Result<Prepared, String> {
    crate::library::trusted(&view)?;
    let (storage, files) = (state.storage.clone(), state.files.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let data = storage.load()?.ok_or("请先保存项目。")?;
        if !data["projects"]
            .as_array()
            .is_some_and(|ps| ps.iter().any(|p| p["id"] == project_id))
        {
            return Err("项目不存在。".into());
        }
        let id = uuid::Uuid::new_v4().to_string();
        let root = match source.as_str() {
            "existing" => checked_root(&storage, directory.as_deref().ok_or("请选择实验目录。")?)?,
            "empty" => {
                let path = storage
                    .directory()
                    .join("projects")
                    .join(format!("experiment-{id}"));
                reject_links(&path)?;
                std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
                std::fs::create_dir(&path).map_err(|e| e.to_string())?;
                checked_root(&storage, path.to_str().ok_or("目录编码无效。")?)?
            }
            _ => return Err("请选择已有目录或创建空目录。".into()),
        };
        check_overlap(&storage, &files, &data, &root, None)?;
        Ok(Prepared {
            id,
            root: root.display().to_string(),
            source,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn independent_roots_are_registered_and_nested_private_or_other_project_roots_are_rejected() {
        let temp = tempfile::tempdir().unwrap();
        let storage = Storage::open(temp.path().join("ScientifyData/workspace")).unwrap();
        let files = ResearchFiles::new(storage.directory().to_path_buf());
        let first = temp.path().join("first");
        let second = temp.path().join("second");
        std::fs::create_dir(&first).unwrap();
        std::fs::create_dir(&second).unwrap();
        std::fs::create_dir(first.join("nested")).unwrap();
        let mut before = scientify_core::workspace::empty();
        before["projects"] =
            json!([{"id":"p1","name":"test","question":"","createdAt":"now","path":first}]);
        before["revision"] = json!(1);
        let before = storage.save(before, 0).unwrap();
        let mut next = before.clone();
        next["experiments"].as_array_mut().unwrap().push(json!({"id":"e2","project":"p1","name":"ablation","purpose":"","source":"existing","root":second.canonicalize().unwrap(),"createdAt":"now","updatedAt":"now"}));
        assert!(validate_changes(&storage, &files, Some(&before), &next).is_ok());
        next["revision"] = json!(2);
        storage.save(next.clone(), 1).unwrap();
        assert_eq!(
            git::resolve(&storage, &files, "p1", second.to_str()).unwrap(),
            second.canonicalize().unwrap()
        );
        assert_eq!(
            owner(&storage, &files, "p1", &second.canonicalize().unwrap())
                .unwrap()
                .as_deref(),
            Some("e2")
        );
        assert!(git::resolve(&storage, &files, "p2", second.to_str()).is_err());
        for path in [
            first.clone(),
            first.join("nested"),
            storage.directory().join("agent"),
            temp.path().to_path_buf(),
        ] {
            std::fs::create_dir_all(&path).unwrap();
            let mut invalid = next.clone();
            invalid["experiments"][1]["root"] = json!(path);
            assert!(validate_changes(&storage, &files, Some(&before), &invalid).is_err());
        }
        let mut archived = next.clone();
        archived["experiments"][1]["archived"] = json!(true);
        archived["revision"] = json!(3);
        storage.save(archived.clone(), 2).unwrap();
        assert!(git::resolve(&storage, &files, "p1", second.to_str()).is_err());
        assert!(!keeps_binding(&next, &archived, Some("e2")));
        let mut renamed = next.clone();
        renamed["experiments"][1]["name"] = json!("renamed");
        assert!(keeps_binding(&next, &renamed, Some("e2")));
        renamed["experiments"] = json!([]);
        assert!(!keeps_binding(&next, &renamed, Some("e2")));
    }
}
