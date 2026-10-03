use serde_json::{json, Value};
use std::collections::HashSet;

pub const MAX_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_ITEMS: usize = 50_000;
pub const MAX_REVISION: u64 = 9_007_199_254_740_991;

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

pub fn empty() -> Value {
    json!({"schema":3,"revision":0,"updatedAt":now(),"teams":[],"projects":[],"papers":[],
        "records":[],"experiments":[],"runs":[],"tasks":[],"sessions":[],"subscriptions":[],"trash":[],
        "recent":[],"activity":[],"settings":{"theme":"system","name":"",
        "model":{"endpoint":"http://127.0.0.1:11434","model":""}},
        "navigation":{"tabs":["home"],"active":"home","expanded":[],"panel":null}})
}

fn id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}

fn color_valid(value: &Value) -> bool {
    value.as_str().is_some_and(|s| {
        s.len() == 7 && s.starts_with('#') && s.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
    })
}

fn array<'a>(data: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    data[key]
        .as_array()
        .filter(|a| a.len() <= MAX_ITEMS)
        .ok_or_else(|| format!("工作区中的 {key} 数据不完整或过多。"))
}

fn strings(items: &[Value], fields: &[&str]) -> Result<(), String> {
    for item in items {
        for field in fields {
            if !item[*field].is_string() {
                return Err(format!("工作区包含无效的文本字段：{field}"));
            }
        }
    }
    Ok(())
}

/// Normalize schema 3 without discarding fields from features not migrated yet.
pub fn validate(mut data: Value) -> Result<Value, String> {
    if data["schema"] != 3 {
        return Err("这不是受支持的 Scientify 工作区文件。".into());
    }
    if !data.is_object() {
        return Err("工作区格式无效。".into());
    }
    normalize_experiments(&mut data)?;
    for key in [
        "projects",
        "experiments",
        "papers",
        "records",
        "runs",
        "tasks",
        "sessions",
        "subscriptions",
    ] {
        let mut ids = HashSet::new();
        for item in array(&data, key)? {
            let id = item["id"]
                .as_str()
                .filter(|s| id_valid(s))
                .ok_or("记录标识无效。")?;
            if !ids.insert(id) {
                return Err("工作区包含重复的记录标识。".into());
            }
        }
    }
    let project_ids: HashSet<&str> = array(&data, "projects")?
        .iter()
        .filter_map(|p| p["id"].as_str())
        .collect();
    for key in ["experiments", "records", "runs", "tasks", "sessions"] {
        for item in array(&data, key)? {
            if !item["project"].as_str().is_some_and(|id| {
                project_ids.contains(id)
                    || (id == "__inbox__" && matches!(key, "records" | "sessions"))
            }) {
                return Err("部分记录的所属项目不存在。".into());
            }
        }
    }
    let mut default_projects = HashSet::new();
    for experiment in array(&data, "experiments")? {
        if !experiment["name"]
            .as_str()
            .is_some_and(|s| !s.trim().is_empty() && s.len() <= 200)
            || !experiment["purpose"].is_string()
            || !experiment["root"].is_string()
            || !matches!(
                experiment["source"].as_str(),
                Some("project" | "existing" | "empty")
            )
            || (experiment["source"] != "project" && experiment["root"].as_str() == Some(""))
            || !experiment["createdAt"].is_string()
            || !experiment["updatedAt"].is_string()
        {
            return Err("实验信息或代码目录无效。".into());
        }
        if experiment["source"] == "project"
            && (experiment["root"] != ""
                || !default_projects.insert(experiment["project"].as_str().unwrap()))
        {
            return Err("项目只能有一个继承项目目录的默认实验。".into());
        }
        if let Some(python) = experiment.get("python").filter(|v| !v.is_null()) {
            if !python.is_object()
                || ["executable", "prefix", "version", "manager"]
                    .iter()
                    .any(|field| {
                        !python[*field].as_str().is_some_and(|value| {
                            !value.is_empty() && value.len() <= 4096 && !value.contains('\0')
                        })
                    })
                || !matches!(
                    python["manager"].as_str(),
                    Some("system" | "venv" | "conda")
                )
            {
                return Err("Python 环境绑定无效。".into());
            }
        }
    }
    for paper in array(&data, "papers")? {
        let projects = paper["projects"]
            .as_array()
            .ok_or("文献的项目归属不完整。")?;
        if projects
            .iter()
            .any(|p| !p.as_str().is_some_and(|id| project_ids.contains(id)))
        {
            return Err("文献的项目归属不完整。".into());
        }
        if !paper["tags"]
            .as_array()
            .is_some_and(|tags| tags.iter().all(Value::is_string))
            || !paper["quotes"].as_array().is_some_and(|quotes| {
                quotes.iter().all(|q| {
                    q["text"].is_string()
                        && q["page"].is_i64()
                        && q["id"].as_str().is_some_and(|s| !s.is_empty())
                })
            })
        {
            return Err("文献笔记或摘录格式无效。".into());
        }
    }
    for run in array(&data, "runs")? {
        for metric in run["metrics"].as_array().ok_or("实验指标格式不正确。")? {
            if !metric["name"]
                .as_str()
                .is_some_and(|n| !n.trim().is_empty())
                || !(metric["value"].is_null()
                    || metric["value"].as_f64().is_some_and(f64::is_finite))
            {
                return Err("实验指标包含无效数值。".into());
            }
        }
    }
    for session in array(&data, "sessions")? {
        if !session["context"].is_array() {
            return Err("对话上下文格式无效。".into());
        }
        for message in session["messages"].as_array().ok_or("对话格式无效。")? {
            if !matches!(message["role"].as_str(), Some("user" | "assistant"))
                || !message["text"].is_string()
            {
                return Err("对话内容无效。".into());
            }
        }
    }
    if data.get("teams").is_none_or(Value::is_null) {
        data["teams"] = json!([]);
    }
    let mut team_ids = HashSet::new();
    for team in array(&data, "teams")? {
        let id = team["id"]
            .as_str()
            .filter(|s| id_valid(s) && *s != "personal")
            .ok_or("团队标识无效。")?;
        if !team_ids.insert(id) || !team["name"].as_str().is_some_and(|s| !s.trim().is_empty()) {
            return Err("团队信息无效。".into());
        }
    }
    for p in array(&data, "projects")? {
        if let Some(space) = p.get("space").filter(|s| !s.is_null() && **s != "") {
            if !space
                .as_str()
                .is_some_and(|s| s == "personal" || team_ids.contains(s))
            {
                return Err("项目所属团队不存在。".into());
            }
        }
    }
    let defaults = empty();
    for (key, value) in defaults.as_object().unwrap() {
        if data.get(key).is_none() {
            data[key] = value.clone();
        }
    }
    if !data["revision"].as_u64().is_some_and(|r| r <= MAX_REVISION) {
        return Err("工作区版本信息无效。".into());
    }
    for key in ["trash", "recent", "activity"] {
        if !data[key].is_array() {
            data[key] = json!([]);
        }
    }
    for key in ["settings", "navigation"] {
        if !data[key].is_object() {
            return Err(format!("工作区 {key} 格式无效。"));
        }
        for (field, value) in defaults[key].as_object().unwrap() {
            if data[key].get(field).is_none() {
                data[key][field] = value.clone();
            }
        }
    }
    if !data["settings"]["model"].is_object() {
        return Err("模型设置格式无效。".into());
    }
    for (key, value) in defaults["settings"]["model"].as_object().unwrap() {
        if data["settings"]["model"].get(key).is_none() {
            data["settings"]["model"][key] = value.clone();
        }
    }
    if !data["settings"]["name"].is_string()
        || !data["settings"]["model"]["endpoint"].is_string()
        || !data["settings"]["model"]["model"].is_string()
    {
        return Err("工作区设置格式无效。".into());
    }
    if !data["navigation"]["tabs"]
        .as_array()
        .is_some_and(|a| a.iter().all(Value::is_string))
        || !data["navigation"]["expanded"].is_array()
    {
        return Err("工作区导航格式无效。".into());
    }
    for recent in array(&data, "recent")? {
        if !recent["key"].is_string() {
            return Err("最近访问格式无效。".into());
        }
    }
    for entry in array(&data, "trash")? {
        if !matches!(
            entry["collection"].as_str(),
            Some("records" | "papers" | "runs" | "sessions")
        ) || !entry["value"]["id"].as_str().is_some_and(id_valid)
        {
            return Err("回收站数据无效。".into());
        }
    }
    for (key, fields) in [
        ("projects", &["name", "question", "createdAt"][..]),
        (
            "records",
            &["title", "body", "type", "status", "createdAt", "updatedAt"][..],
        ),
        ("papers", &["title", "authors", "note", "status"][..]),
        (
            "runs",
            &[
                "name",
                "protocol",
                "conclusion",
                "config",
                "status",
                "updatedAt",
            ][..],
        ),
        ("tasks", &["title"][..]),
        ("sessions", &["title", "updatedAt"][..]),
        ("subscriptions", &["keyword", "category"][..]),
    ] {
        strings(array(&data, key)?, fields)?;
    }
    for project in data["projects"].as_array_mut().unwrap() {
        if project.get("space").is_none_or(|v| v.is_null() || v == "") {
            project["space"] = json!("personal");
        }
        if project
            .get("color")
            .is_some_and(|v| !v.is_null() && v != "" && !color_valid(v))
        {
            project["color"] = json!("#738c80");
        }
    }
    for team in data["teams"].as_array_mut().unwrap() {
        if !color_valid(&team["color"]) {
            team["color"] = json!("#657b71");
        }
    }
    Ok(data)
}

