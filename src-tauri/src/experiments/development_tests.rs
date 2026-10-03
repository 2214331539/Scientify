use super::*;
use crate::{ipc_smoke::invoke, AppState};
use scientify_core::{research::ResearchFiles, storage::Storage};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

#[test]
fn real_python_environment_terminal_and_formal_run_work_without_a_model() {
    let folder = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".test-artifacts/local-development");
    std::fs::create_dir_all(&folder).unwrap();
    let fixture = tempfile::tempdir_in(folder).unwrap();
    let root = fixture.path().join("source");
    let other = fixture.path().join("other");
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(&other).unwrap();
    let storage = Arc::new(Storage::open(fixture.path().join("data/workspace")).unwrap());
    let mut data = scientify_core::workspace::empty();
    data["projects"] =
        json!([{"id":"p1","name":"Research","question":"","createdAt":"now","path":root}]);
    data["revision"] = json!(1);
    let mut data = storage.save(data, 0).unwrap();
    data["experiments"].as_array_mut().unwrap().push(json!({"id":"other","project":"p1","name":"Other","purpose":"","source":"existing","root":other,"createdAt":"now","updatedAt":"now"}));
    data["revision"] = json!(2);
    storage.save(data, 1).unwrap();
    let app = tauri::test::mock_builder()
        .manage(AppState {
            storage: storage.clone(),
            files: Arc::new(ResearchFiles::new(storage.directory().into())),
            legacy: fixture.path().join("legacy"),
        })
        .manage(crate::agent::AgentState::default())
        .manage(ExperimentState::new(
            storage.directory().join("experiments"),
        ))
        .manage(python::PythonState::new(
            storage.directory().join("environment-tasks"),
        ))
        .manage(terminal::TerminalState::default())
        .invoke_handler(tauri::generate_handler![
            trust::experiment_trust,
            python::python_command,
            terminal::terminal_command,
            terminal::development_snapshot,
            experiment_start,
            experiment_list,
            experiment_log,
            experiment_stop,
            experiment_artifacts,
            crate::workspace_save
        ])
        .build(tauri::generate_context!())
        .unwrap();
    let window = tauri::WebviewWindowBuilder::new(&app, "workspace", Default::default())
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
    for command in [
        "experiment_trust",
        "python_command",
        "terminal_command",
        "development_snapshot",
    ] {
        assert!(invoke(&launcher, command, json!({}), origin).is_err());
        assert!(invoke(&window, command, json!({}), "https://example.com").is_err());
    }
    let call = |command: &str, args: Value| -> Value {
        invoke(&window, command, args, origin)
            .unwrap_or_else(|e| panic!("{command}: {e:?}"))
            .deserialize()
            .unwrap()
    };
    let py = |id: &str, request: Value| {
        call(
            "python_command",
            json!({"projectId":"p1","experimentId":id,"request":request}),
        )
    };
    let term = |request: Value| {
        call(
            "terminal_command",
            json!({"projectId":"p1","request":request}),
        )
    };
    assert!(invoke(
        &window,
        "python_command",
        json!({"projectId":"p1","experimentId":"p1","request":{"action":"discover"}}),
        origin
    )
    .is_err());
    for id in ["p1", "other"] {
        assert_eq!(
            call(
                "experiment_trust",
                json!({"projectId":"p1","experimentId":id,"allow":true})
            ),
            true
        );
    }
    let base = python::find_program("python").expect("native acceptance requires installed Python");
    let base = base.display().to_string();
    let wait_task = |id: &str, task: &Value| -> Value {
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let tasks = py(id, json!({"action":"tasks"}));
            let current = tasks
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["id"] == task["id"])
                .unwrap()
                .clone();
            if current["status"] != "running" {
                assert_eq!(
                    current["status"],
                    "completed",
                    "{}\n{}",
                    current,
                    py(id, json!({"action":"log","id":task["id"]}))
                );
                return current;
            }
            assert!(Instant::now() < deadline, "environment task timeout");
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    let a = wait_task(
        "p1",
        &py("p1", json!({"action":"start","kind":"venv","base":base})),
    );
    let b = wait_task(
        "other",
        &py("other", json!({"action":"start","kind":"venv","base":base})),
    );
    assert_ne!(a["environment"]["prefix"], b["environment"]["prefix"]);
    let mut data = storage.load().unwrap().unwrap();
    data["experiments"][0]["python"] = a["environment"].clone();
    data["experiments"][1]["python"] = b["environment"].clone();
    data["revision"] = json!(3);
    call(
        "workspace_save",
        json!({"workspace":data,"expectedRevision":2}),
    );
    // A wheel made from stdlib exercises real pip installation without Internet.
    let wheel_script="import zipfile,sys; p=sys.argv[1]; d='scientify_fixture-0.1.0.dist-info/'; z=zipfile.ZipFile(p,'w'); z.writestr('scientify_fixture/__init__.py','value = 42\\n'); z.writestr(d+'METADATA','Metadata-Version: 2.1\\nName: scientify-fixture\\nVersion: 0.1.0\\n'); z.writestr(d+'WHEEL','Wheel-Version: 1.0\\nGenerator: Scientify\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n'); z.writestr(d+'RECORD',''); z.close()";
    let wheel = root.join("scientify_fixture-0.1.0-py3-none-any.whl");
    let mut command = std::process::Command::new(&base);
    command.args(["-c", wheel_script, wheel.to_str().unwrap()]);
    crate::local_process::capture(&mut command, Duration::from_secs(10)).unwrap();
    std::fs::write(
        root.join("requirements.txt"),
        "./scientify_fixture-0.1.0-py3-none-any.whl\n",
    )
    .unwrap();
    wait_task(
        "p1",
        &py("p1", json!({"action":"start","kind":"requirements"})),
    );
    let packages = py("p1", json!({"action":"packages"}));
    assert!(packages
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["name"] == "scientify-fixture"));
    let other_packages = py("other", json!({"action":"packages"}));
    assert!(!other_packages
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["name"] == "scientify-fixture"));
    std::fs::write(
        root.join("input.py"),
        "name=input('Name: '); print('HELLO-'+name, flush=True)\n",
    )
    .unwrap();
    let terminal =
        term(json!({"action":"open","experimentId":"p1","profile":"python","path":"input.py"}));
    let id = terminal["id"].clone();
    assert!(crate::code::Lease::mutation(&root).is_err());
    assert!(invoke(
        &window,
        "terminal_command",
        json!({"projectId":"wrong","request":{"action":"input","id":id,"data":"wrong"}}),
        origin
    )
    .is_err());
    term(json!({"action":"resize","id":id,"cols":110,"rows":28}));
    term(json!({"action":"input","id":id,"data":"\u{1b}[1;1RScientify\r"}));
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut offset = 0;
    let mut transcript = Vec::new();
    loop {
        use base64::Engine;
        let chunk = term(json!({"action":"read","id":id,"offset":offset}));
        offset = chunk["offset"].as_u64().unwrap();
        transcript.extend(
            base64::engine::general_purpose::STANDARD
                .decode(chunk["data"].as_str().unwrap())
                .unwrap(),
        );
        if String::from_utf8_lossy(&transcript).contains("HELLO-Scientify") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "stdin did not work: {}",
            String::from_utf8_lossy(&transcript)
        );
        std::thread::sleep(Duration::from_millis(60));
    }
    term(json!({"action":"close","id":id}));
    let script="import time,sys\nprint('RUNNING-'+sys.executable,flush=True)\ntry:\n while True: time.sleep(.1)\nexcept KeyboardInterrupt: print('STOPPED',flush=True)\n";
    for directory in [&root, &other] {
        std::fs::write(directory.join("running.py"), script).unwrap();
    }
    let first =
        term(json!({"action":"open","experimentId":"p1","profile":"python","path":"running.py"}));
    let second = term(
        json!({"action":"open","experimentId":"other","profile":"python","path":"running.py"}),
    );
    assert_ne!(
        first["environment"]["prefix"],
        second["environment"]["prefix"]
    );
    let snapshot = call("development_snapshot", json!({}));
    assert_eq!(snapshot["terminals"].as_array().unwrap().len(), 2);
    assert!(snapshot["tasks"].as_array().unwrap().len() >= 3);
    assert!(invoke(&window, "python_command", json!({"projectId":"p1","experimentId":"p1","request":{"action":"start","kind":"requirements"}}), origin).is_err());
    // ConPTY inherits the renderer cursor; this headless fixture answers its query.
    for item in [&first, &second] {
        term(json!({"action":"input","id":item["id"],"data":"\u{1b}[1;1R"}));
    }
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        use base64::Engine;
        let ready = [&first, &second].into_iter().all(|item| {
            let chunk = term(json!({"action":"read","id":item["id"],"offset":0}));
            String::from_utf8_lossy(
                &base64::engine::general_purpose::STANDARD
                    .decode(chunk["data"].as_str().unwrap())
                    .unwrap(),
            )
            .contains("RUNNING-")
        });
        if ready {
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(60));
    }
    term(json!({"action":"input","id":first["id"],"data":"\u{3}"}));
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let items = term(json!({"action":"list"}));
        let a = items
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == first["id"])
            .unwrap();
        let b = items
            .as_array()
            .unwrap()
            .iter()
            .find(|t| t["id"] == second["id"])
            .unwrap();
        assert_eq!(b["status"], "running");
        if a["status"] == "exited" {
            assert_eq!(a["exitCode"], 0);
            break;
        }
        assert!(Instant::now() < deadline, "Ctrl+C did not interrupt Python");
        std::thread::sleep(Duration::from_millis(60));
    }
    for item in [&first, &second] {
        term(json!({"action":"close","id":item["id"]}));
    }
    let overridden = call(
        "experiment_start",
        json!({"projectId":"p1","configuration":{"id":"override","name":"Explicit interpreter","executable":b["environment"]["executable"],"args":["-c","import sys; print(sys.executable, flush=True)"],"cwd":"."}}),
    );
    assert_eq!(
        overridden["environment"]["prefix"],
        b["environment"]["prefix"]
    );
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let items = call("experiment_list", json!({}));
        let current = items
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == overridden["id"])
            .unwrap();
        if current["status"] != "running" {
            assert_eq!(current["status"], "completed");
            assert!(call("experiment_log", json!({"runId":overridden["id"]}))
                .as_str()
                .unwrap()
                .contains(b["environment"]["executable"].as_str().unwrap()));
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(60));
    }
    std::fs::write(root.join("service.py"),"import os,json,http.server,socketserver\nfrom scientify_fixture import value\nclass Handler(http.server.BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200); self.end_headers(); self.wfile.write(b'SCIENTIFY-LOCAL')\nwith socketserver.TCPServer(('127.0.0.1',0),Handler) as s:\n p=os.environ['SCIENTIFY_RUN_DIR']; json.dump({'fixture':value,'port':s.server_address[1]},open(os.path.join(p,'metrics.json'),'w')); print('ready',flush=True); s.serve_forever()\n").unwrap();
    let run = call(
        "experiment_start",
        json!({"projectId":"p1","configuration":{"id":"service","name":"Local service","executable":"python","args":["service.py"],"cwd":"."}}),
    );
    assert_eq!(run["permission"], "trusted-current-user");
    assert_eq!(
        run["environment"]["executable"],
        a["environment"]["executable"]
    );
    let metrics = storage
        .directory()
        .join("experiments")
        .join(run["id"].as_str().unwrap())
        .join("artifacts/metrics.json");
    let deadline = Instant::now() + Duration::from_secs(15);
    while !metrics.is_file() {
        assert!(
            Instant::now() < deadline,
            "service did not start: {}",
            call("experiment_log", json!({"runId":run["id"]}))
        );
        std::thread::sleep(Duration::from_millis(80));
    }
    let output: Value = serde_json::from_slice(&std::fs::read(metrics).unwrap()).unwrap();
    assert_eq!(output["fixture"], 42);
    use std::io::{Read, Write};
    let mut socket =
        std::net::TcpStream::connect(("127.0.0.1", output["port"].as_u64().unwrap() as u16))
            .unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    socket
        .write_all(b"GET / HTTP/1.0\r\nHost: localhost\r\n\r\n")
        .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    assert!(response.contains("SCIENTIFY-LOCAL"));
    call("experiment_stop", json!({"runId":run["id"]}));
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let runs = call("experiment_list", json!({}));
        let current = runs
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["id"] == run["id"])
            .unwrap();
        if current["status"] != "running" {
            assert_eq!(current["status"], "cancelled");
            break;
        }
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(60));
    }
    let terminal = term(json!({"action":"open","experimentId":"p1","profile":"cmd"}));
    let mut invalid = storage.load().unwrap().unwrap();
    invalid["experiments"][0]["archived"] = json!(true);
    invalid["revision"] = json!(4);
    assert!(invoke(
        &window,
        "workspace_save",
        json!({"workspace":invalid,"expectedRevision":3}),
        origin
    )
    .is_err());
    term(json!({"action":"input","id":terminal["id"],"data":"\u{3}"}));
    term(json!({"action":"close","id":terminal["id"]}));
}
