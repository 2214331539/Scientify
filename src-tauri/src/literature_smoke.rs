//! Opt-in debug-only native smoke using an explicitly isolated directory.
use std::{
    fs,
    io::{Read, Write},
    net::TcpListener,
    path::PathBuf,
    time::{Duration, Instant},
};
use tauri::Manager;
pub fn seed_ui(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let storage = app.state::<crate::AppState>().storage.clone();
    if storage.load().map_err(std::io::Error::other)?.is_some() {
        return Ok(());
    }
    let root = storage.directory().parent().unwrap().join("library");
    fs::create_dir_all(root.join("References"))?;
    fs::write(
        root.join("sample.pdf"),
        include_bytes!("../tests/fixtures/mvp.pdf"),
    )?;
    fs::write(
        root.join("References/second.pdf"),
        include_bytes!("../tests/fixtures/mvp.pdf"),
    )?;
    let mut data = scientify_core::workspace::empty();
    data["revision"] = 1.into();
    data["projects"] = serde_json::json!([{"id":"smoke-project","name":"Scientify v0.4 验收","question":"Isolated fixture","createdAt":"2026-09-26","space":"personal"}]);
    storage.save(data, 0).map_err(std::io::Error::other)?;
    app.state::<crate::library::LibraryState>()
        .service
        .mount("smoke-project", &root)
        .map_err(std::io::Error::other)?;
    Ok(())
}
pub fn start(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let result = run(&app);
        let browser = app
            .state::<crate::browser::BrowserState>()
            .0
            .lock()
            .unwrap()
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let report = serde_json::json!({"passed":result.is_ok(),"error":result.err(),"browser":browser,"checks":["isolated library mount","paired notes persisted","native HTTP navigation/title","native history","remote IPC denied","view hide/show/close"]});
        if let Some(path) = std::env::var_os("SCIENTIFY_NATIVE_REPORT") {
            let _ = fs::write(path, serde_json::to_vec_pretty(&report).unwrap());
        }
        app.exit(if report["passed"] == true { 0 } else { 1 });
    });
}
fn wait(mut condition: impl FnMut() -> bool) -> Result<(), String> {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(25) {
        if condition() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err("native smoke condition timed out".into())
}
fn run(app: &tauri::AppHandle) -> Result<(), String> {
    let data =
        PathBuf::from(std::env::var_os("SCIENTIFY_DATA_DIR").ok_or("isolated data path required")?);
    if !data.is_absolute() || !data.to_string_lossy().contains(".test-artifacts") {
        return Err("native smoke must use .test-artifacts".into());
    }
    let root = data.parent().unwrap().join("library");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::write(
        root.join("smoke.pdf"),
        include_bytes!("../tests/fixtures/mvp.pdf"),
    )
    .map_err(|e| e.to_string())?;
    let service = app.state::<crate::library::LibraryState>().service.clone();
    service.mount("smoke-project", &root)?;
    let paper = service.open("smoke-project", "smoke.pdf")?;
    service.save_note("smoke-project", &paper.id, "# Native test note", None, None)?;
    if service.note("smoke-project", &paper.id)?.content != "# Native test note" {
        return Err("note mismatch".into());
    }
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let address = listener.local_addr().map_err(|e| e.to_string())?;
    std::thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
            let mut request = [0; 4096];
            let n = stream.read(&mut request).unwrap_or(0);
            let req = String::from_utf8_lossy(&request[..n]);
            let title = if req.contains("GET /two ") {
                "Native two"
            } else {
                "Native one"
            };
            let body = format!(
                "<!doctype html><title>{title}</title><h1>{title}</h1><a href='/two'>Next</a>"
            );
            let _=write!(stream,"HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: text/html\r\nConnection: close\r\n\r\n{}",body.len(),body);
        }
    });
    let tab = crate::browser::create_tab(app, "main", "smoke-project")?;
    crate::browser::navigate(
        app,
        &tab,
        tauri::Url::parse(&format!("http://{address}/")).unwrap(),
    )?;
    let view = app.get_webview(&tab.id).ok_or("native view missing")?;
    view.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(200., 100.).into(),
        size: tauri::LogicalSize::new(600., 400.).into(),
    })
    .map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())?;
    wait(|| {
        crate::browser::get(app, "main", &tab.id)
            .is_ok_and(|t| t.title == "Native one" && !t.loading)
    })
    .map_err(|e| format!("initial visible load: {e}"))?;
    view.navigate(tauri::Url::parse(&format!("http://{address}/two")).unwrap())
        .map_err(|e| e.to_string())?;
    wait(|| {
        crate::browser::get(app, "main", &tab.id)
            .is_ok_and(|t| t.title == "Native two" && t.can_back)
    })?;
    #[cfg(windows)]
    view.with_webview(|v| unsafe {
        if let Ok(core) = v.controller().CoreWebView2() {
            let _ = core.GoBack();
        }
    })
    .map_err(|e| e.to_string())?;
    wait(|| {
        crate::browser::get(app, "main", &tab.id)
            .is_ok_and(|t| t.title == "Native one" && t.can_forward)
    })?;
    view.eval("(async()=>{try{if(typeof window.require!=='undefined'){document.title='ISOLATION FAILED';return;}if(!window.__TAURI_INTERNALS__){document.title='IPC DENIED';return;}await window.__TAURI_INTERNALS__.invoke('workspace_load');document.title='ISOLATION FAILED';}catch{document.title='IPC DENIED';}})()").map_err(|e|e.to_string())?;
    wait(|| crate::browser::get(app, "main", &tab.id).is_ok_and(|t| t.title == "IPC DENIED"))?;
    view.hide().map_err(|e| e.to_string())?;
    view.show().map_err(|e| e.to_string())?;
    view.close().map_err(|e| e.to_string())?;
    Ok(())
}
