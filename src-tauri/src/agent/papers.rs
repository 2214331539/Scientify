//! Read-only paper tools. Native identity authorizes bytes; the app's PDF.js worker extracts text.
use super::*;
use scientify_core::library::{Entry, PaperSource};
use std::sync::mpsc;
use std::time::Instant;

#[derive(Default)]
pub struct PaperState {
    inner: Mutex<Inner>,
}
#[derive(Default)]
struct Inner {
    ready: HashMap<String, String>,
    pending: HashMap<String, Pending>,
    listings: HashMap<String, Listing>,
}
struct Pending {
    owner: String,
    handle: ThreadHandle,
    source: PaperSource,
    job: Value,
    sender: mpsc::Sender<Result<Value, String>>,
    deadline: Instant,
}
struct Listing {
    project: String,
    conversation: String,
    root: String,
    directory: String,
    entries: Vec<Entry>,
    created: Instant,
}

impl PaperState {
    pub fn close_owner(&self, owner: &str) {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.ready.remove(owner);
        inner.pending.retain(|_, pending| pending.owner != owner);
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ListArgs {
    directory: Option<String>,
    cursor: Option<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadArgs {
    path: String,
    #[serde(default = "first_page")]
    page: usize,
    #[serde(default)]
    offset: usize,
    page_count: Option<usize>,
    query: Option<String>,
    expected_version: Option<String>,
}
fn first_page() -> usize {
    1
}

pub fn specifications() -> Vec<Value> {
    let read = json!({"path":{"type":"string"},"page":{"type":"integer","minimum":1},"offset":{"type":"integer","minimum":0},"pageCount":{"type":"integer","minimum":1,"maximum":8},"expectedVersion":{"type":"string"}});
    let mut search = read.clone();
    search["pageCount"]["maximum"] = json!(20);
    search["query"] = json!({"type":"string","minLength":1,"maxLength":200});
    [
        ("scientify_list_papers", "List actual PDFs in this conversation's literature directory without opening papers, creating bindings, notes, or text files. Up to 100 per response. Continue with the returned cursor. Omit directory to list the root.", json!({"directory":{"type":"string"},"cursor":{"type":"string"}}), json!([])),
        ("scientify_read_paper", "Read PDF text directly, without intermediate files. Reads up to 8 pages/24000 characters. Pages are 1-based; offsets are JavaScript string indices. Continue with nextCursor page/offset and expectedVersion. Report failures honestly; do not fall back to shell conversions. Answer the question without adding page/source lists unless requested.", read, json!(["path"])),
        ("scientify_search_paper", "Search PDF text, case-insensitive literal matching, without files. Up to 20 pages and 20 bounded matches per call. Continue using nextCursor and expectedVersion. searchedPages is the actual scope; no matches in a partial scope is not a whole-document absence. emptyPages may be scanned pages without extractable text.", search, json!(["path","query"])),
    ].into_iter().map(|(name, description, properties, required)| json!({"type":"function","name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":required,"additionalProperties":false}})).collect()
}

fn root<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    handle: &ThreadHandle,
) -> Result<PathBuf, String> {
    if handle.domain != "literature" {
        return Err("论文工具仅在绑定文献目录的会话中可用。".into());
    }
    let current = app
        .state::<crate::library::LibraryState>()
        .service
        .root(&handle.project_id)?
        .ok_or("文献目录不可用。")?;
    if current != std::path::Path::new(&handle.cwd) {
        return Err("文献目录已变化，请新建会话。".into());
    }
    Ok(current)
}

pub(crate) fn operate<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    owner: &str,
    handle: &ThreadHandle,
    params: &Value,
    cancelled: impl Fn() -> bool,
) -> Result<Value, String> {
    let directory = root(app, handle)?;
    if cancelled() {
        return Err("论文任务已中止。".into());
    }
    let tool = params["tool"].as_str().ok_or("论文工具名称缺失。")?;
    let state = app.state::<PaperState>();
    if tool == "scientify_list_papers" {
        let args: ListArgs =
            serde_json::from_value(params["arguments"].clone()).map_err(|e| e.to_string())?;
        return list(app, &state, handle, &directory, args);
    }
    if !matches!(tool, "scientify_read_paper" | "scientify_search_paper") {
        return Err("未知论文工具。".into());
    }
    let args: ReadArgs =
        serde_json::from_value(params["arguments"].clone()).map_err(|e| e.to_string())?;
    let search = tool == "scientify_search_paper";
    let page_count = args.page_count.unwrap_or(if search { 20 } else { 8 });
    let query = args.query.unwrap_or_default();
    if args.page == 0
        || args.page > 100000
        || args.offset > 100000000
        || page_count == 0
        || page_count > if search { 20 } else { 8 }
        || (search && (query.trim().is_empty() || query.chars().count() > 200))
    {
        return Err("论文页段或搜索参数无效。".into());
    }
    let source = app
        .state::<crate::library::LibraryState>()
        .service
        .paper_source(&handle.project_id, &directory, &args.path)?;
    if args
        .expected_version
        .as_ref()
        .is_some_and(|v| v != &source.version)
    {
        return Err("document_changed：PDF 已变化，请重新读取。".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let job = json!({"id":id,"projectId":handle.project_id,"root":handle.cwd,"path":source.path,"version":source.version,"operation":if search {"search"} else {"read"},"page":args.page,"offset":args.offset,"pageCount":page_count,"query":query});
    let (sender, receiver) = mpsc::channel();
    let deadline = Instant::now() + Duration::from_secs(30);
    {
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        if !inner.ready.contains_key(owner) {
            return Err("论文解析服务尚未就绪，请稍后重试。".into());
        }
        if inner.pending.len() >= 8 {
            return Err("论文读取繁忙，请稍后重试。".into());
        }
        inner.pending.insert(
            id.clone(),
            Pending {
                owner: owner.into(),
                handle: handle.clone(),
                source,
                job: job.clone(),
                sender,
                deadline,
            },
        );
    }
    let outcome = (|| {
        app.emit_to(owner, "agent-paper-request", job)
            .map_err(|e| e.to_string())?;
        loop {
            if cancelled() {
                return Err("论文任务已中止。".into());
            }
            match receiver.recv_timeout(Duration::from_millis(100)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("论文解析服务已关闭。".into())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    if Instant::now() >= deadline {
                        return Err("论文读取超时，请缩小页段后重试。".into());
                    }
                }
            }
        }
    })();
    state
        .inner
        .lock()
        .map_err(|e| e.to_string())?
        .pending
        .remove(&id);
    if outcome.is_err() {
        let _ = app.emit_to(owner, "agent-paper-request", json!({"id":id,"cancel":true}));
    }
    outcome
}

fn list<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    state: &PaperState,
    handle: &ThreadHandle,
    root: &std::path::Path,
    args: ListArgs,
) -> Result<Value, String> {
    let (id, offset) = if let Some(cursor) = args.cursor {
        let (id, offset) = cursor.split_once(':').ok_or("论文清单继续位置无效。")?;
        (
            id.to_string(),
            offset
                .parse::<usize>()
                .map_err(|_| "论文清单继续位置无效。")?,
        )
    } else {
        let directory = args.directory.clone().unwrap_or_else(|| ".".into());
        let entries = app.state::<crate::library::LibraryState>().service.papers(
            &handle.project_id,
            root,
            &directory,
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
        inner
            .listings
            .retain(|_, v| v.created.elapsed() < Duration::from_secs(60));
        if inner.listings.len() >= 8 {
            return Err("论文清单请求过多，请稍后重试。".into());
        }
        inner.listings.insert(
            id.clone(),
            Listing {
                project: handle.project_id.clone(),
                conversation: handle.conversation_id.clone(),
                root: handle.cwd.clone(),
                directory,
                entries,
                created: Instant::now(),
            },
        );
        (id, 0)
    };
    let inner = state.inner.lock().map_err(|e| e.to_string())?;
    let listing = inner
        .listings
        .get(&id)
        .ok_or("论文清单已失效，请重新列举。")?;
    if listing.created.elapsed() >= Duration::from_secs(60)
        || listing.project != handle.project_id
        || listing.conversation != handle.conversation_id
        || listing.root != handle.cwd
        || args.directory.is_some_and(|d| d != listing.directory)
        || offset > listing.entries.len()
    {
        return Err("论文清单已失效或不属于当前会话，请重新列举。".into());
    }
    let end = (offset + 100).min(listing.entries.len());
    Ok(
        json!({"papers":listing.entries[offset..end],"total":listing.entries.len(),"complete":end==listing.entries.len(),"nextCursor":if end < listing.entries.len() {Some(format!("{id}:{end}"))} else {None}}),
    )
}

#[tauri::command]
pub fn agent_paper_ready<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
) -> Result<String, String> {
    crate::library::trusted(&view)?;
    let id = uuid::Uuid::new_v4().to_string();
    let state = app.state::<PaperState>();
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let owner = view.window().label().to_string();
    inner.pending.retain(|_, p| p.owner != owner);
    inner.ready.insert(owner, id.clone());
    Ok(id)
}

