//! Engine process lifecycle. The sidecar is spawned by Rust, never by the webview.

#[cfg(windows)]
use super::quiet_process::QuietChild as Child;
#[cfg(windows)]
use std::fs::File as ChildStdin;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
#[cfg(not(windows))]
use std::process::{Child, ChildStdin};
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

const TRIPLE: &str = env!("SCIENTIFY_TARGET");

/// The bundled engine communicates over stdio. On Windows it must not create
/// a visible console window every time a user starts an Agent task.
fn hide_console_window(_command: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        _command.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Optional host callback for low-latency notifications. The JSON-RPC queue
/// remains the source of truth; the callback only wakes the UI so it can drain
/// that queue immediately instead of waiting for a timer tick.
pub type EventSink = Arc<dyn Fn(serde_json::Value) + Send + Sync + 'static>;

fn spawn_engine(command: &mut Command, home: &Path) -> Result<Child, String> {
    let temp = home.join("runtime-temp");
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    // Windows short aliases and long paths must resolve to the same sandbox
    // root. Pass an existing, canonical directory to the upstream engine.
    let temp = crate::local_process::process_path(&temp.canonicalize().map_err(|e| e.to_string())?);
    command
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .env("TMPDIR", &temp);
    #[cfg(windows)]
    let child = Child::spawn(command);
    #[cfg(not(windows))]
    let child = command.spawn();
    child.map_err(|e| format!("无法启动 Agent 引擎：{e}"))
}

/// Locate the engine binary.
///
/// Release bundles place `externalBin` next to the application executable with the
/// target-triple suffix removed; development keeps the suffixed file produced by
/// `scripts/prepare-agent.mjs`.
pub fn engine_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位应用目录：{e}"))?;
    let directory = exe.parent().ok_or("应用目录不可用。")?;
    let bundled = [
        format!("codex{}", std::env::consts::EXE_SUFFIX),
        format!("codex-{TRIPLE}{}", std::env::consts::EXE_SUFFIX),
    ];
    for name in bundled {
        let candidate = directory.join(name);
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(format!("codex-{TRIPLE}{}", std::env::consts::EXE_SUFFIX));
    if development.is_file() {
        return Ok(development);
    }
    Err("未找到内置 Agent 引擎，请先运行 pnpm install 或 pnpm run prepare:agent。".into())
}

/// Report the engine version without starting a session.
pub fn version(engine: &Path, codex_home: &Path) -> Result<String, String> {
    let mut command = Command::new(engine);
    let temp = codex_home.join("runtime-temp");
    std::fs::create_dir_all(&temp).map_err(|e| e.to_string())?;
    command
        .arg("--version")
        .env("CODEX_HOME", codex_home)
        .env("TEMP", &temp)
        .env("TMP", &temp)
        .stdin(Stdio::null());
    hide_console_window(&mut command);
    let output = command
        .output()
        .map_err(|e| format!("无法启动 Agent 引擎：{e}"))?;
    if !output.status.success() {
        return Err("Agent 引擎未能报告版本。".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    text.lines()
        .next()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "Agent 引擎返回了空版本号。".into())
}

/// Send one request and return the matching response.
///
/// Reading happens on a worker thread so a silent engine cannot block the caller
/// past `budget`. Notifications without a matching id are ignored.
pub fn exchange(
    engine: &Path,
    codex_home: &Path,
    request: String,
    id: u64,
    budget: Duration,
) -> Result<serde_json::Value, String> {
    exchange_with(
        engine,
        &["app-server", "--listen", "stdio://"],
        codex_home,
        request,
        id,
        budget,
    )
}

fn exchange_with(
    engine: &Path,
    args: &[&str],
    codex_home: &Path,
    request: String,
    id: u64,
    budget: Duration,
) -> Result<serde_json::Value, String> {
    let mut command = Command::new(engine);
    command
        .args(args)
        // Analytics stay off: this is a local-first product and the engine
        // defaults to off for app-server, so we simply do not enable it.
        .env("CODEX_HOME", codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    hide_console_window(&mut command);
    let mut child = spawn_engine(&mut command, codex_home)?;
    // The Windows quiet launcher always creates pipes, including discarded diagnostics.
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stderr, &mut std::io::sink());
        });
    }

    let result = (|| {
        let mut stdin = child.stdin.take().ok_or("无法写入 Agent 引擎。")?;
        stdin
            .write_all(request.as_bytes())
            .map_err(|e| format!("无法向 Agent 引擎发送请求：{e}"))?;
        stdin
            .flush()
            .map_err(|e| format!("无法向 Agent 引擎发送请求：{e}"))?;

        let stdout = child.stdout.take().ok_or("无法读取 Agent 引擎输出。")?;
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        if sender.send(line).is_err() {
                            break;
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });

        let deadline = std::time::Instant::now() + budget;
        while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
            let line = receiver
                .recv_timeout(remaining)
                .map_err(|_| "Agent 引擎未在限定时间内响应。".to_string())?;
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if super::protocol::response_id(&value) == Some(id) {
                return super::protocol::result(value);
            }
        }
        Err("Agent 引擎未在限定时间内响应。".into())
    })();

    let _ = child.kill();
    let _ = child.wait();
    result
}

