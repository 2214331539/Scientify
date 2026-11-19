//! Cloud hosts over SSH. The system OpenSSH client connects, so `~/.ssh/config`
//! aliases, keys, the agent and jump hosts work as they do in a terminal. Each
//! connection keeps one `sh` running on the host; listing, reading and writing
//! files are short scripts sent to it, each answered up to an end marker.
use base64::Engine;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{Manager, State};

/// Text files larger than this open in a terminal, not the editor.
const READ_LIMIT: u64 = 5 * 1024 * 1024;
const QUICK: Duration = Duration::from_secs(30);
const SLOW: Duration = Duration::from_secs(120);
/// Errors the page acts on carry a prefix: a password is needed, or the line dropped.
const AUTH: &str = "AUTH:";
const GONE: &str = "DISCONNECTED:";

#[derive(Default)]
pub struct RemoteState {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

struct Channel {
    stdin: ChildStdin,
    output: Receiver<Vec<u8>>,
    buffer: Vec<u8>,
    counter: u64,
    broken: bool,
}

pub(crate) struct Session {
    target: String,
    child: Mutex<Child>,
    channel: Mutex<Channel>,
    errors: Arc<Mutex<Vec<u8>>>,
}

impl Drop for Session {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// `'it'\''s'`: a word the remote shell reads back exactly.
fn quote(text: &str) -> String {
    format!("'{}'", text.replace('\'', r"'\''"))
}

fn checked(path: &str) -> Result<&str, String> {
    if !path.starts_with('/') || path.len() > 4096 || path.contains(['\0', '\n', '\r']) {
        return Err("路径无效。".into());
    }
    Ok(path)
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from)
}

fn ssh_program() -> PathBuf {
    #[cfg(windows)]
    {
        // Windows' own OpenSSH, not another `ssh` that happens to be on PATH.
        let root = std::env::var_os("SystemRoot")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let native = root.join(r"System32\OpenSSH\ssh.exe");
        if native.is_file() {
            return native;
        }
    }
    PathBuf::from("ssh")
}

/// `user@host`, `user@host:2222`, `ssh user@host -p 2222` or a `~/.ssh/config` alias.
pub(crate) fn destination(target: &str) -> Result<Vec<String>, String> {
    let invalid = || "请输入 用户名@主机，或 ~/.ssh/config 里的主机名。".to_string();
    let mut words: Vec<&str> = target.split_whitespace().collect();
    if words.first() == Some(&"ssh") {
        words.remove(0);
    }
    let mut port = None;
    let mut host = None;
    let mut index = 0;
    while index < words.len() {
        match words[index] {
            "-p" => {
                port = Some(words.get(index + 1).ok_or_else(invalid)?.to_string());
                index += 2;
            }
            word if word.starts_with('-') || host.is_some() => return Err(invalid()),
            word => {
                host = Some(word.to_string());
                index += 1;
            }
        }
    }
    let mut host = host.ok_or_else(invalid)?;
    if port.is_none() {
        if let Some((rest, number)) = host.rsplit_once(':') {
            if !number.is_empty()
                && number.chars().all(|c| c.is_ascii_digit())
                && !rest.contains(':')
            {
                port = Some(number.to_string());
                host = rest.to_string();
            }
        }
    }
    if host.chars().any(|c| c.is_control()) || host.is_empty() {
        return Err(invalid());
    }
    let mut args = vec![];
    if let Some(port) = port {
        if port.parse::<u16>().map_or(true, |p| p == 0) {
            return Err("端口无效。".into());
        }
        args.extend(["-p".to_string(), port]);
    }
    args.push(host);
    Ok(args)
}

fn options(password: bool) -> Vec<String> {
    let mut list = vec![
        "ServerAliveInterval=30",
        "ServerAliveCountMax=3",
        "ConnectTimeout=15",
        // Trust a host the first time, as VS Code does; refuse one whose key changed.
        "StrictHostKeyChecking=accept-new",
    ];
    if password {
        list.extend([
            "BatchMode=no",
            "NumberOfPasswordPrompts=1",
            "PreferredAuthentications=keyboard-interactive,password",
        ]);
    } else {
        list.push("BatchMode=yes");
    }
    list.into_iter()
        .flat_map(|o| ["-o".to_string(), o.to_string()])
        .collect()
}

impl Session {
    /// Runs `command` (ssh, or a local `sh` in tests) as the session's shell.
    fn start(target: &str, mut command: Command) -> Result<Session, String> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动 ssh：{error}。请确认系统已安装 OpenSSH 客户端。"))?;
        let stdin = child.stdin.take().ok_or("ssh 没有输入通道。")?;
        let mut stdout = child.stdout.take().ok_or("ssh 没有输出通道。")?;
        let mut stderr = child.stderr.take().ok_or("ssh 没有错误通道。")?;
        let (sender, output) = mpsc::channel();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 16384];
            while let Ok(count) = stdout.read(&mut chunk) {
                if count == 0 || sender.send(chunk[..count].to_vec()).is_err() {
                    break;
                }
            }
        });
        let errors = Arc::new(Mutex::new(Vec::new()));
        let sink = errors.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(count) = stderr.read(&mut chunk) {
                if count == 0 {
                    break;
                }
                if let Ok(mut text) = sink.lock() {
                    text.extend_from_slice(&chunk[..count]);
                    let excess = text.len().saturating_sub(16384);
                    text.drain(..excess);
                }
            }
        });
        Ok(Session {
            target: target.to_string(),
            child: Mutex::new(child),
            channel: Mutex::new(Channel {
                stdin,
                output,
                buffer: vec![],
                counter: 0,
                broken: false,
            }),
            errors,
        })
    }

    /// What ssh said on its error channel, last lines first in importance.
    fn stderr(&self) -> String {
        let text = self
            .errors
            .lock()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default();
        text.lines()
            .map(str::trim)
            .filter(|line| !line.is_empty() && !line.starts_with("Warning: Permanently added"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Runs a script in a subshell and returns its exit code and output (stdout
    /// and stderr together). A command that does not answer breaks the session.
    fn run(&self, script: &str, timeout: Duration) -> Result<(i32, Vec<u8>), String> {
        let mut channel = self.channel.lock().map_err(|e| e.to_string())?;
        if channel.broken {
            return Err(format!("{GONE}连接已断开，请重新连接。"));
        }
        channel.counter += 1;
        let token = format!("SCIENTIFY{}N{}", std::process::id(), channel.counter);
        let command = format!(
            "( {script}\n) </dev/null 2>&1\nprintf '\\036%s %s\\036\\n' '{token}' \"$?\"\n"
        );
        if channel
            .stdin
            .write_all(command.as_bytes())
            .and_then(|_| channel.stdin.flush())
            .is_err()
        {
            channel.broken = true;
            return Err(format!("{GONE}{}", self.lost()));
        }
        let marker = format!("\u{1e}{token} ").into_bytes();
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(at) = find(&channel.buffer, &marker) {
                let tail = at + marker.len();
                if let Some(end) = channel.buffer[tail..].iter().position(|b| *b == 0x1e) {
                    let code = String::from_utf8_lossy(&channel.buffer[tail..tail + end])
                        .trim()
                        .parse()
                        .unwrap_or(-1);
                    let output = channel.buffer[..at].to_vec();
                    let mut rest = tail + end + 1;
                    if channel.buffer.get(rest) == Some(&b'\n') {
                        rest += 1;
                    }
                    channel.buffer.drain(..rest);
                    return Ok((code, output));
                }
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                channel.broken = true;
                return Err(format!("{GONE}云主机长时间没有响应，连接已断开。"));
            }
            match channel.output.recv_timeout(left) {
                Ok(chunk) => channel.buffer.extend_from_slice(&chunk),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    channel.broken = true;
                    return Err(format!("{GONE}{}", self.lost()));
                }
            }
        }
    }

    fn lost(&self) -> String {
        let said = self.stderr();
        if said.is_empty() {
            "连接已断开，请重新连接。".into()
        } else {
            format!("连接已断开：{}", said.lines().last().unwrap_or(""))
        }
    }

    /// Runs a script that must succeed; its output is the error message otherwise.
    fn ok(&self, script: &str, timeout: Duration) -> Result<Vec<u8>, String> {
        let (code, output) = self.run(script, timeout)?;
        if code == 0 {
            Ok(output)
        } else {
            let text = String::from_utf8_lossy(&output).trim().to_string();
            Err(if text.is_empty() {
                format!("云主机上的命令失败（{code}）。")
            } else {
                text
            })
        }
    }
}

/// The first answer proves the login worked. Anything a login script printed
/// before it is skipped; `$HOME` is the last line.
fn greet(session: &Session) -> Result<String, String> {
    match session.run("printf '%s\\n' \"$HOME\"", Duration::from_secs(40)) {
        Ok((0, output)) => Ok(String::from_utf8_lossy(&output)
            .lines()
            .map(str::trim)
            .rfind(|line| line.starts_with('/'))
            .unwrap_or("/")
            .to_string()),
        Ok((code, output)) => Err(format!(
            "云主机无法启动 sh（{code}）：{}",
            String::from_utf8_lossy(&output).trim()
        )),
        Err(_) => {
            // ssh exited: say why in words a person can act on.
            std::thread::sleep(Duration::from_millis(150));
            let said = session.stderr();
            #[cfg(test)]
            if std::env::var_os("SCIENTIFY_SSH_VERBOSE").is_some() {
                eprintln!("{said}");
            }
            let last = said.lines().last().unwrap_or("").to_string();
            Err(
                if said.contains("Permission denied") || said.contains("Too many authentication") {
                    format!("{AUTH}{last}")
                } else if said.contains("REMOTE HOST IDENTIFICATION HAS CHANGED")
                    || said.contains("Host key verification failed")
                {
                    "这台主机的密钥和上次不同，为安全起见没有连接。确认无误后，在 ~/.ssh/known_hosts 里删掉它的旧记录再试。".into()
                } else if said.contains("Could not resolve hostname") {
                    format!("找不到这台主机：{last}")
                } else if last.is_empty() {
                    "连接失败，ssh 没有给出原因。".into()
                } else {
                    format!("连接失败：{last}")
                },
            )
        }
    }
}

fn connect(target: &str, password: Option<&str>) -> Result<(Session, String), String> {
    let mut command = Command::new(ssh_program());
    #[cfg(test)]
    if std::env::var_os("SCIENTIFY_SSH_VERBOSE").is_some() {
        command.arg("-v");
    }
    command
        .args(options(password.is_some()))
        .arg("-T")
        .args(destination(target)?)
        .arg("sh");
    if let Some(password) = password {
        let me = std::env::current_exe().map_err(|e| e.to_string())?;
        // Tests run without the app's executable; they name it.
        #[cfg(test)]
        let me = std::env::var_os("SCIENTIFY_ASKPASS_PROGRAM")
            .map(PathBuf::from)
            .unwrap_or(me);

        command
            .env("SSH_ASKPASS", me)
            .env("SSH_ASKPASS_REQUIRE", "force")
            .env("DISPLAY", ":0")
            .env("SCIENTIFY_ASKPASS", "1")
            .env("SCIENTIFY_ASKPASS_SECRET", password);
    }
    let session = Session::start(target, command)?;
    let home = greet(&session)?;
    Ok((session, home))
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    alias: String,
    host_name: Option<String>,
    user: Option<String>,
    port: Option<String>,
}

/// The named hosts of an ssh config: `Host` lines without wildcards.
pub(crate) fn config_hosts(text: &str) -> Vec<HostEntry> {
    let mut hosts: Vec<HostEntry> = vec![];
    let mut current: Vec<usize> = vec![];
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((key, value)) => (
                key.to_ascii_lowercase(),
                value.trim().trim_start_matches('=').trim(),
            ),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                current.clear();
                for alias in value.split_whitespace() {
                    if alias.contains(['*', '?', '!']) {
                        continue;
                    }
                    current.push(hosts.len());
                    hosts.push(HostEntry {
                        alias: alias.to_string(),
                        host_name: None,
                        user: None,
                        port: None,
                    });
                }
            }
            "match" => current.clear(),
            "hostname" | "user" | "port" => {
                for &index in &current {
                    let entry = &mut hosts[index];
                    let slot = match key.as_str() {
                        "hostname" => &mut entry.host_name,
                        "user" => &mut entry.user,
                        _ => &mut entry.port,
                    };
                    slot.get_or_insert_with(|| value.to_string());
                }
            }
            _ => {}
        }
    }
    hosts
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    name: String,
    path: String,
    kind: &'static str,
    link: bool,
    size: u64,
    modified: f64,
}

