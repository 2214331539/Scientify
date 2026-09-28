//! Exercises actual commands and generated ACL without opening a native window.
//! The mock runtime does not replace a packaged WebView2 end-to-end check.
use super::*;
// Tauri normally applies the Common-Controls v6 manifest only to its app binary.
// Referencing the test runtime also links native menu/dialog imports, so the test
// executable needs that same generated manifest even though it opens no window.
#[cfg(all(windows, target_env = "msvc"))]
#[link(name = "resource", kind = "static", modifiers = "-bundle")]
unsafe extern "C" {}
use serde_json::json;
use tauri::{
    ipc::{CallbackFn, InvokeBody, InvokeResponseBody},
    test::{get_ipc_response, mock_builder, MockRuntime, INVOKE_KEY},
    webview::InvokeRequest,
    WebviewWindow,
};

#[test]
fn runtime_window_icon_uses_high_resolution_frame() {
    let context: tauri::Context<MockRuntime> = tauri::generate_context!();
    let icon = context.default_window_icon().expect("application icon");
    assert_eq!((icon.width(), icon.height()), (256, 256));
}

fn invoke(
    window: &WebviewWindow<MockRuntime>,
    command: &str,
    body: Value,
    origin: &str,
) -> Result<InvokeResponseBody, Value> {
    get_ipc_response(
        window,
        InvokeRequest {
            cmd: command.into(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: origin.parse().unwrap(),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.into(),
        },
    )
}

#[test]
fn model_discovery_and_verification_pass_generated_acl_only_for_local_app_views() {
    let app = mock_builder()
        .invoke_handler(tauri::generate_handler![
            ai::research_list_models,
            ai::research_test_model,
            ai::research_ask_ai,
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let origin = if cfg!(feature = "custom-protocol") {
        "http://tauri.localhost"
    } else {
        "http://127.0.0.1:1420"
    };
    let untrusted = tauri::WebviewWindowBuilder::new(&app, "browser-untrusted", Default::default())
        .build()
        .unwrap();
    for label in ["main", "workspace"] {
        let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .unwrap();
        let (endpoint, server) = ai::tests::server(vec![
            ("200 OK", r#"{"data":[{"id":"ipc-chat"}]}"#),
            ("200 OK", r#"{"choices":[{"message":{"content":"OK"}}]}"#),
            (
                "200 OK",
                r#"{"choices":[{"message":{"content":"chat answer"}}]}"#,
            ),
        ]);
        let request = json!({"endpoint":endpoint,"apiKey":"ipc-test-only-key","provider":"openai","model":"ipc-chat","messages":[{"role":"user","content":"Chat via IPC"}]});
        for command in [
            "research_list_models",
            "research_test_model",
            "research_ask_ai",
        ] {
            for (view, source) in [(&untrusted, origin), (&window, "https://example.com")] {
                let error = match invoke(view, command, json!({"request":request}), source) {
                    Err(error) => error.to_string(),
                    Ok(_) => panic!("external content must not have model API access"),
                };
                assert!(error.contains("not allowed"), "{command}: {error}");
            }
        }
        let models: Value = invoke(
            &window,
            "research_list_models",
            json!({"request":request}),
            origin,
        )
        .expect("model discovery must pass the generated application ACL")
        .deserialize()
        .unwrap();
        assert_eq!(models[0]["id"], "ipc-chat");
        let verified: Value = invoke(
            &window,
            "research_test_model",
            json!({"request":request}),
            origin,
        )
        .expect("chat verification must pass the generated application ACL")
        .deserialize()
        .unwrap();
        assert!(verified.is_null());
        let answer: String = invoke(
            &window,
            "research_ask_ai",
            json!({"request":request}),
            origin,
        )
        .expect("chat must remain available after configuration")
        .deserialize()
        .unwrap();
        assert_eq!(answer, "chat answer");
        let sent = server.join().unwrap();
        assert_eq!(sent.len(), 3);
        assert!(sent[0].starts_with("GET /v1/models "));
        assert!(sent[1].contains("Reply OK."));
        assert!(!sent[1].contains("Chat via IPC"));
        assert!(sent[2].contains("Chat via IPC"));
    }
}

#[test]
fn ipc_acl_and_local_file_pdf_workflow_are_wired() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("workspace");
    let storage = Arc::new(Storage::open(directory.clone()).unwrap());
    let files = Arc::new(scientify_core::research::ResearchFiles::new(directory));
    let app = mock_builder()
        .manage(AppState {
            storage: storage.clone(),
            files: files.clone(),
            legacy: temporary.path().join("unused-legacy"),
        })
        .invoke_handler(tauri::generate_handler![
            workspace_load,
            workspace_save,
            research::research_list_files,
            research::research_read_file,
            research::research_write_file,
            research::research_read_pdf,
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let denied_window = tauri::WebviewWindowBuilder::new(&app, "untrusted", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(feature = "custom-protocol") {
        "http://tauri.localhost"
    } else {
        "http://127.0.0.1:1420"
    };
    let initial: Value = invoke(&window, "workspace_load", json!({}), origin)
        .unwrap()
        .deserialize()
        .unwrap();
    assert!(initial["workspace"].is_null());
    let research_window = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
        .build()
        .unwrap();
    let workspace_initial: Value = invoke(&research_window, "workspace_load", json!({}), origin)
        .unwrap()
        .deserialize()
        .unwrap();
    assert!(workspace_initial["workspace"].is_null());
    let mut workspace = scientify_core::workspace::empty();
    workspace["projects"] = json!([{"id":"smoke-project","name":"IPC smoke","question":"Local persistence?","createdAt":"2026-09-23"}]);
    workspace["revision"] = json!(1);
    let saved: Value = invoke(
        &window,
        "workspace_save",
        json!({"workspace":workspace,"expectedRevision":0}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(saved["revision"], 1);
    let new_file = json!({"projectId":"smoke-project","path":"研究/main.md","content":"# Native IPC\nSaved through Tauri.","expectedVersion":null});
    let created: Value = invoke(&window, "research_write_file", new_file, origin)
        .unwrap()
        .deserialize()
        .unwrap();
    let read_args = json!({"projectId":"smoke-project","path":"研究/main.md"});
    let opened: Value = invoke(&window, "research_read_file", read_args.clone(), origin)
        .unwrap()
        .deserialize()
        .unwrap();
    assert_eq!(opened["content"], "# Native IPC\nSaved through Tauri.");
    assert_eq!(opened["version"], created["version"]);
    let list: Value = invoke(
        &window,
        "research_list_files",
        json!({"projectId":"smoke-project"}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert!(list
        .as_array()
        .unwrap()
        .iter()
        .any(|file| file["path"] == "研究/main.md"));
    assert!(invoke(&window, "research_write_file", json!({"projectId":"smoke-project","path":"研究/main.md","content":"stale","expectedVersion":"stale"}), origin).is_err());
    assert!(invoke(
        &window,
        "research_read_file",
        json!({"projectId":"smoke-project","path":"../../workspace.json"}),
        origin
    )
    .is_err());
    assert!(invoke(
        &denied_window,
        "research_read_file",
        read_args.clone(),
        origin
    )
    .is_err());
    assert!(invoke(
        &window,
        "research_read_file",
        read_args,
        "https://example.com"
    )
    .is_err());

    // The picker is intentionally bypassed to avoid interacting with the desktop;
    // the actual managed import and binary IPC read still operate on real files.
    let source = temporary.path().join("sample.pdf");
    let bytes = include_bytes!("../tests/fixtures/mvp.pdf");
    std::fs::write(&source, bytes).unwrap();
    let asset = files.import_pdf(&source).unwrap();
    std::fs::remove_file(&source).unwrap();
    match invoke(
        &window,
        "research_read_pdf",
        json!({"assetId":asset.asset_id}),
        origin,
    )
    .unwrap()
    {
        InvokeResponseBody::Raw(result) => assert_eq!(result, bytes),
        InvokeResponseBody::Json(_) => panic!("PDF IPC must return binary, not JSON"),
    }
    assert_eq!(storage.load().unwrap().unwrap()["revision"], 1);
}
