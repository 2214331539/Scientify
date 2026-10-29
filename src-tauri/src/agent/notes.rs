//! Project notes are records, not arbitrary files. Keep model writes scoped and versioned.
use super::*;
use sha2::{Digest, Sha256};

pub fn specifications() -> Vec<Value> {
    [
        ("scientify_list_notes", "List saved global/project Markdown notes in this conversation's project. Paper notes remain adjacent .notes.md files in the literature workspace. No access to other projects or the personal inbox.", json!({}), vec![]),
        ("scientify_read_note", "Read a saved project note and its version before editing. Returns Markdown and a version token; never edit workspace.json directly.", json!({"id":{"type":"string"}}), vec!["id"]),
        ("scientify_write_note", "Update an existing project note with Markdown. Must use the expectedVersion from read_note. Ask mode requires user approval; full mode writes directly. Preserve relative image references. Concurrent edits cause a conflict, never overwrite them blindly.", json!({"id":{"type":"string"},"expectedVersion":{"type":"string"},"title":{"type":"string"},"body":{"type":"string"}}), vec!["id","expectedVersion","title","body"]),
    ].into_iter().map(|(name,description,properties,required)| json!({"type":"function","name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}
fn version(note: &Value) -> String {
    format!("{:x}", Sha256::digest(note.to_string().as_bytes()))
}

pub fn operate(
    storage: &scientify_core::storage::Storage,
    project: &str,
    tool: &str,
    args: &Value,
) -> Result<Value, String> {
    let mut data = storage.load()?.ok_or("工作区尚未载入。")?;
    let revision = data["revision"].as_u64().ok_or("工作区版本无效。")?;
    let records = data["records"].as_array_mut().ok_or("笔记记录无效。")?;
    if tool == "scientify_list_notes" {
        return Ok(
            json!({"notes":records.iter().filter(|n| n["project"] == project).map(|n| json!({"id":n["id"],"title":n["title"],"updatedAt":n["updatedAt"]})).collect::<Vec<_>>()}),
        );
    }
    let id = args["id"].as_str().ok_or("缺少笔记标识。")?;
    let note = records
        .iter_mut()
        .find(|n| n["project"] == project && n["id"] == id)
        .ok_or("笔记不存在或不属于当前项目。")?;
    if tool == "scientify_read_note" {
        if note["body"].as_str().unwrap_or_default().len() > 128 * 1024 {
            return Err("笔记过长，请在编辑器中选取需要修改的段落。".into());
        }
        return Ok(
            json!({"id":note["id"],"title":note["title"],"body":note["body"],"version":version(note)}),
        );
    }
    if tool != "scientify_write_note" {
        return Err("未知笔记操作。".into());
    }
    if args["expectedVersion"].as_str() != Some(version(note).as_str()) {
        return Err("笔记已修改，请重新读取后再编辑。".into());
    }
    let title = args["title"].as_str().ok_or("缺少标题。")?;
    let body = args["body"].as_str().ok_or("缺少正文。")?;
    if title.trim().is_empty()
        || title.len() > 1000
        || body.len() > 2 * 1024 * 1024
        || body.contains('\0')
    {
        return Err("笔记内容无效或过长。".into());
    }
    note["title"] = json!(title);
    note["body"] = json!(body);
    note["updatedAt"] = json!(scientify_core::workspace::now());
    let result = json!({"id":id,"version":version(note),"saved":true});
    data["revision"] = json!(revision + 1);
    data["updatedAt"] = json!(scientify_core::workspace::now());
    storage.save(data, revision)?;
    Ok(result)
}

pub fn queue<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project: &str,
    domain: &str,
    conversation: &str,
    event: &Value,
) -> Result<Option<Value>, String> {
    let params = &event["params"];
    with_entry(app, project, domain, conversation, |entry| {
        entry.validate(params["threadId"].as_str().ok_or("工具线程缺失。")?)?;
        if entry.active_turn.as_deref() != params["turnId"].as_str() || entry.lease.is_none() {
            return Err("工具任务已经结束。".into());
        }
        if entry.permission == PermissionMode::Full {
            return Ok(Some(event.clone()));
        }
        let id = json!(format!("scientify-note:{}", uuid::Uuid::new_v4()));
        let approval = json!({"kind":"request","method":"scientify/notes/requestApproval","id":id,"params":{"threadId":entry.handle.thread_id,"turnId":entry.active_turn,"command":params["arguments"]["title"],"reason":params["arguments"]["body"]}});
        entry.host_requests.insert(id.to_string(), event.clone());
        entry.requests.insert(id.to_string(), approval.clone());
        entry.host_events.push(approval);
        Ok(None)
    })
}

pub fn complete<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project: &str,
    domain: &str,
    conversation: &str,
    event: Value,
    decision: &Value,
) -> Result<(), String> {
    let params = &event["params"];
    with_entry(app, project, domain, conversation, |entry| {
        entry.validate(params["threadId"].as_str().ok_or("工具线程缺失。")?)?;
        if entry.active_turn.as_deref() != params["turnId"].as_str() || entry.lease.is_none() {
            return Err("工具任务已经结束。".into());
        }
        let result = if matches!(
            decision["decision"].as_str(),
            Some("accept" | "acceptForSession")
        ) {
            operate(
                &app.state::<AppState>().storage,
                project,
                "scientify_write_note",
                &params["arguments"],
            )
        } else {
            Err("用户拒绝了本次笔记修改。".into())
        };
        let success = result.is_ok();
        let text = result
            .unwrap_or_else(|error| json!({"error":error}))
            .to_string();
        entry.session.respond(
            &event["id"],
            json!({"success":success,"contentItems":[{"type":"inputText","text":text}]}),
        )?;
        if success {
            let _ = app.emit("notes-changed", json!({"projectId":project}));
        }
        if decision["decision"] == "cancel" {
            entry.session.call(
                "turn/interrupt",
                json!({"threadId":entry.handle.thread_id,"turnId":entry.active_turn}),
                HANDSHAKE_BUDGET,
            )?;
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn note_tools_reject_other_projects_and_stale_versions() {
        let temp = tempfile::tempdir().unwrap();
        let storage = scientify_core::storage::Storage::open(temp.path().join("data")).unwrap();
        let mut data = scientify_core::workspace::empty();
        let now = scientify_core::workspace::now();
        data["projects"] =
            json!([{"id":"p","name":"P","question":"","createdAt":now,"updatedAt":now}]);
        data["records"] = json!([{"id":"n","project":"p","title":"Note","body":"old","type":"note","status":"draft","createdAt":now,"updatedAt":now}]);
        data["revision"] = json!(1);
        storage.save(data, 0).unwrap();
        assert!(operate(&storage, "other", "scientify_read_note", &json!({"id":"n"})).is_err());
        let read = operate(&storage, "p", "scientify_read_note", &json!({"id":"n"})).unwrap();
        let args = json!({"id":"n","title":"Updated","body":"# Heading\n\n$A_b$\n\n![figure](images/a.png)","expectedVersion":read["version"]});
        assert!(operate(&storage, "p", "scientify_write_note", &args).is_ok());
        assert!(operate(&storage, "p", "scientify_write_note", &args).is_err());
        assert_eq!(
            operate(&storage, "p", "scientify_read_note", &json!({"id":"n"})).unwrap()["body"],
            args["body"]
        );
    }
}
