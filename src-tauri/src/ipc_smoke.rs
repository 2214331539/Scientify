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

#[test]
fn experiment_registration_uses_native_acl_and_enables_only_its_own_projects_root() {
    let temp = tempfile::tempdir().unwrap();
    let storage = Arc::new(Storage::open(temp.path().join("data/workspace")).unwrap());
    let files = Arc::new(scientify_core::research::ResearchFiles::new(
        storage.directory().to_path_buf(),
    ));
    let mut data = scientify_core::workspace::empty();
    data["projects"] = json!([{"id":"p1","name":"Research","space":"personal","question":"","createdAt":"now"},{"id":"p2","name":"Other","space":"personal","question":"","createdAt":"now"}]);
    data["revision"] = json!(1);
    storage.save(data, 0).unwrap();
    let app = mock_builder()
        .manage(AppState {
            storage: storage.clone(),
            files,
            legacy: temp.path().join("legacy"),
        })
        .manage(agent::AgentState::default())
        .manage(experiments::ExperimentState::new(temp.path().join("runs")))
        .invoke_handler(tauri::generate_handler![
            experiments::catalog::experiment_prepare,
            workspace_save,
            research::research_read_file,
            research::research_write_file
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let workspace = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
        .build()
        .unwrap();
    let launcher = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(feature = "custom-protocol") {
        "http://tauri.localhost"
    } else {
        "http://127.0.0.1:1420"
    };
    for (window, url) in [(&launcher, origin), (&workspace, "https://example.com")] {
        assert!(invoke(
            window,
            "experiment_prepare",
            json!({"projectId":"p1","source":"empty"}),
            url
        )
        .is_err());
    }
    let prepared: Value = invoke(
        &workspace,
        "experiment_prepare",
        json!({"projectId":"p1","source":"empty"}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    let root = prepared["root"].as_str().unwrap();
    assert!(PathBuf::from(root)
        .starts_with(storage.directory().canonicalize().unwrap().join("projects")));
    let args = json!({"projectId":"p1","workspaceRoot":root,"path":"train.py","content":"print('isolated')","expectedVersion":null});
    assert!(invoke(&workspace, "research_write_file", args.clone(), origin).is_err());
    let mut data = storage.load().unwrap().unwrap();
    data["experiments"].as_array_mut().unwrap().push(json!({"id":prepared["id"],"project":"p1","name":"Ablation","purpose":"test","source":"empty","root":root,"createdAt":"now","updatedAt":"now"}));
    data["revision"] = json!(2);
    invoke(
        &workspace,
        "workspace_save",
        json!({"workspace":data,"expectedRevision":1}),
        origin,
    )
    .unwrap();
    invoke(&workspace, "research_write_file", args, origin).unwrap();
    let read: Value = invoke(
        &workspace,
        "research_read_file",
        json!({"projectId":"p1","workspaceRoot":root,"path":"train.py"}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(read["content"], "print('isolated')");
    assert!(invoke(
        &workspace,
        "research_read_file",
        json!({"projectId":"p2","workspaceRoot":root,"path":"train.py"}),
        origin
    )
    .is_err());
}

#[test]
fn git_commands_enforce_acl_and_use_the_selected_registered_worktree() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("source");
    std::fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let storage = Arc::new(Storage::open(temp.path().join("data")).unwrap());
    let mut data = scientify_core::workspace::empty();
    data["projects"] = json!([{"id":"git-project","name":"Git","space":"personal","createdAt":"2026-10-02","question":"fixture","path":root}]);
    data["revision"] = json!(1);
    storage.save(data, 0).unwrap();
    let files = Arc::new(scientify_core::research::ResearchFiles::new(
        storage.directory().to_path_buf(),
    ));
    let app = mock_builder()
        .manage(AppState {
            storage,
            files,
            legacy: temp.path().join("legacy"),
        })
        .invoke_handler(tauri::generate_handler![
            git::code_git_inspect,
            git::code_git_action,
            git::code_git_diff,
            research::research_read_file,
            research::research_write_file
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let workspace = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
        .build()
        .unwrap();
    let launcher = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(feature = "custom-protocol") {
        "http://tauri.localhost"
    } else {
        "http://127.0.0.1:1420"
    };
    for command in ["code_git_inspect", "code_git_action", "code_git_diff"] {
        for (window, url) in [(&launcher, origin), (&workspace, "https://example.com")] {
            assert!(invoke(window, command, json!({}), url)
                .unwrap_err()
                .to_string()
                .contains("not allowed"));
        }
    }
    let initial: Value = invoke(
        &workspace,
        "code_git_inspect",
        json!({"projectId":"git-project"}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(initial["repository"], false);
    invoke(
        &workspace,
        "code_git_action",
        json!({"projectId":"git-project","request":{"kind":"init"}}),
        origin,
    )
    .unwrap();
    for (key, value) in [
        ("user.name", "Fixture"),
        ("user.email", "fixture@example.test"),
    ] {
        let mut command = research::git_command(&root).unwrap();
        command.args(["config", key, value]);
        assert!(research::bounded_git_full(command).unwrap().0.success());
    }
    invoke(&workspace, "research_write_file", json!({"projectId":"git-project","path":"train.py","content":"baseline\n","expectedVersion":null}), origin).unwrap();
    invoke(
        &workspace,
        "code_git_action",
        json!({"projectId":"git-project","request":{"kind":"stage","path":"train.py"}}),
        origin,
    )
    .unwrap();
    invoke(
        &workspace,
        "code_git_action",
        json!({"projectId":"git-project","request":{"kind":"commit","message":"baseline"}}),
        origin,
    )
    .unwrap();
    let target = temp.path().join("worktree");
    invoke(&workspace, "code_git_action", json!({"projectId":"git-project","request":{"kind":"worktree-add","name":"feature/test","target":target}}), origin).unwrap();
    let tree = target.canonicalize().unwrap();
    let opened: Value = invoke(
        &workspace,
        "code_git_inspect",
        json!({"projectId":"git-project","workspaceRoot":tree}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(opened["branch"], "feature/test");
    let file: Value = invoke(
        &workspace,
        "research_read_file",
        json!({"projectId":"git-project","workspaceRoot":tree,"path":"train.py"}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    invoke(&workspace, "research_write_file", json!({"projectId":"git-project","workspaceRoot":tree,"path":"train.py","content":"worktree only\n","expectedVersion":file["version"]}), origin).unwrap();
    let base: Value = invoke(
        &workspace,
        "research_read_file",
        json!({"projectId":"git-project","path":"train.py"}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(base["content"], "baseline\n");
    assert!(invoke(
        &workspace,
        "research_read_file",
        json!({"projectId":"git-project","workspaceRoot":temp.path(),"path":"train.py"}),
        origin
    )
    .is_err());
    let _task = code::Lease::agent(&tree).unwrap();
    assert!(invoke(&workspace, "code_git_action", json!({"projectId":"git-project","workspaceRoot":tree,"request":{"kind":"branch-switch","name":"main"}}), origin).is_err());
}

#[test]
fn experiment_commands_use_workspace_only_acl_and_real_processes() {
    let temporary = tempfile::tempdir().unwrap();
    let directory = temporary.path().join("workspace");
    let storage = Arc::new(Storage::open(directory.clone()).unwrap());
    let mut data = scientify_core::workspace::empty();
    data["projects"] = json!([{"id":"execution-project","name":"Execution","question":"Test","createdAt":"2026-10-01","space":"personal"}]);
    data["revision"] = json!(1);
    storage.save(data, 0).unwrap();
    let files = Arc::new(scientify_core::research::ResearchFiles::new(
        directory.clone(),
    ));
    let root = files.project_root("execution-project", None).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    let app = mock_builder()
        .manage(AppState {
            storage,
            files,
            legacy: temporary.path().join("legacy"),
        })
        .manage(experiments::ExperimentState::new(
            directory.join("experiments"),
        ))
        .invoke_handler(tauri::generate_handler![
            experiments::experiment_start,
            experiments::experiment_list,
            experiments::experiment_stop,
            experiments::experiment_log,
            experiments::experiment_artifacts,
            experiments::experiment_read_artifact,
            research::research_git_diff
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let trusted = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
        .build()
        .unwrap();
    let denied = tauri::WebviewWindowBuilder::new(&app, "main", Default::default())
        .build()
        .unwrap();
    let origin = if cfg!(feature = "custom-protocol") {
        "http://tauri.localhost"
    } else {
        "http://127.0.0.1:1420"
    };
    for cmd in [
        "experiment_start",
        "experiment_list",
        "experiment_stop",
        "experiment_log",
        "experiment_artifacts",
        "experiment_read_artifact",
        "research_git_diff",
    ] {
        for (window, source) in [(&denied, origin), (&trusted, "https://example.com")] {
            let e = invoke(window, cmd, json!({}), source).expect_err("untrusted IPC must fail");
            assert!(e.to_string().contains("not allowed"), "{cmd}: {e}");
        }
    }
    let (exe, args) = if cfg!(windows) {
        (
            std::env::var("SystemRoot").unwrap() + "/System32/whoami.exe",
            vec![],
        )
    } else {
        ("/bin/echo".into(), vec!["native-experiment-test"])
    };
    let run: Value = invoke(&trusted,"experiment_start",json!({"projectId":"execution-project","configuration":{"id":"test","name":"Native test","executable":exe,"args":args,"cwd":"."}}),origin).unwrap().deserialize().unwrap();
    let id = run["id"].as_str().unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        let runs: Value = invoke(&trusted, "experiment_list", json!({}), origin)
            .unwrap()
            .deserialize()
            .unwrap();
        if runs[0]["status"] != "running" {
            assert_eq!(runs[0]["status"], "completed", "{:?}", runs[0]);
            assert_eq!(runs[0]["exitCode"], 0);
            break;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    let log: String = invoke(&trusted, "experiment_log", json!({"runId":id}), origin)
        .unwrap()
        .deserialize()
        .unwrap();
    assert!(!log.trim().is_empty());
    assert!(directory
        .join("experiments")
        .join(id)
        .join("record.json")
        .is_file());
    let list: Value = invoke(
        &trusted,
        "experiment_artifacts",
        json!({"runId":id}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(list, json!([]));
    let artifacts = directory.join("experiments").join(id).join("artifacts");
    std::fs::write(artifacts.join("metrics.json"), "{\"accuracy\":0.8}").unwrap();
    let artifact: Value = invoke(
        &trusted,
        "experiment_read_artifact",
        json!({"runId":id,"path":"metrics.json"}),
        origin,
    )
    .unwrap()
    .deserialize()
    .unwrap();
    assert_eq!(artifact["content"], "{\"accuracy\":0.8}");
    assert!(invoke(
        &trusted,
        "experiment_read_artifact",
        json!({"runId":id,"path":"../record.json"}),
        origin
    )
    .is_err());
    assert!(invoke(&trusted, "experiment_stop", json!({"runId":id}), origin).is_ok());
    assert!(invoke(
        &trusted,
        "research_git_diff",
        json!({"projectId":"execution-project","path":"../outside"}),
        origin
    )
    .is_err());
}

pub(crate) fn invoke(
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
    let files = Arc::new(scientify_core::research::ResearchFiles::new(
        directory.clone(),
    ));
    let app = mock_builder()
        .manage(agent::AgentState::default())
        .manage(experiments::ExperimentState::new(
            directory.join("experiments"),
        ))
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

#[test]
fn agent_release_uses_generated_acl_for_both_local_views() {
    let app = mock_builder()
        .manage(agent::AgentState::default())
        .invoke_handler(tauri::generate_handler![agent::agent_release])
        .build(tauri::generate_context!())
        .unwrap();
    let origin = if cfg!(feature = "custom-protocol") {
        "http://tauri.localhost"
    } else {
        "http://127.0.0.1:1420"
    };
    for label in ["main", "workspace", "browser-untrusted"] {
        let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .unwrap();
        let body = json!({"projectId":"p1","conversationId":"c1","domain":"code"});
        assert_eq!(
            invoke(&window, "agent_release", body.clone(), origin).is_ok(),
            label != "browser-untrusted"
        );
        assert!(invoke(&window, "agent_release", body, "https://untrusted.example").is_err());
    }
}

#[test]
fn storage_location_commands_are_local_only_and_schedule_without_replacing_services() {
    let temporary = tempfile::tempdir().unwrap();
    let installation = temporary.path().join("install");
    std::fs::create_dir(&installation).unwrap();
    let locator = scientify_core::storage_location::Locator::new(
        installation,
        temporary.path().join("roaming"),
        temporary.path().join("local"),
    );
    let location = locator.prepare().unwrap();
    let app = mock_builder()
        .manage(data_location::DataLocation {
            locator: Some(locator),
            container: location.directory.clone(),
        })
        .manage(agent::AgentState::default())
        .manage(experiments::ExperimentState::new(
            location.directory.join("workspace/experiments"),
        ))
        .invoke_handler(tauri::generate_handler![
            data_location::storage_location,
            data_location::storage_schedule,
            data_location::storage_cancel
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let origin = if cfg!(feature = "custom-protocol") {
        "http://tauri.localhost"
    } else {
        "http://127.0.0.1:1420"
    };
    for label in ["main", "workspace", "browser-untrusted"] {
        let window = tauri::WebviewWindowBuilder::new(&app, label, Default::default())
            .build()
            .unwrap();
        for command in ["storage_location", "storage_schedule", "storage_cancel"] {
            let body = json!({"directory":temporary.path().join("destination")});
            let result = invoke(&window, command, body.clone(), origin);
            assert_eq!(
                result.is_ok(),
                label != "browser-untrusted",
                "{command} {label}"
            );
            assert!(invoke(&window, command, body, "https://untrusted.example").is_err());
        }
    }
    assert_eq!(
        app.state::<data_location::DataLocation>().container,
        location.directory
    );
}