/// Lines of `type<TAB>target type<TAB>size<TAB>mtime<TAB>name`.
pub(crate) fn parse_listing(directory: &str, output: &str) -> Vec<RemoteEntry> {
    let base = directory.trim_end_matches('/');
    let mut entries: Vec<RemoteEntry> = output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(5, '\t');
            let own = parts.next()?;
            let target = parts.next()?;
            let size = parts.next()?.parse().unwrap_or(0);
            let modified = parts.next()?.parse().unwrap_or(0.0);
            let name = parts.next()?;
            if name.is_empty() || name == "." || name == ".." || name.contains('/') {
                return None;
            }
            Some(RemoteEntry {
                name: name.to_string(),
                path: format!("{base}/{name}"),
                kind: if target == "d" { "directory" } else { "file" },
                link: own == "l",
                size,
                modified,
            })
        })
        .collect();
    entries.sort_by(|a, b| {
        (a.kind != "directory")
            .cmp(&(b.kind != "directory"))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    entries
}

const LIST: &str = r#"cd -- {P} || exit 2
if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then
  find . -mindepth 1 -maxdepth 1 -printf '%y\t%Y\t%s\t%T@\t%P\n'
else
  for f in * .[!.]* ..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    if [ -L "$f" ]; then y=l; elif [ -d "$f" ]; then y=d; else y=f; fi
    if [ -d "$f" ]; then t=d; else t=f; fi
    printf '%s\t%s\t0\t0\t%s\n' "$y" "$t" "$f"
  done
fi"#;
const VERSION: &str =
    r#"v() { stat -c '%Y:%s' "$1" 2>/dev/null || stat -f '%m:%z' "$1" 2>/dev/null; }"#;

fn list(session: &Session, path: &str) -> Result<Vec<RemoteEntry>, String> {
    let output = session.ok(&LIST.replace("{P}", &quote(checked(path)?)), SLOW)?;
    Ok(parse_listing(path, &String::from_utf8_lossy(&output)))
}

fn resolve(session: &Session, path: &str) -> Result<String, String> {
    let output = session.ok(&format!("cd -- {} && pwd", quote(checked(path)?)), QUICK)?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteFile {
    path: String,
    content: String,
    version: String,
}

fn read(session: &Session, path: &str) -> Result<RemoteFile, String> {
    let file = quote(checked(path)?);
    let script = format!(
        "{VERSION}\nf={file}\n[ -f \"$f\" ] || {{ echo '这不是文件。'; exit 2; }}\ns=$(wc -c < \"$f\")\n[ \"$s\" -le {READ_LIMIT} ] || {{ echo \"文件太大（$s 字节），请在终端里打开。\"; exit 3; }}\nv \"$f\"\nbase64 < \"$f\""
    );
    let output = session.ok(&script, SLOW)?;
    let text = String::from_utf8_lossy(&output);
    let (version, body) = text.split_once('\n').unwrap_or((&text, ""));
    let packed: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(packed)
        .map_err(|_| "读取文件时内容不完整，请重试。".to_string())?;
    if bytes.contains(&0) {
        return Err("这是二进制文件，不能用编辑器打开。".into());
    }
    let content = String::from_utf8(bytes)
        .map_err(|_| "文件不是 UTF-8 文本，不能用编辑器打开。".to_string())?;
    Ok(RemoteFile {
        path: path.to_string(),
        content,
        version: version.trim().to_string(),
    })
}

fn write(
    session: &Session,
    path: &str,
    content: &str,
    expected: Option<&str>,
) -> Result<RemoteFile, String> {
    let file = quote(checked(path)?);
    let encoded = base64::engine::general_purpose::STANDARD.encode(content.as_bytes());
    let lines: Vec<&str> = encoded
        .as_bytes()
        .chunks(76)
        .map(|c| std::str::from_utf8(c).unwrap_or(""))
        .collect();
    let check = match expected {
        Some(version) => format!(
            "[ \"$(v \"$f\")\" = {} ] || {{ echo '文件已在云主机上被修改，请重新打开后再保存。'; exit 4; }}\n",
            quote(version)
        ),
        None => "[ -e \"$f\" ] && { echo '同名文件已存在。'; exit 4; }\n".into(),
    };
    // Written beside the file first; an existing file keeps its permissions.
    let script = format!(
        "{VERSION}\nf={file}\n{check}t=\"$f.scientify-$$\"\nbase64 -d > \"$t\" <<'__SCIENTIFY_B64__' || {{ rm -f \"$t\"; echo '写入失败。'; exit 5; }}\n{}\n__SCIENTIFY_B64__\nif [ -e \"$f\" ]; then cat \"$t\" > \"$f\" && rm -f \"$t\"; else mv -f \"$t\" \"$f\"; fi || {{ rm -f \"$t\"; echo '写入失败。'; exit 6; }}\nv \"$f\"",
        lines.join("\n")
    );
    let output = session.ok(&script, SLOW)?;
    Ok(RemoteFile {
        path: path.to_string(),
        content: content.to_string(),
        version: String::from_utf8_lossy(&output).trim().to_string(),
    })
}

fn create(session: &Session, path: &str, directory: bool) -> Result<(), String> {
    let target = quote(checked(path)?);
    let script = if directory {
        format!("[ -e {target} ] && {{ echo '同名项目已存在。'; exit 2; }}; mkdir -- {target}")
    } else {
        format!("[ -e {target} ] && {{ echo '同名项目已存在。'; exit 2; }}; : > {target}")
    };
    session.ok(&script, QUICK).map(|_| ())
}

fn rename(session: &Session, from: &str, to: &str) -> Result<(), String> {
    let (from, to) = (quote(checked(from)?), quote(checked(to)?));
    session
        .ok(
            &format!("[ -e {to} ] && {{ echo '同名项目已存在。'; exit 2; }}; mv -- {from} {to}"),
            QUICK,
        )
        .map(|_| ())
}

fn delete(session: &Session, path: &str) -> Result<(), String> {
    let path = checked(path)?.trim_end_matches('/');
    // Never `/` or a top-level folder such as `/home` or `/usr`.
    if path.split('/').filter(|part| !part.is_empty()).count() < 2 {
        return Err("不能删除这个位置。".into());
    }
    session
        .ok(&format!("rm -rf -- {}", quote(path)), SLOW)
        .map(|_| ())
}

fn session(state: &RemoteState, id: &str) -> Result<Arc<Session>, String> {
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .get(id)
        .cloned()
        .ok_or_else(|| format!("{GONE}连接已断开，请重新连接。"))
}

/// Runs an operation on a session off the UI thread; a dropped line is forgotten.
async fn with<T: Send + 'static>(
    app: &tauri::AppHandle<impl tauri::Runtime>,
    id: String,
    work: impl FnOnce(&Session) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let current = session(&app.state::<RemoteState>(), &id)?;
    let result = tauri::async_runtime::spawn_blocking(move || work(&current))
        .await
        .map_err(|e| e.to_string())?;
    if let Err(error) = &result {
        if error.starts_with(GONE) {
            if let Ok(mut sessions) = app.state::<RemoteState>().sessions.lock() {
                sessions.remove(&id);
            }
        }
    }
    result
}

#[tauri::command]
pub fn remote_hosts<R: tauri::Runtime>(view: tauri::Webview<R>) -> Result<Vec<HostEntry>, String> {
    crate::library::trusted(&view)?;
    let Some(home) = home_dir() else {
        return Ok(vec![]);
    };
    Ok(std::fs::read_to_string(home.join(".ssh").join("config"))
        .map(|text| config_hosts(&text))
        .unwrap_or_default())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    id: String,
    target: String,
    home: String,
}

#[tauri::command]
pub async fn remote_connect<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    target: String,
    password: Option<String>,
) -> Result<Connection, String> {
    crate::library::trusted(&view)?;
    let named = target.trim().to_string();
    let (session, home) =
        tauri::async_runtime::spawn_blocking(move || connect(&named, password.as_deref()))
            .await
            .map_err(|e| e.to_string())??;
    let id = uuid::Uuid::new_v4().to_string();
    let target = session.target.clone();
    app.state::<RemoteState>()
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .insert(id.clone(), Arc::new(session));
    Ok(Connection { id, target, home })
}