#[tauri::command]
pub fn agent_paper_stop<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    service_id: String,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    let state = app.state::<PaperState>();
    let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
    let owner = view.window().label().to_string();
    if inner.ready.get(&owner) == Some(&service_id) {
        inner.ready.remove(&owner);
        inner.pending.retain(|_, p| p.owner != owner);
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_paper_source<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    request_id: String,
) -> Result<tauri::ipc::Response, String> {
    crate::library::trusted(&view)?;
    let owner = view.window().label().to_string();
    blocking(move || {
        let state = app.state::<PaperState>();
        let (handle, source) = {
            let inner = state.inner.lock().map_err(|e| e.to_string())?;
            let pending = authorized(&inner, &owner, &request_id)?;
            (pending.handle.clone(), pending.source.clone())
        };
        let bytes = app
            .state::<crate::library::LibraryState>()
            .service
            .paper_bytes(
                &handle.project_id,
                &root(&app, &handle)?,
                &source.path,
                &source.version,
            )?;
        {
            let inner = state.inner.lock().map_err(|e| e.to_string())?;
            authorized(&inner, &owner, &request_id)?;
        }
        Ok(tauri::ipc::Response::new(bytes))
    })
    .await
}

fn authorized<'a>(inner: &'a Inner, owner: &str, id: &str) -> Result<&'a Pending, String> {
    inner
        .pending
        .get(id)
        .filter(|p| p.owner == owner && Instant::now() < p.deadline)
        .ok_or("论文请求已取消、过期或不属于此窗口。".into())
}

