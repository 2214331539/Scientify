//! The project's documents for the agent. Pages are read and written by the window, in their own
//! format (`crate::docs::ask_window`); writes pass through approval in ask mode, like notes did.
use super::*;

pub fn specifications() -> Vec<Value> {
    [
        ("scientify_list_docs", "List this project's documents (the team knowledge base that replaced project notes): page id, title, path in the page tree and last update. Paper notes are not documents; they stay as .notes.md files beside the PDFs.", json!({}), vec![]),
        ("scientify_read_doc", "Read one document as Markdown. Each top-level block is preceded by <!-- block:ID -->, so single blocks can be edited with scientify_update_doc. Returns a version token that the update must pass back.", json!({"id":{"type":"string"}}), vec!["id"]),
        ("scientify_create_doc", "Create a document page from Markdown, optionally under a parent page id from scientify_list_docs. [[Page title]] links to another page. Use for summaries, reports or minutes the user asked to keep. Ask mode requires user approval; full mode writes directly. Returns the new page id.", json!({"title":{"type":"string"},"markdown":{"type":"string"},"parent":{"type":"string"}}), vec!["title","markdown"]),
        ("scientify_update_doc", "Edit a document by blocks. operations is a list of {op, block, markdown}: op is replace, insertAfter, insertBefore or delete (block is an id from scientify_read_doc), or append (adds markdown at the end, no block). title optionally renames the page. Pass expectedVersion from scientify_read_doc; if the page changed meanwhile, read it again. Ask mode requires user approval.",
            json!({"id":{"type":"string"},"expectedVersion":{"type":"string"},"title":{"type":"string"},
                "operations":{"type":"array","items":{"type":"object","properties":{"op":{"type":"string","enum":["replace","insertAfter","insertBefore","delete","append"]},"block":{"type":"string"},"markdown":{"type":"string"}},"required":["op"],"additionalProperties":false}}}),
            vec!["id","expectedVersion","operations"]),
    ]
    .into_iter()
    .map(|(name, description, properties, required)| json!({"type":"function","name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}}))
    .collect()
}

pub fn handles(tool: &str) -> bool {
    matches!(
        tool,
        "scientify_list_docs"
            | "scientify_read_doc"
            | "scientify_create_doc"
            | "scientify_update_doc"
    )
}
/// Tools that change documents and so pass through approval in ask mode.
pub fn writes(tool: &Value) -> bool {
    matches!(
        tool.as_str(),
        Some("scientify_create_doc" | "scientify_update_doc")
    )
}

pub fn operate<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    project: &str,
    tool: &str,
    args: &Value,
) -> Result<Value, String> {
    if project == INBOX {
        return Err("收集箱里的对话没有项目文档。".into());
    }
    if writes(&json!(tool)) {
        crate::collaboration::permissions::require_write(
            &app.state::<AppState>().storage,
            project,
            "doc",
        )?;
    }
    crate::docs::ask_window(app, project, tool, args)
}

/// What the approval card shows: the page title and the Markdown that will be written.
fn preview(args: &Value) -> String {
    if let Some(markdown) = args["markdown"].as_str() {
        return markdown.to_owned();
    }
    args["operations"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|op| {
            let what = match op["op"].as_str().unwrap_or_default() {
                "replace" => "替换",
                "insertAfter" => "在后面插入",
                "insertBefore" => "在前面插入",
                "delete" => "删除",
                "append" => "追加到末尾",
                other => other,
            };
            let block = op["block"]
                .as_str()
                .map(|b| format!(" {b}"))
                .unwrap_or_default();
            format!(
                "【{what}{block}】\n{}",
                op["markdown"].as_str().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
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
        let id = json!(format!("scientify-doc:{}", uuid::Uuid::new_v4()));
        let create = params["tool"] == "scientify_create_doc";
        let title = params["arguments"]["title"]
            .as_str()
            .or(params["arguments"]["id"].as_str())
            .unwrap_or_default();
        let approval = json!({"kind":"request","method":"scientify/docs/requestApproval","id":id,
            "params":{"threadId":entry.handle.thread_id,"turnId":entry.active_turn,
                "action": if create { "create" } else { "update" },
                "command": title, "reason": preview(&params["arguments"])}});
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
    let accepted = matches!(
        decision["decision"].as_str(),
        Some("accept" | "acceptForSession")
    );
    // The window does the write; the conversation lock is not held while it answers.
    let result = if accepted {
        operate(
            app,
            project,
            params["tool"].as_str().unwrap_or_default(),
            &params["arguments"],
        )
    } else if params["tool"] == "scientify_create_doc" {
        Err("用户拒绝了新建这页文档。".into())
    } else {
        Err("用户拒绝了本次文档修改。".into())
    };
    with_entry(app, project, domain, conversation, |entry| {
        entry.validate(params["threadId"].as_str().ok_or("工具线程缺失。")?)?;
        if entry.active_turn.as_deref() != params["turnId"].as_str() {
            return Err("工具任务已经结束。".into());
        }
        let success = result.is_ok();
        let text = match &result {
            Ok(value) => value.to_string(),
            Err(error) => json!({"error":error}).to_string(),
        };
        entry.session.respond(
            &event["id"],
            json!({"success":success,"contentItems":[{"type":"inputText","text":text}]}),
        )?;
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
    fn writes_need_approval_and_previews_show_what_changes() {
        assert!(writes(&json!("scientify_create_doc")));
        assert!(writes(&json!("scientify_update_doc")));
        assert!(!writes(&json!("scientify_read_doc")));
        assert!(handles("scientify_list_docs") && !handles("scientify_list_notes"));
        let text = preview(&json!({"operations":[
            {"op":"replace","block":"b1","markdown":"新的一段"},
            {"op":"append","markdown":"- 待办"}]}));
        assert!(text.contains("【替换 b1】\n新的一段"));
        assert!(text.contains("【追加到末尾】\n- 待办"));
        let names: Vec<_> = specifications()
            .iter()
            .map(|s| s["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names.len(), 4);
    }
}
