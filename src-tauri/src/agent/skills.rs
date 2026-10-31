//! Skills come from the pinned engine's discovery, scoped to the conversation cwd.
use super::*;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillRef {
    name: String,
    path: String,
}
#[derive(Deserialize, Serialize)]
pub struct Skill {
    name: String,
    path: String,
    description: String,
    enabled: bool,
}
#[derive(Deserialize)]
struct SkillError {
    message: String,
}
#[derive(Deserialize)]
struct Entry {
    skills: Vec<Skill>,
    errors: Vec<SkillError>,
}
#[derive(Deserialize)]
struct Response {
    data: Vec<Entry>,
}
#[derive(Serialize)]
pub struct Listing {
    skills: Vec<Skill>,
    errors: Vec<String>,
}

fn list(session: &mut EngineSession, root: &std::path::Path) -> Result<Listing, String> {
    let value = session.call(
        "skills/list",
        json!({"cwds":[root],"forceReload":true}),
        HANDSHAKE_BUDGET,
    )?;
    let response: Response =
        serde_json::from_value(value).map_err(|e| format!("技能列表格式不兼容：{e}"))?;
    let mut listing = Listing {
        skills: vec![],
        errors: vec![],
    };
    for entry in response.data {
        listing
            .skills
            .extend(entry.skills.into_iter().filter(|skill| skill.enabled));
        listing
            .errors
            .extend(entry.errors.into_iter().map(|error| error.message));
    }
    Ok(listing)
}

pub(super) fn append(
    session: &mut EngineSession,
    root: &std::path::Path,
    mut input: Vec<Value>,
    selected: Vec<SkillRef>,
) -> Result<Vec<Value>, String> {
    if selected.is_empty() {
        return Ok(input);
    }
    if selected.len() > 4 {
        return Err("每条消息最多选择 4 个技能。".into());
    }
    let available = list(session, root)?;
    for skill in selected {
        if !available
            .skills
            .iter()
            .any(|item| item.name == skill.name && item.path == skill.path)
        {
            return Err(format!(
                "技能已移除、停用或不属于当前工作区，请重新选择：{}",
                skill.name
            ));
        }
        input.push(json!({"type":"skill","name":skill.name,"path":skill.path}));
    }
    Ok(input)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    project_id: String,
    domain: String,
    conversation_id: String,
    workspace_root: Option<String>,
}

#[tauri::command]
pub async fn agent_skills<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    request: Request,
) -> Result<Listing, String> {
    crate::library::trusted(&view)?;
    valid_domain(&request.domain)?;
    blocking(move || {
        let root = conversation_root(
            &app,
            &request.project_id,
            &request.domain,
            &request.conversation_id,
            request.workspace_root.as_deref(),
        )?;
        let shared = slot(&app, &request.project_id, &request.conversation_id)?;
        let mut guard = shared.lock().map_err(|e| e.to_string())?;
        if let Some(entry) = guard.as_mut() {
            if entry.session.ensure_alive().is_ok() {
                return list(&mut entry.session, &root);
            }
        }
        // Discovery has no model request, sandbox installer or conversation side effect.
        let home = codex_home(&app, &request.domain)?;
        let gate = execution::gate(&home);
        let _setup = gate.lock().map_err(|e| e.to_string())?;
        let mut session = EngineSession::start_with_events(
            &process::engine_path()?,
            &[
                "app-server",
                "--listen",
                "stdio://",
                "-c",
                "features.memories=false",
                "-c",
                "features.external_agent_memory_import=false",
            ],
            &home,
            &root,
            &[],
            None,
        )?;
        list(&mut session, &root)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_codex_discovers_real_skills_and_rejects_forged_or_removed_selection() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().join("workspace");
        let home = temporary.path().join("engine");
        let skill_dir = root.join(".agents/skills/scientify-fixture");
        std::fs::create_dir_all(&skill_dir).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let path = skill_dir.join("SKILL.md");
        std::fs::write(&path, "---\nname: scientify-fixture\ndescription: Local test skill\n---\nUse fixture instructions.\n").unwrap();
        let mut session = EngineSession::start_with_events(
            &process::engine_path().unwrap(),
            &["app-server", "--listen", "stdio://"],
            &home,
            &root,
            &[],
            None,
        )
        .unwrap();
        let listing = list(&mut session, &root).unwrap();
        let skill = listing
            .skills
            .into_iter()
            .find(|skill| skill.name == "scientify-fixture")
            .expect("Codex did not discover workspace skill");
        let selected = SkillRef {
            name: skill.name,
            path: skill.path,
        };
        let input = append(
            &mut session,
            &root,
            vec![json!({"type":"text","text":"test","text_elements":[]})],
            vec![selected.clone()],
        )
        .unwrap();
        assert_eq!(input[1]["type"], "skill");
        assert_eq!(input[1]["path"], selected.path);
        assert!(append(
            &mut session,
            &root,
            vec![],
            vec![SkillRef {
                name: "forged".into(),
                path: selected.path.clone()
            }]
        )
        .is_err());
        std::fs::remove_file(path).unwrap();
        assert!(append(&mut session, &root, vec![], vec![selected]).is_err());
    }
}