#[tauri::command]
pub async fn agent_paper_complete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    request_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    let owner = view.window().label().to_string();
    blocking(move || {
        let state = app.state::<PaperState>();
        let pending = {
            let mut inner = state.inner.lock().map_err(|e| e.to_string())?;
            authorized(&inner, &owner, &request_id)?;
            inner.pending.remove(&request_id).unwrap()
        };
        let outcome = (|| {
            let mut result = match (result, error) {
                (None, Some(error)) => return Err(error.chars().take(2000).collect()),
                (Some(result), None) => result,
                _ => return Err("论文工具回传格式无效。".into()),
            };
            validate_result(&result, &pending.job)?;
            let current = app
                .state::<crate::library::LibraryState>()
                .service
                .paper_source(
                    &pending.handle.project_id,
                    &root(&app, &pending.handle)?,
                    &pending.source.path,
                )?;
            if current.version != pending.source.version {
                return Err("document_changed：PDF 在解析期间发生变化，请重新读取。".into());
            }
            result["path"] = json!(pending.source.path);
            result["version"] = json!(pending.source.version);
            Ok(result)
        })();
        pending
            .sender
            .send(outcome)
            .map_err(|_| "论文任务已结束。".to_string())
    })
    .await
}

fn validate_result(result: &Value, job: &Value) -> Result<(), String> {
    if !result.is_object()
        || result.to_string().len() > 200000
        || result["totalPages"]
            .as_u64()
            .is_none_or(|n| n == 0 || n > 100000)
        || !result["truncated"].is_boolean()
    {
        return Err("论文解析结果格式或大小无效。".into());
    }
    let start = job["page"].as_u64().unwrap();
    let count = job["pageCount"].as_u64().unwrap();
    let total = result["totalPages"].as_u64().unwrap();
    let end = (start + count - 1).min(total);
    let in_range = |item: &Value| {
        item["page"]
            .as_u64()
            .is_some_and(|n| n >= start && n <= end)
    };
    if start > total || result["truncated"] != json!(!result["nextCursor"].is_null()) {
        return Err("论文继续位置无效。".into());
    }
    if !result["nextCursor"].is_null()
        && (result["nextCursor"]["page"]
            .as_u64()
            .is_none_or(|n| n < start || n > total || n > end + 1)
            || result["nextCursor"]["offset"]
                .as_u64()
                .is_none_or(|n| n > 100000000))
    {
        return Err("论文继续位置超出范围。".into());
    }
    if job["operation"] == "read" {
        let pages = result["pages"].as_array().ok_or("论文正文缺失。")?;
        if pages.is_empty()
            || pages.len() > count as usize
            || pages.iter().any(|p| !in_range(p) || !p["text"].is_string())
            || pages
                .iter()
                .map(|p| p["text"].as_str().unwrap().encode_utf16().count())
                .sum::<usize>()
                > 24000
        {
            return Err("论文正文超出本次请求范围。".into());
        }
        for (index, page) in pages.iter().enumerate() {
            let offset = if index == 0 {
                job["offset"].as_u64().unwrap()
            } else {
                0
            };
            if page["page"] != json!(start + index as u64)
                || page["startOffset"] != json!(offset)
                || !page["truncated"].is_boolean()
            {
                return Err("论文页段或偏移不匹配。".into());
            }
        }
    } else {
        let hits = result["matches"].as_array().ok_or("论文搜索结果缺失。")?;
        if hits.len() > 20
            || hits.iter().any(|p| {
                !in_range(p)
                    || p["text"]
                        .as_str()
                        .is_none_or(|s| s.encode_utf16().count() > 500)
            })
        {
            return Err("论文搜索结果超出本次请求范围。".into());
        }
        let searched = result["searchedPages"]
            .as_array()
            .ok_or("实际搜索范围缺失。")?;
        if searched.is_empty()
            || searched.len() > count as usize
            || searched
                .iter()
                .enumerate()
                .any(|(i, page)| *page != json!(start + i as u64) || page.as_u64().unwrap() > end)
            || hits.iter().any(|hit| {
                !searched.contains(&hit["page"])
                    || hit["offset"].as_u64().is_none_or(|n| n > 100000000)
            })
        {
            return Err("实际搜索范围不匹配。".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ipc_smoke::invoke;
    use tauri::test::MockRuntime;

    fn origin() -> &'static str {
        if cfg!(feature = "custom-protocol") {
            "http://tauri.localhost"
        } else {
            "http://127.0.0.1:1420"
        }
    }
    fn fixture() -> (
        tempfile::TempDir,
        tauri::App<MockRuntime>,
        tauri::WebviewWindow<MockRuntime>,
        ThreadHandle,
    ) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("papers");
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.pdf"), b"%PDF-1.4 fixture text").unwrap();
        let library = crate::library::LibraryState::new(temp.path().join("data"));
        library.service.mount("p1", &root).unwrap();
        let root = root.canonicalize().unwrap();
        let app = tauri::test::mock_builder()
            .manage(library)
            .manage(PaperState::default())
            .invoke_handler(tauri::generate_handler![
                agent_paper_ready,
                agent_paper_stop,
                agent_paper_source,
                agent_paper_complete
            ])
            .build(tauri::generate_context!())
            .unwrap();
        let view = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
            .build()
            .unwrap();
        invoke(&view, "agent_paper_ready", json!({}), origin()).unwrap();
        let handle = ThreadHandle {
            paper_tools: true,
            browser_tools: true,
            experiment_id: None,
            thread_id: "thread1".into(),
            conversation_id: "chat1".into(),
            domain: "literature".into(),
            project_id: "p1".into(),
            cwd: root.display().to_string(),
            model: "fixture-model".into(),
            model_provider: "scientify".into(),
            instruction_sources: vec![],
            sandbox: "workspaceWrite".into(),
            turns: vec![],
            active_turn_id: None,
            fresh_thread: true,
            events: vec![],
        };
        (temp, app, view, handle)
    }
    fn wait_request(app: &tauri::AppHandle<MockRuntime>) -> (String, Value) {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(job) = app
                .state::<PaperState>()
                .inner
                .lock()
                .unwrap()
                .pending
                .iter()
                .next()
                .map(|(id, p)| (id.clone(), p.job.clone()))
            {
                return job;
            }
            assert!(Instant::now() < deadline, "no parser request received");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn read_result() -> Value {
        json!({"totalPages":1,"pages":[{"page":1,"startOffset":0,"text":"fixture text","truncated":false}],"truncated":false,"nextCursor":null})
    }

    #[test]
    fn paper_bridge_obeys_acl_window_ownership_and_stale_result_rules() {
        let (_temp, app, view, handle) = fixture();
        let other = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .unwrap();
        let browser =
            tauri::WebviewWindowBuilder::new(&app, "browser-untrusted", Default::default())
                .build()
                .unwrap();
        for command in [
            "agent_paper_ready",
            "agent_paper_stop",
            "agent_paper_source",
            "agent_paper_complete",
        ] {
            let body = json!({"serviceId":"x","requestId":"x","result":read_result()});
            assert!(
                invoke(&view, command, body.clone(), "https://untrusted.example").is_err(),
                "{command}"
            );
            assert!(
                invoke(&browser, command, body, origin()).is_err(),
                "{command}"
            );
        }
        let native = app.handle().clone();
        let active = handle.clone();
        let reader = std::thread::spawn(move || {
            operate(
                &native,
                "workspace",
                &active,
                &json!({"tool":"scientify_read_paper","arguments":{"path":"a.pdf"}}),
                || false,
            )
        });
        let (id, _) = wait_request(app.handle());
        assert!(invoke(
            &other,
            "agent_paper_source",
            json!({"requestId":id}),
            origin()
        )
        .is_err());
        assert!(invoke(
            &other,
            "agent_paper_complete",
            json!({"requestId":id,"result":read_result()}),
            origin()
        )
        .is_err());
        let bytes = invoke(
            &view,
            "agent_paper_source",
            json!({"requestId":id}),
            origin(),
        )
        .unwrap();
        assert!(
            matches!(bytes, tauri::ipc::InvokeResponseBody::Raw(bytes) if bytes == b"%PDF-1.4 fixture text")
        );
        invoke(
            &view,
            "agent_paper_complete",
            json!({"requestId":id,"result":read_result()}),
            origin(),
        )
        .unwrap();
        let result = reader.join().unwrap().unwrap();
        assert_eq!(result["pages"][0]["text"], "fixture text");
        assert_eq!(result["path"], "a.pdf");
        assert!(result["version"].as_str().unwrap().len() == 64);
        assert!(invoke(
            &view,
            "agent_paper_source",
            json!({"requestId":id}),
            origin()
        )
        .is_err());

        let native = app.handle().clone();
        let active = handle.clone();
        let reader = std::thread::spawn(move || {
            operate(
                &native,
                "workspace",
                &active,
                &json!({"tool":"scientify_read_paper","arguments":{"path":"a.pdf"}}),
                || false,
            )
        });
        let (id, _) = wait_request(app.handle());
        std::fs::write(
            PathBuf::from(&handle.cwd).join("a.pdf"),
            b"%PDF-1.4 changed during extraction",
        )
        .unwrap();
        invoke(
            &view,
            "agent_paper_complete",
            json!({"requestId":id,"result":read_result()}),
            origin(),
        )
        .unwrap();
        assert!(reader
            .join()
            .unwrap()
            .unwrap_err()
            .contains("document_changed"));
    }

    #[test]
    fn cancellation_and_service_shutdown_release_waiters() {
        use std::sync::atomic::{AtomicBool, Ordering};
        let (_temp, app, view, handle) = fixture();
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = cancelled.clone();
        let native = app.handle().clone();
        let active = handle.clone();
        let reader = std::thread::spawn(move || {
            operate(
                &native,
                "workspace",
                &active,
                &json!({"tool":"scientify_read_paper","arguments":{"path":"a.pdf"}}),
                || stop.load(Ordering::SeqCst),
            )
        });
        let (id, _) = wait_request(app.handle());
        cancelled.store(true, Ordering::SeqCst);
        assert!(reader.join().unwrap().unwrap_err().contains("中止"));
        assert!(invoke(
            &view,
            "agent_paper_complete",
            json!({"requestId":id,"result":read_result()}),
            origin()
        )
        .is_err());
        let native = app.handle().clone();
        let reader = std::thread::spawn(move || {
            operate(
                &native,
                "workspace",
                &handle,
                &json!({"tool":"scientify_read_paper","arguments":{"path":"a.pdf"}}),
                || false,
            )
        });
        wait_request(app.handle());
        app.state::<PaperState>().close_owner("workspace");
        assert!(reader.join().unwrap().unwrap_err().contains("关闭"));
        assert!(app
            .state::<PaperState>()
            .inner
            .lock()
            .unwrap()
            .pending
            .is_empty());
    }

    #[test]
    fn listing_cursors_are_scoped_to_the_conversation_and_expire() {
        let (_temp, app, _view, handle) = fixture();
        for i in 0..101 {
            std::fs::write(
                PathBuf::from(&handle.cwd).join(format!("paper{i}.pdf")),
                b"%PDF-1.4",
            )
            .unwrap();
        }
        let request = json!({"tool":"scientify_list_papers","arguments":{}});
        let first = operate(app.handle(), "workspace", &handle, &request, || false).unwrap();
        assert_eq!(first["papers"].as_array().unwrap().len(), 100);
        let request =
            json!({"tool":"scientify_list_papers","arguments":{"cursor":first["nextCursor"]}});
        let mut other = handle.clone();
        other.conversation_id = "other".into();
        assert!(operate(app.handle(), "workspace", &other, &request, || false).is_err());
        let second = operate(app.handle(), "workspace", &handle, &request, || false).unwrap();
        assert_eq!(second["papers"].as_array().unwrap().len(), 2);
        assert_eq!(second["complete"], true);
        for listing in app
            .state::<PaperState>()
            .inner
            .lock()
            .unwrap()
            .listings
            .values_mut()
        {
            listing.created -= Duration::from_secs(61);
        }
        assert!(operate(app.handle(), "workspace", &handle, &request, || false).is_err());
    }

    #[test]
    fn result_bounds_are_checked_before_the_tool_receives_text() {
        let job = json!({"operation":"read","page":1,"offset":0,"pageCount":8});
        assert!(validate_result(&read_result(), &job).is_ok());
        let mut bad = read_result();
        bad["pages"][0]["page"] = json!(2);
        assert!(validate_result(&bad, &job).is_err());
        bad = read_result();
        bad["pages"][0]["text"] = json!("x".repeat(24001));
        assert!(validate_result(&bad, &job).is_err());
        bad = read_result();
        bad["truncated"] = json!(true);
        assert!(validate_result(&bad, &job).is_err());
        let search = json!({"totalPages":30,"matches":[],"searchedPages":[1,2],"truncated":true,"nextCursor":{"page":3,"offset":0}});
        let job = json!({"operation":"search","page":1,"offset":0,"pageCount":20});
        assert!(validate_result(&search, &job).is_ok());
        let mut bad = search;
        bad["searchedPages"] = json!([2]);
        assert!(validate_result(&bad, &job).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn real_codex_paper_tools_return_host_results_without_writing_the_library() {
        use std::os::windows::process::CommandExt;
        use std::{
            io::{BufRead, BufReader},
            process::{Command, Stdio},
        };
        struct Provider(std::process::Child);
        impl Drop for Provider {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let (temp, app, view, handle) = fixture();
        let root = PathBuf::from(&handle.cwd);
        let original = std::fs::read(root.join("a.pdf")).unwrap();
        let before = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        for (tool, arguments) in [
            ("scientify_list_papers", json!({})),
            ("scientify_read_paper", json!({"path":"a.pdf"})),
            (
                "scientify_search_paper",
                json!({"path":"a.pdf","query":"fixture"}),
            ),
        ] {
            let mut command = Command::new("node");
            command
                .args([
                    "--input-type=module",
                    "-e",
                    include_str!("../../../scripts/fixtures/experiment-provider.mjs"),
                ])
                .env("SCIENTIFY_FIXTURE_TOOL", tool)
                .env("SCIENTIFY_FIXTURE_COMMAND", arguments.to_string())
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::inherit())
                .creation_flags(windows_sys::Win32::System::Threading::CREATE_NO_WINDOW);
            let mut provider = Provider(command.spawn().unwrap());
            let mut endpoint = String::new();
            BufReader::new(provider.0.stdout.take().unwrap())
                .read_line(&mut endpoint)
                .unwrap();
            let connection = config::Connection {
                endpoint: endpoint.trim(),
                model: "fixture-model",
                provider: "openai",
                api_key: Some("fixture-key"),
            };
            let args = config::arguments(&connection).unwrap();
            let home = temp.path().join(tool);
            std::fs::create_dir(&home).unwrap();
            let mut session = EngineSession::start_with_events(
                &process::engine_path().unwrap(),
                &args.iter().map(String::as_str).collect::<Vec<_>>(),
                &home,
                &root,
                &config::environment(&connection),
                None,
            )
            .unwrap();
            let thread = session.call("thread/start", json!({"cwd":root,"model":"fixture-model","modelProvider":"scientify","sandbox":"workspace-write","approvalPolicy":"on-request","dynamicTools":specifications(),"developerInstructions":tools::instructions("literature",false,false,true)}), THREAD_BUDGET).unwrap();
            let turn = session.call("turn/start", json!({"threadId":thread["thread"]["id"],"input":[{"type":"text","text":"read the paper","text_elements":[]}]}), TURN_BUDGET).unwrap();
            let deadline = Instant::now() + Duration::from_secs(30);
            let mut called = false;
            'turn: loop {
                assert!(
                    Instant::now() < deadline,
                    "paper tool protocol timed out: {tool}"
                );
                for event in session.take_pending() {
                    if event["method"] == "item/tool/call" {
                        assert_eq!(event["params"]["tool"], tool);
                        let native = app.handle().clone();
                        let active = handle.clone();
                        let params = event["params"].clone();
                        let reader = std::thread::spawn(move || {
                            operate(&native, "workspace", &active, &params, || false)
                        });
                        if tool != "scientify_list_papers" {
                            let (id, job) = wait_request(app.handle());
                            invoke(
                                &view,
                                "agent_paper_source",
                                json!({"requestId":id}),
                                origin(),
                            )
                            .unwrap();
                            let result = if job["operation"] == "read" {
                                read_result()
                            } else {
                                json!({"totalPages":1,"matches":[{"page":1,"offset":0,"text":"fixture text"}],"searchedPages":[1],"truncated":false,"nextCursor":null})
                            };
                            invoke(
                                &view,
                                "agent_paper_complete",
                                json!({"requestId":id,"result":result}),
                                origin(),
                            )
                            .unwrap();
                        }
                        let result = reader.join().unwrap().unwrap();
                        assert!(result
                            .to_string()
                            .contains(if tool == "scientify_list_papers" {
                                "a.pdf"
                            } else {
                                "fixture text"
                            }));
                        session.respond(&event["id"],json!({"success":true,"contentItems":[{"type":"inputText","text":result.to_string()}]})).unwrap();
                        called = true;
                    }
                    if event["method"] == "turn/completed" {
                        assert!(called);
                        assert_eq!(event["params"]["turn"]["id"], turn["turn"]["id"]);
                        assert_eq!(event["params"]["turn"]["status"], "completed", "{event}");
                        break 'turn;
                    }
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        }
        assert_eq!(std::fs::read(root.join("a.pdf")).unwrap(), original);
        assert_eq!(
            std::fs::read_dir(&root)
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect::<Vec<_>>(),
            before
        );
    }
}
