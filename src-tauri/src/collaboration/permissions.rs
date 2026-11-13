//! Local edit policy mirrors the server; personal projects have no collaboration role.
use scientify_core::storage::Storage;
use serde_json::Value;

/// Refresh the local role before syncing; a revoked membership becomes read-only locally.
pub(crate) fn remember_role(storage: &Storage, project: &str, role: &str) -> Result<bool, String> {
    for _ in 0..3 {
        let mut data = storage.load()?.ok_or("工作区尚未载入。")?;
        let revision = data["revision"].as_u64().unwrap_or(0);
        let info = data["projects"]
            .as_array_mut()
            .and_then(|items| items.iter_mut().find(|p| p["id"] == project))
            .ok_or("项目不存在。")?;
        if info["collaborationRole"] == role {
            return Ok(false);
        }
        info["collaborationRole"] = serde_json::json!(role);
        data["revision"] = serde_json::json!(revision + 1);
        data["updatedAt"] = serde_json::json!(scientify_core::workspace::now());
        match storage.save(data, revision) {
            Ok(_) => return Ok(true),
            Err(e) if e.contains("已发生变化") => continue,
            Err(e) => return Err(e),
        }
    }
    Err("工作区正被频繁修改，稍后再同步。".into())
}

pub(crate) fn can_write(role: Option<&str>, domain: &str) -> bool {
    match role {
        None | Some("owner" | "editor") => true,
        Some("reviewer") => domain == "record",
        _ => false,
    }
}

pub(crate) fn require_write(storage: &Storage, project: &str, domain: &str) -> Result<(), String> {
    if project == crate::agent::INBOX {
        return Ok(());
    }
    let data = storage.load()?.ok_or("工作区尚未载入。")?;
    let info = data["projects"]
        .as_array()
        .and_then(|items| items.iter().find(|p| p["id"] == project))
        .ok_or("项目不存在。")?;
    if can_write(info["collaborationRole"].as_str(), domain) {
        Ok(())
    } else {
        Err("当前项目角色不允许此修改。查看者只能阅读，审阅者只能编辑项目笔记。".into())
    }
}

/// Save is a second boundary behind disabled controls, including AI-created records.
pub(crate) fn validate_changes(before: &Value, after: &Value) -> Result<(), String> {
    for project in before["projects"].as_array().into_iter().flatten() {
        let id = &project["id"];
        let role = project["collaborationRole"].as_str();
        if can_write(role, "project") {
            continue;
        }
        let next = after["projects"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|p| &p["id"] == id);
        // Removing a local project is not a cloud deletion.
        let Some(next) = next else {
            continue;
        };
        for field in ["name", "question", "color", "description"] {
            if project[field] != next[field] {
                return Err("当前项目角色不允许编辑项目信息。".into());
            }
        }
        for (collection, domain) in [
            ("records", "record"),
            ("experiments", "experiment"),
            ("runs", "run"),
        ] {
            if can_write(role, domain) {
                continue;
            }
            let entries = |data: &Value| -> Vec<Value> {
                data[collection]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|item| &item["project"] == id)
                    .cloned()
                    .collect()
            };
            if entries(before) != entries(after) {
                return Err("当前项目角色不允许编辑此内容。".into());
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn roles_limit_edits_without_blocking_local_preferences_or_chat() {
        let before =
            json!({"projects":[{"id":"p","name":"P","collaborationRole":"viewer"}], "records":[]});
        let mut after = before.clone();
        after["projects"][0]["favorite"] = json!(true);
        after["sessions"] = json!([{"id":"chat"}]);
        assert!(validate_changes(&before, &after).is_ok());
        after["records"] = json!([{"id":"n","project":"p","body":"changed"}]);
        assert!(validate_changes(&before, &after).is_err());
        assert!(can_write(Some("reviewer"), "record"));
        assert!(!can_write(Some("reviewer"), "library"));
        assert!(!can_write(Some("reviewer"), "asset"));
        assert!(!can_write(Some("viewer"), "code"));
        assert!(can_write(None, "code"));
    }
}