fn normalize_experiments(data: &mut Value) -> Result<(), String> {
    if data.get("experiments").is_none_or(Value::is_null) {
        data["experiments"] = json!([]);
    }
    array(data, "experiments")?;
    let projects = array(data, "projects")?.clone();
    for project in &projects {
        if project["experimentsInitialized"] == true {
            continue;
        }
        let id = project["id"].as_str().ok_or("项目标识无效。")?;
        if !data["experiments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["project"] == id)
        {
            if data["experiments"]
                .as_array()
                .unwrap()
                .iter()
                .any(|e| e["id"] == id)
            {
                return Err("默认实验标识冲突。".into());
            }
            data["experiments"].as_array_mut().unwrap().push(json!({
                "id":id,"project":id,"name":"默认实验","purpose":"","root":"","source":"project",
                "createdAt":project["createdAt"],
                "updatedAt":project.get("updatedAt").filter(|v| v.is_string()).unwrap_or(&project["createdAt"]),
                "runConfigurations":project.get("runConfigurations").cloned().unwrap_or(json!([]))
            }));
            for run in data["runs"].as_array_mut().ok_or("运行数据无效。")? {
                if run["project"] == id && run.get("experimentId").is_none_or(Value::is_null) {
                    run["experimentId"] = json!(id);
                }
            }
        }
    }
    for project in data["projects"].as_array_mut().unwrap() {
        project["experimentsInitialized"] = json!(true);
    }
    Ok(())
}

pub fn parse(bytes: &[u8]) -> Result<Value, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("工作区超过 64 MiB。".into());
    }
    validate(serde_json::from_slice(bytes).map_err(|e| format!("工作区 JSON 无法读取：{e}"))?)
}
