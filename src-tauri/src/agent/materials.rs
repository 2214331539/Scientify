//! Bounded, fresh discovery inside an authorized conversation root. No index/cache.
use super::*;
use scientify_core::research::{reject_links, ResearchFiles};
use std::{collections::VecDeque, path::Path, time::Instant};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Material {
    path: String,
    title: String,
    text: String,
    truncated: bool,
}
#[derive(Serialize)]
pub struct Snapshot {
    root: String,
    materials: Vec<Material>,
    warnings: Vec<String>,
}

fn excluded(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    name.starts_with('.')
        || matches!(
            name.as_str(),
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "venv"
                | "env"
                | "__pycache__"
                | "site-packages"
        )
        || name.contains("secret")
        || name.contains("credential")
        || name.contains("token")
        || name.ends_with(".pem")
        || name.ends_with(".key")
}
fn readable(path: &str) -> bool {
    let path = Path::new(path);
    matches!(
        path.extension().and_then(|v| v.to_str()),
        Some(
            "md" | "txt" | "py" | "toml" | "json" | "yaml" | "yml" | "cfg" | "ini" | "bib" | "tex"
        )
    )
}
fn excerpt(value: &str, max: usize) -> String {
    let mut end = value.len().min(max);
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}
fn collect(
    files: &ResearchFiles,
    root: &Path,
    private_data: &Path,
    current: Option<&str>,
) -> Result<Snapshot, String> {
    reject_links(root)?;
    let started = Instant::now();
    let mut result = Snapshot {
        root: root.display().to_string(),
        materials: vec![],
        warnings: vec![],
    };
    let mut queue = VecDeque::from([(root.to_path_buf(), 0)]);
    let mut paths = vec![];
    let mut scanned = 0;
    while let Some((directory, depth)) = queue.pop_front() {
        for entry in std::fs::read_dir(&directory).map_err(|e| e.to_string())? {
            if scanned >= 200 || started.elapsed() > Duration::from_secs(2) {
                result
                    .warnings
                    .push("目录发现已达数量或时间上限；更多文件可按需读取。".into());
                queue.clear();
                break;
            }
            scanned += 1;
            let entry = entry.map_err(|e| e.to_string())?;
            if excluded(&entry.file_name().to_string_lossy()) {
                continue;
            }
            let path = entry.path();
            // An external root can contain the app's data directory. Do not
            // enumerate it; managed roots inside data/projects remain usable.
            if path == private_data {
                continue;
            }
            if reject_links(&path).is_err() {
                continue;
            }
            let kind = entry.file_type().map_err(|e| e.to_string())?;
            if kind.is_dir() && depth < 2 {
                queue.push_back((path.clone(), depth + 1));
            }
            if kind.is_file() {
                paths.push(
                    path.strip_prefix(root)
                        .map_err(|e| e.to_string())?
                        .to_string_lossy()
                        .replace('\\', "/"),
                );
            }
        }
    }
    paths.sort();
    let listing = paths
        .iter()
        .take(80)
        .cloned()
        .collect::<Vec<_>>()
        .join("\n");
    result.materials.push(Material {
        path: ".".into(),
        title: "工作区文件摘要".into(),
        text: excerpt(&listing, 6000),
        truncated: paths.len() > 80 || listing.len() > 6000,
    });
    let current = current
        .and_then(|p| {
            let p = Path::new(p);
            if p.is_absolute() {
                p.strip_prefix(root).ok().map(Path::to_path_buf)
            } else {
                Some(p.to_path_buf())
            }
        })
        .map(|p| p.to_string_lossy().replace('\\', "/"));
    // Explicit current path first; then project entry/config and nearby source files.
    paths.sort_by_key(|p| {
        let name = p.rsplit('/').next().unwrap_or(p).to_ascii_lowercase();
        if Some(p) == current.as_ref() {
            0
        } else if matches!(
            name.as_str(),
            "readme.md"
                | "pyproject.toml"
                | "requirements.txt"
                | "setup.cfg"
                | "main.py"
                | "train.py"
                | "evaluate.py"
        ) {
            1
        } else if current
            .as_ref()
            .is_some_and(|c| Path::new(c).parent() == Path::new(p).parent())
        {
            2
        } else {
            3
        }
    });
    for path in paths.into_iter().filter(|p| readable(p)).take(6) {
        if started.elapsed() > Duration::from_secs(2) {
            result.warnings.push("材料读取达到时间上限。".into());
            break;
        }
        let absolute = root.join(&path);
        if std::fs::metadata(&absolute)
            .map_err(|e| e.to_string())?
            .len()
            > 128 * 1024
        {
            result
                .warnings
                .push(format!("{path} 超过自动读取上限，可按需读取。"));
            continue;
        }
        match files.read(root, &path) {
            Ok(file) => result.materials.push(Material {
                title: path.clone(),
                path,
                truncated: file.content.len() > 6000,
                text: excerpt(&file.content, 6000),
            }),
            Err(error) => result.warnings.push(format!("{path}：{error}")),
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn agent_context<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    request: ContextRequest,
) -> Result<Snapshot, String> {
    let ContextRequest {
        project_id,
        domain,
        conversation_id,
        workspace_root,
        path,
        resource_id,
    } = request;
    crate::library::trusted(&view)?;
    valid_domain(&domain)?;
    session_key(&project_id, &conversation_id)?;
    blocking(move || {
        let state = app.state::<AppState>();
        let root = conversation_root(
            &app,
            &project_id,
            &domain,
            &conversation_id,
            workspace_root.as_deref(),
        )?;
        let private_data = state
            .storage
            .directory()
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let mut snapshot = collect(&state.files, &root, &private_data, path.as_deref())?;
        if domain == "literature" {
            if let Some(id) = resource_id {
                let library = app.state::<crate::library::LibraryState>();
                if let Some(binding) = library.service.binding(&project_id, &id)? {
                    match library.service.note(&project_id, &id) {
                        Ok(note) => {
                            snapshot.materials.retain(|m| m.path != binding.note_path);
                            snapshot.materials.insert(
                                1.min(snapshot.materials.len()),
                                Material {
                                    path: binding.note_path,
                                    title: "关联论文笔记".into(),
                                    truncated: note.content.len() > 6000,
                                    text: excerpt(&note.content, 6000),
                                },
                            );
                        }
                        Err(error) => snapshot.warnings.push(error),
                    }
                }
            }
        }
        let mut remaining = 24 * 1024;
        for material in &mut snapshot.materials {
            if material.text.len() > remaining {
                material.text = excerpt(&material.text, remaining);
                material.truncated = true;
            }
            remaining = remaining.saturating_sub(material.text.len());
        }
        snapshot
            .materials
            .retain(|material| !material.text.is_empty());
        Ok(snapshot)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContextRequest {
    project_id: String,
    domain: String,
    conversation_id: String,
    workspace_root: Option<String>,
    path: Option<String>,
    resource_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_is_fresh_bounded_and_does_not_include_credentials_or_other_roots() {
        let data = tempfile::tempdir().unwrap();
        let one = tempfile::tempdir().unwrap();
        let two = tempfile::tempdir().unwrap();
        let files = ResearchFiles::new(data.path().to_path_buf());
        std::fs::write(one.path().join("README.md"), "first").unwrap();
        std::fs::write(one.path().join("credentials.json"), "secret").unwrap();
        std::fs::write(two.path().join("README.md"), "second").unwrap();
        std::fs::create_dir(one.path().join(".venv")).unwrap();
        std::fs::write(one.path().join(".venv/hidden.py"), "hidden").unwrap();
        let root = one.path().canonicalize().unwrap();
        let first =
            serde_json::to_string(&collect(&files, &root, data.path(), None).unwrap()).unwrap();
        assert!(first.contains("first"));
        assert!(
            !first.contains("secret") && !first.contains("second") && !first.contains("hidden")
        );
        std::fs::write(root.join("README.md"), "updated").unwrap();
        assert!(
            serde_json::to_string(&collect(&files, &root, data.path(), None).unwrap())
                .unwrap()
                .contains("updated")
        );
        std::fs::remove_file(root.join("README.md")).unwrap();
        assert!(
            !serde_json::to_string(&collect(&files, &root, data.path(), None).unwrap())
                .unwrap()
                .contains("updated")
        );
    }

    #[test]
    fn ancestor_discovery_skips_private_data_but_managed_projects_still_work() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let data = root.join("data");
        let project = data.join("projects/p1");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(data.join("workspace.json"), "private-history").unwrap();
        std::fs::write(project.join("README.md"), "managed-source").unwrap();
        let files = ResearchFiles::new(data.clone());
        let ancestor =
            serde_json::to_string(&collect(&files, &root, &data, None).unwrap()).unwrap();
        assert!(!ancestor.contains("workspace.json") && !ancestor.contains("managed-source"));
        let managed =
            serde_json::to_string(&collect(&files, &project, &data, None).unwrap()).unwrap();
        assert!(managed.contains("managed-source") && !managed.contains("private-history"));
    }
}