/// A long-lived engine process.
///
/// Threads and turns share one process per (project, conversation): the engine keeps
/// thread state in memory, so a one-shot process could not continue a
/// conversation. Reading happens on a worker thread; notifications are queued so
/// a caller waiting on a response never loses them.
pub struct EngineSession {
    child: Child,
    stdin: ChildStdin,
    lines: mpsc::Receiver<String>,
    stderr: Arc<Mutex<String>>,
    next_id: u64,
    /// Messages that arrived while waiting for a response. Approvals land here;
    /// dropping them would hang the turn, so they wait for the UI.
    pending: Vec<serde_json::Value>,
}

impl EngineSession {
    /// The app-server must complete JSON-RPC initialization before it accepts
    /// thread/turn requests. Older builds happened to fail later with a closed
    /// pipe, which hid the real startup mistake from the user.
    fn initialize(&mut self) -> Result<(), String> {
        let response = self.call(
            "initialize",
            serde_json::json!({
                "clientInfo": {
                    "name": "scientify",
                    "title": "Scientify",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "capabilities": {
                    "experimentalApi": true,
                    "requestAttestation": false
                }
            }),
            Duration::from_secs(20),
        )?;
        if response.get("userAgent").is_none() {
            return Err("Agent 引擎初始化响应缺少 userAgent。".into());
        }
        self.stdin
            .write_all(
                super::protocol::notification("initialized", serde_json::json!({})).as_bytes(),
            )
            .and_then(|()| self.stdin.flush())
            .map_err(|e| format!("无法完成 Agent 引擎初始化：{e}"))
    }

    /// Spawn an engine-shaped process. Tests substitute a stub so the framing
    /// can be verified without credentials; production always passes the
    /// packaged binary.
    #[cfg(test)]
    pub fn start_with(
        program: &Path,
        args: &[&str],
        codex_home: &Path,
        root: &Path,
        extra_env: &[(String, String)],
    ) -> Result<Self, String> {
        Self::start_with_events_raw(program, args, codex_home, root, extra_env, None)
    }

    /// Spawn and initialize a session, forwarding non-response messages to a
    /// host callback as soon as they arrive. The callback never replaces the
    /// recovery queue.
    pub fn start_with_events(
        program: &Path,
        args: &[&str],
        codex_home: &Path,
        root: &Path,
        extra_env: &[(String, String)],
        event_sink: Option<EventSink>,
    ) -> Result<Self, String> {
        let mut session =
            Self::start_with_events_raw(program, args, codex_home, root, extra_env, event_sink)?;
        session.initialize()?;
        Ok(session)
    }

    fn start_with_events_raw(
        program: &Path,
        args: &[&str],
        codex_home: &Path,
        root: &Path,
        extra_env: &[(String, String)],
        event_sink: Option<EventSink>,
    ) -> Result<Self, String> {
        let mut command = Command::new(program);
        command
            .args(args)
            // Analytics stay off: the engine defaults app-server analytics to
            // disabled and we simply never opt in.
            .env("CODEX_HOME", super::execution::canonical_path(codex_home))
            // The API key travels here rather than in config.toml, so it never
            // reaches disk.
            .envs(extra_env.iter().map(|(key, value)| (key, value)))
            .current_dir(super::execution::canonical_path(root))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        hide_console_window(&mut command);
        let mut child = spawn_engine(&mut command, codex_home)?;
        let stdin = child.stdin.take().ok_or("无法写入 Agent 引擎。")?;
        let stdout = child.stdout.take().ok_or("无法读取 Agent 引擎输出。")?;
        let stderr = child.stderr.take().ok_or("无法读取 Agent 引擎错误输出。")?;
        let (sender, lines) = mpsc::channel();
        let event_sink = event_sink.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if !line.trim().is_empty() => {
                        if sender.send(line.clone()).is_err() {
                            break;
                        }
                        if let Some(sink) = &event_sink {
                            if let Some(incoming) = super::protocol::classify(&line) {
                                let described = super::protocol::describe(&incoming);
                                if !described.is_null() {
                                    sink(described);
                                }
                            }
                        }
                    }
                    Ok(_) => {}
                    Err(_) => break,
                }
            }
        });
        let stderr_text = Arc::new(Mutex::new(String::new()));
        let stderr_copy = Arc::clone(&stderr_text);
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut text) = stderr_copy.lock() {
                    if text.len() < 8192 {
                        text.push_str(&line);
                        text.push('\n');
                    }
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            lines,
            stderr: stderr_text,
            next_id: 0,
            pending: Vec::new(),
        })
    }

    /// Send a request and wait for its response, discarding nothing.
    pub fn call(
        &mut self,
        method: &str,
        params: serde_json::Value,
        budget: Duration,
    ) -> Result<serde_json::Value, String> {
        self.next_id += 1;
        let id = self.next_id;
        self.stdin
            .write_all(super::protocol::request(id, method, params).as_bytes())
            .and_then(|()| self.stdin.flush())
            .map_err(|e| self.pipe_error("无法向 Agent 引擎发送请求", e))?;
        let deadline = std::time::Instant::now() + budget;
        while let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) {
            let Ok(line) = self.lines.recv_timeout(remaining) else {
                return Err("Agent 引擎未在限定时间内响应。".into());
            };
            let Some(incoming) = super::protocol::classify(&line) else {
                continue;
            };
            match incoming {
                super::protocol::Incoming::Response { id: got, value } if got == id => {
                    return super::protocol::result(value);
                }
                other => {
                    let described = super::protocol::describe(&other);
                    if !described.is_null() {
                        self.pending.push(described);
                    }
                }
            }
        }
        Err("Agent 引擎未在限定时间内响应。".into())
    }

    /// A managed command owns a connection, so cancellation and streamed bytes
    /// can be handled without taking a conversation's command lock.
    pub fn run_command(
        &mut self,
        params: serde_json::Value,
        cancelled: &std::sync::atomic::AtomicBool,
        mut output: impl FnMut(&serde_json::Value) -> Result<(), String>,
    ) -> Result<serde_json::Value, String> {
        use std::sync::atomic::Ordering;
        self.next_id += 1;
        let id = self.next_id;
        #[cfg(not(windows))]
        let process_id = params["processId"].clone();
        self.stdin
            .write_all(super::protocol::request(id, "command/exec", params).as_bytes())
            .and_then(|()| self.stdin.flush())
            .map_err(|e| self.pipe_error("无法启动实验", e))?;
        let mut stopped = None;
        loop {
            output(&serde_json::Value::Null)?;
            if cancelled.load(Ordering::SeqCst) && stopped.is_none() {
                #[cfg(not(windows))]
                {
                    self.next_id += 1;
                    self.stdin
                        .write_all(
                            super::protocol::request(
                                self.next_id,
                                "command/exec/terminate",
                                serde_json::json!({"processId": process_id}),
                            )
                            .as_bytes(),
                        )
                        .and_then(|()| self.stdin.flush())
                        .map_err(|e| self.pipe_error("无法停止实验", e))?;
                }
                stopped = Some(std::time::Instant::now());
            }
            if stopped.is_some_and(|time| time.elapsed() > Duration::from_secs(5)) {
                self.terminate();
                return Err("实验停止超时，已断开执行连接。".into());
            }
            let line = match self.lines.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    self.ensure_alive()?;
                    continue;
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("实验执行连接已关闭。".into())
                }
            };
            match super::protocol::classify(&line) {
                Some(super::protocol::Incoming::Response { id: got, value }) if got == id => {
                    return super::protocol::result(value)
                }
                Some(super::protocol::Incoming::Notification { method, params })
                    if method == "command/exec/outputDelta" =>
                {
                    output(&params)?
                }
                _ => {}
            }
        }
    }

    /// Take the messages queued since the last drain.
    pub fn take_pending(&mut self) -> Vec<serde_json::Value> {
        // `call` stops as soon as it sees its own response. Notifications and
        // server requests emitted immediately afterwards can still be sitting
        // in the reader channel, so draining only `pending` would lose the
        // first turn events (and leave the UI waiting forever).
        self.drain_available();
        std::mem::take(&mut self.pending)
    }

    pub fn terminate(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }

    pub fn ensure_alive(&mut self) -> Result<(), String> {
        match self.child.try_wait().map_err(|e| e.to_string())? {
            None => Ok(()),
            Some(status) => Err(format!(
                "Agent 引擎已退出（{status}），可重新连接后继续会话。"
            )),
        }
    }

    /// Collect every line currently available without blocking. This is used
    /// by polling callers and by the asynchronous setup handshake.
    fn drain_available(&mut self) {
        while let Ok(line) = self.lines.try_recv() {
            if let Some(incoming) = super::protocol::classify(&line) {
                let described = super::protocol::describe(&incoming);
                if !described.is_null() {
                    self.pending.push(described);
                }
            }
        }
    }

    /// Wait for one named notification while preserving every other message.
    /// Codex's Windows sandbox setup returns before it finishes and reports the
    /// final result as `windowsSandbox/setupCompleted` on the same stream.
    pub fn wait_for_notification(
        &mut self,
        method: &str,
        budget: Duration,
    ) -> Result<Option<serde_json::Value>, String> {
        let deadline = std::time::Instant::now() + budget;
        loop {
            if let Some(index) = self
                .pending
                .iter()
                .position(|event| event["kind"] == "notification" && event["method"] == method)
            {
                let event = self.pending.remove(index);
                return Ok(Some(event["params"].clone()));
            }
            let Some(remaining) = deadline.checked_duration_since(std::time::Instant::now()) else {
                return Ok(None);
            };
            let line = match self.lines.recv_timeout(remaining) {
                Ok(line) => line,
                Err(mpsc::RecvTimeoutError::Timeout) => return Ok(None),
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(self.pipe_error(
                        "Agent 引擎已退出",
                        std::io::Error::new(std::io::ErrorKind::BrokenPipe, "管道已关闭"),
                    ))
                }
            };
            if let Some(incoming) = super::protocol::classify(&line) {
                let described = super::protocol::describe(&incoming);
                if described.is_null() {
                    continue;
                }
                if described["kind"] == "notification" && described["method"] == method {
                    return Ok(Some(described["params"].clone()));
                }
                self.pending.push(described);
            }
        }
    }

    /// Answer a server-initiated request, such as an approval prompt.
    pub fn respond(
        &mut self,
        id: &serde_json::Value,
        result: serde_json::Value,
    ) -> Result<(), String> {
        self.stdin
            .write_all(super::protocol::response(id, result).as_bytes())
            .and_then(|()| self.stdin.flush())
            .map_err(|e| self.pipe_error("无法回应 Agent 引擎", e))
    }

    fn pipe_error(&self, prefix: &str, error: std::io::Error) -> String {
        let detail = self
            .stderr
            .lock()
            .ok()
            .map(|text| text.trim().to_string())
            .map(|text| {
                text.lines()
                    .filter(|line| !is_nonfatal_diagnostic(line))
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .filter(|text| !text.is_empty())
            .map(|text| format!("\n引擎输出：{text}"))
            .unwrap_or_default();
        format!("{prefix}：{error}{detail}")
    }
}

/// Codex performs optional plugin/catalog work in the background. Its stderr
/// contains warnings such as a GitHub rate-limit response even when the JSON
/// RPC engine is healthy. Those diagnostics must not turn a later transport
/// error into a frightening, unrelated warning in the assistant panel.
fn is_nonfatal_diagnostic(line: &str) -> bool {
    let line = line.to_ascii_lowercase();
    line.starts_with("warning:")
        || line.contains("curated plugin sync")
        || line.contains("featured plugin ids cache")
        || line.contains("shell snapshot not supported")
        || line.contains("unknown model")
}

impl Drop for EngineSession {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stub engine: answers one request while emitting a notification and an
    /// approval request, then echoes the approval decision back.
    const STUB: &str = r#"
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'thread/start') {
    send({ jsonrpc: '2.0', id: message.id, result: { ok: true } });
    send({ jsonrpc: '2.0', method: 'turn/started', params: { turnId: 't1' } });
    send({ jsonrpc: '2.0', id: 'approval-1', method: 'item/fileChange/requestApproval', params: { reason: 'write' } });
  } else if (message.method === 'probe') {
    send({ jsonrpc: '2.0', id: message.id, result: { probed: true } });
  } else if (message.result) {
    send({ jsonrpc: '2.0', method: 'approval/answered', params: { decision: message.result.decision } });
  }
});
"#;

    #[test]
    fn a_missing_engine_and_a_missing_home_are_reported_as_text() {
        // The engine path is resolved from real locations only; asserting the
        // failure shape keeps the command layer honest about never panicking.
        let error = exchange(
            Path::new("definitely-not-an-engine"),
            Path::new("."),
            String::new(),
            1,
            Duration::from_millis(500),
        );
        assert!(error.unwrap_err().contains("无法启动 Agent 引擎"));
    }

    #[test]
    fn handshake_diagnostics_cannot_fill_the_pipe_and_block_the_response() {
        let temporary = tempfile::tempdir().unwrap();
        let script = r#"
require('node:readline').createInterface({input:process.stdin}).once('line', () => {
  process.stderr.write('diagnostic\n'.repeat(100000), () => {
    process.stdout.write(JSON.stringify({id:1,result:{ready:true}}) + '\n');
  });
});
"#;
        let response = exchange_with(
            Path::new("node"),
            &["-e", script],
            temporary.path(),
            "{}\n".into(),
            1,
            Duration::from_secs(20),
        )
        .unwrap();
        assert_eq!(response["ready"], true);
    }

    #[test]
    fn an_approval_request_is_surfaced_kept_in_order_and_can_be_answered() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().to_path_buf();
        // This repository already requires Node, so the stub needs no extra tool.
        let mut session =
            EngineSession::start_with(Path::new("node"), &["-e", STUB], &home, &home, &[])
                .expect("node must be available to run the stub engine");

        let reply = session
            .call(
                "thread/start",
                serde_json::json!({}),
                Duration::from_secs(20),
            )
            .expect("the stub answers immediately");
        assert_eq!(reply["ok"], true);

        // A call returns as soon as its own response arrives. The drain must
        // still pick up notifications emitted in the same burst; otherwise the
        // real turn would never surface its approval or completion event.
        std::thread::sleep(Duration::from_millis(20));
        let events = session.take_pending();
        assert_eq!(events.len(), 2, "expected a notification and an approval");
        assert_eq!(events[0]["kind"], "notification");
        assert_eq!(events[0]["method"], "turn/started");
        assert_eq!(events[1]["kind"], "request");
        assert_eq!(events[1]["method"], "item/fileChange/requestApproval");
        assert_eq!(events[1]["id"], "approval-1");
        assert_eq!(events[1]["params"]["reason"], "write");
        assert!(session.take_pending().is_empty(), "draining is one-shot");

        session
            .respond(
                &events[1]["id"],
                serde_json::json!({ "decision": "accept" }),
            )
            .expect("the approval reply must reach the engine");

        // Round trip: the stub echoes the decision, proving the id matched and
        // that the response line was written rather than dropped.
        session
            .call("probe", serde_json::json!({}), Duration::from_secs(20))
            .expect("the stub answers the probe");
        let echoed = session.take_pending();
        assert_eq!(echoed.len(), 1);
        assert_eq!(echoed[0]["method"], "approval/answered");
        assert_eq!(echoed[0]["params"]["decision"], "accept");
    }

    #[test]
    fn event_sink_wakes_the_host_without_replacing_the_recovery_queue() {
        let temporary = tempfile::tempdir().unwrap();
        let home = temporary.path().to_path_buf();
        let received = Arc::new(Mutex::new(Vec::<serde_json::Value>::new()));
        let copy = Arc::clone(&received);
        let sink: EventSink = Arc::new(move |event| {
            copy.lock().unwrap().push(event);
        });
        let mut session = EngineSession::start_with_events_raw(
            Path::new("node"),
            &["-e", STUB],
            &home,
            &home,
            &[],
            Some(sink),
        )
        .expect("node must be available to run the stub engine");

        session
            .call(
                "thread/start",
                serde_json::json!({}),
                Duration::from_secs(20),
            )
            .expect("the stub answers immediately");
        std::thread::sleep(Duration::from_millis(20));
        let events = received.lock().unwrap().clone();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["method"], "turn/started");
        assert_eq!(events[1]["method"], "item/fileChange/requestApproval");
        assert_eq!(session.take_pending().len(), 2);
    }
}