#[tauri::command]
pub fn remote_disconnect<R: tauri::Runtime>(
    view: tauri::Webview<R>,
    state: State<'_, RemoteState>,
    id: String,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    state
        .sessions
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn remote_list<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    id: String,
    path: String,
) -> Result<Vec<RemoteEntry>, String> {
    crate::library::trusted(&view)?;
    with(&app, id, move |s| list(s, &path)).await
}

#[tauri::command]
pub async fn remote_resolve<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    id: String,
    path: String,
) -> Result<String, String> {
    crate::library::trusted(&view)?;
    with(&app, id, move |s| resolve(s, &path)).await
}

#[tauri::command]
pub async fn remote_read<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    id: String,
    path: String,
) -> Result<RemoteFile, String> {
    crate::library::trusted(&view)?;
    with(&app, id, move |s| read(s, &path)).await
}

#[tauri::command]
pub async fn remote_write<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    id: String,
    path: String,
    content: String,
    expected_version: Option<String>,
) -> Result<RemoteFile, String> {
    crate::library::trusted(&view)?;
    if content.len() as u64 > READ_LIMIT {
        return Err("文件超过 5 MiB，请在终端里编辑。".into());
    }
    with(&app, id, move |s| {
        write(s, &path, &content, expected_version.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn remote_create<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    id: String,
    path: String,
    directory: bool,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    with(&app, id, move |s| create(s, &path, directory)).await
}

#[tauri::command]
pub async fn remote_rename<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    with(&app, id, move |s| rename(s, &from, &to)).await
}

#[tauri::command]
pub async fn remote_delete<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    id: String,
    path: String,
) -> Result<(), String> {
    crate::library::trusted(&view)?;
    with(&app, id, move |s| delete(s, &path)).await
}

/// A terminal on the host, in `path`: ssh in a pseudo-terminal, so a password
/// prompt, colors and full-screen programs work as in any terminal.
#[tauri::command]
pub async fn remote_terminal<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    view: tauri::Webview<R>,
    project_id: String,
    id: String,
    path: String,
) -> Result<crate::experiments::terminal::TerminalInfo, String> {
    crate::library::trusted(&view)?;
    let current = session(&app.state::<RemoteState>(), &id)?;
    let mut args = options(false);
    // A terminal can ask for a password itself.
    args.retain(|a| a != "BatchMode=yes");
    if args.last().is_some_and(|a| a == "-o") {
        args.pop();
    }
    args.push("-t".into());
    args.extend(destination(&current.target)?);
    args.push(format!(
        "cd {} 2>/dev/null; exec \"${{SHELL:-sh}}\" -l",
        quote(checked(&path)?)
    ));
    let local = home_dir().unwrap_or_else(std::env::temp_dir);
    let host = current.target.clone();
    let copy = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<crate::experiments::terminal::TerminalState>()
            .open(
                crate::experiments::terminal::TerminalInfo {
                    id: uuid::Uuid::new_v4().to_string(),
                    project: project_id,
                    experiment_id: format!("remote:{id}"),
                    root: local.display().to_string(),
                    name: host,
                    profile: "ssh".into(),
                    environment: None,
                    status: "running".into(),
                    exit_code: None,
                },
                &ssh_program(),
                &args,
                &Default::default(),
                Some(Arc::new(move |value| {
                    let _ = tauri::Emitter::emit(&copy, "terminal-event", value);
                })),
            )
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_targets_the_way_people_type_them() {
        assert_eq!(destination("pp@1.2.3.4").unwrap(), vec!["pp@1.2.3.4"]);
        assert_eq!(
            destination("pp@1.2.3.4:2222").unwrap(),
            vec!["-p", "2222", "pp@1.2.3.4"]
        );
        assert_eq!(
            destination("ssh pp@host -p 2200").unwrap(),
            vec!["-p", "2200", "pp@host"]
        );
        assert_eq!(destination("gpu-box").unwrap(), vec!["gpu-box"]);
        assert!(destination("-oProxyCommand=evil host").is_err());
        assert!(destination("a b").is_err());
        assert!(destination("host:0").is_err());
    }

    #[test]
    fn lists_named_hosts_from_an_ssh_config() {
        let text = "Host *\n  ServerAliveInterval 30\nHost gpu lab-gpu\n  HostName 10.0.0.5\n  User alice\n  Port 2222\n\n# comment\nHost Tengxun_big_pp\n    HostName=124.221.115.83\n    User pp\nMatch host x\n  User nobody\n";
        let hosts = config_hosts(text);
        assert_eq!(hosts.len(), 3);
        assert_eq!(hosts[0].alias, "gpu");
        assert_eq!(hosts[1].host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(hosts[1].port.as_deref(), Some("2222"));
        assert_eq!(hosts[2].host_name.as_deref(), Some("124.221.115.83"));
        assert_eq!(hosts[2].user.as_deref(), Some("pp"));
    }

    #[test]
    fn listings_put_folders_first_and_follow_links_to_folders() {
        let output = "f\tf\t12\t1700000000.5\tb.py\nd\td\t4096\t1700000000\tsrc\nl\td\t9\t0\tdata\nf\tf\t1\t0\tA.txt\nl\tN\t3\t0\tbroken\n";
        let entries = parse_listing("/home/pp/", output);
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["data", "src", "A.txt", "b.py", "broken"]);
        assert_eq!(entries[0].kind, "directory");
        assert!(entries[0].link);
        assert_eq!(entries[1].path, "/home/pp/src");
        assert_eq!(entries[3].size, 12);
    }

    #[test]
    fn quotes_survive_the_shell() {
        assert_eq!(quote("it's"), r"'it'\''s'");
        assert!(checked("relative").is_err());
        assert!(checked("/a\nb").is_err());
    }

    /// The whole protocol against a local `sh`, where one is installed.
    #[test]
    fn lists_reads_writes_and_manages_files_through_a_shell() {
        let sh = which_sh();
        let Some(sh) = sh else { return };
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().replace('\\', "/");
        let root = shell_path(&sh, &root);
        let session = Session::start("local", Command::new(&sh)).unwrap();
        let home = greet(&session).unwrap();
        assert!(home.starts_with('/'));
        let file = format!("{root}/notes it's.txt");
        let written = write(&session, &file, "第一行\nline 2\n", None).unwrap();
        assert!(
            write(&session, &file, "again", None).is_err(),
            "new files do not overwrite"
        );
        let opened = read(&session, &file).unwrap();
        assert_eq!(opened.content, "第一行\nline 2\n");
        assert_eq!(opened.version, written.version);
        write(&session, &file, "changed", Some(&opened.version)).unwrap();
        assert_eq!(read(&session, &file).unwrap().content, "changed");
        create(&session, &format!("{root}/src"), true).unwrap();
        create(&session, &format!("{root}/src/main.py"), false).unwrap();
        let entries = list(&session, &root).unwrap();
        let names: Vec<_> = entries.iter().map(|e| (e.name.as_str(), e.kind)).collect();
        assert_eq!(
            names,
            vec![("src", "directory"), ("notes it's.txt", "file")]
        );
        rename(
            &session,
            &format!("{root}/src/main.py"),
            &format!("{root}/src/app.py"),
        )
        .unwrap();
        assert_eq!(
            list(&session, &format!("{root}/src")).unwrap()[0].name,
            "app.py"
        );
        delete(&session, &format!("{root}/src")).unwrap();
        assert_eq!(list(&session, &root).unwrap().len(), 1);
        assert!(read(&session, &format!("{root}/missing")).is_err());
        assert_eq!(resolve(&session, &format!("{root}/.")).unwrap(), root);
    }

    /// `SCIENTIFY_SSH_TARGET=host cargo test -p scientify -- --ignored live_ssh`: connects
    /// with keys and lists the home folder; nothing on the host changes.
    #[test]
    #[ignore]
    fn live_ssh() {
        let target = std::env::var("SCIENTIFY_SSH_TARGET").expect("SCIENTIFY_SSH_TARGET");
        let started = Instant::now();
        let password = std::env::var("SCIENTIFY_SSH_PASSWORD").ok();
        let (session, home) = connect(&target, password.as_deref()).unwrap();
        println!("connected in {:?}, home {home}", started.elapsed());
        let started = Instant::now();
        let entries = list(&session, &home).unwrap();
        println!(
            "listed {} entries in {:?}",
            entries.len(),
            started.elapsed()
        );
        for entry in entries.iter().take(5) {
            println!("{} {} {}", entry.kind, entry.name, entry.size);
        }
    }

    fn which_sh() -> Option<PathBuf> {
        if cfg!(windows) {
            [
                "D:/Git/Git/usr/bin/sh.exe",
                "C:/Program Files/Git/usr/bin/sh.exe",
            ]
            .iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
        } else {
            Some(PathBuf::from("/bin/sh"))
        }
    }

    /// Git's sh on Windows sees `C:/x` as `/c/x`.
    fn shell_path(sh: &std::path::Path, path: &str) -> String {
        if cfg!(windows) {
            let output = Command::new(sh)
                .args(["-c", &format!("cd {} && pwd", quote(path))])
                .output()
                .unwrap();
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        } else {
            path.to_string()
        }
    }
}
