//! Trusted user commands. Structured argv, hidden windows and owned process trees.
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

pub(crate) fn process_path(path: &Path) -> PathBuf {
    #[cfg(windows)]
    {
        let value = path.to_string_lossy();
        if let Some(value) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{value}"));
        }
        if let Some(value) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(value);
        }
    }
    path.to_path_buf()
}

struct OwnedChild {
    child: Child,
    #[cfg(unix)]
    group: crate::unix_process::Group,
    #[cfg(windows)]
    job: crate::experiments::runner::job::Job,
}
impl OwnedChild {
    fn spawn(command: &mut Command) -> Result<Self, String> {
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000 | 0x00000004);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[allow(unused_mut)]
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        #[cfg(windows)]
        let job = match crate::experiments::runner::job::Job::attach(&child) {
            Ok(job) => job,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };
        Ok(Self {
            #[cfg(unix)]
            group: crate::unix_process::Group::new(child.id()),
            child,
            #[cfg(windows)]
            job,
        })
    }
    fn stop(&mut self) {
        #[cfg(unix)]
        self.group.stop();
        #[cfg(windows)]
        let _ = self.job.terminate();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
impl Drop for OwnedChild {
    fn drop(&mut self) {
        self.stop();
    }
}

pub(crate) fn run_logged(
    program: &Path,
    args: &[String],
    cwd: &Path,
    env: &BTreeMap<String, String>,
    log: &Path,
    cancel: &AtomicBool,
    changed: impl Fn(),
) -> Result<i32, String> {
    let file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log)
        .map_err(|e| e.to_string())?;
    let mut command = Command::new(process_path(program));
    command
        .args(args)
        .current_dir(process_path(cwd))
        .envs(env)
        .stdin(Stdio::null())
        .stdout(Stdio::from(file.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(file));
    if cancel.load(Ordering::SeqCst) {
        return Err("启动前已取消。".into());
    }
    let mut process = OwnedChild::spawn(&mut command)?;
    let mut bytes = 0;
    loop {
        if cancel.load(Ordering::SeqCst) {
            process.stop();
            return Ok(1);
        }
        let length = fs::metadata(log).map_err(|e| e.to_string())?.len();
        if length > 64 * 1024 * 1024 {
            return Err("日志超过 64 MiB，已停止进程。".into());
        }
        if length != bytes {
            bytes = length;
            changed();
        }
        if let Some(status) = process.child.try_wait().map_err(|e| e.to_string())? {
            changed();
            return Ok(status.code().unwrap_or(1));
        }
        thread::sleep(Duration::from_millis(80));
    }
}

// Query commands are bounded, drain both pipes concurrently and kill on timeout.
pub(crate) fn capture(command: &mut Command, timeout: Duration) -> Result<Vec<u8>, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = OwnedChild::spawn(command)?;
    fn drain(mut stream: impl Read + Send + 'static) -> thread::JoinHandle<Vec<u8>> {
        thread::spawn(move || {
            let mut output = Vec::new();
            let mut buf = [0; 8192];
            while let Ok(n) = stream.read(&mut buf) {
                if n == 0 {
                    break;
                }
                let keep = n.min((2 * 1024 * 1024usize).saturating_sub(output.len()));
                output.extend_from_slice(&buf[..keep]);
            }
            output
        })
    }
    let stdout = drain(process.child.stdout.take().ok_or("stdout 不可用。")?);
    let stderr = drain(process.child.stderr.take().ok_or("stderr 不可用。")?);
    let deadline = Instant::now() + timeout;
    let status = loop {
        if let Some(status) = process.child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if Instant::now() >= deadline {
            process.stop();
            return Err("程序检测超时，请检查解释器或工具路径。".into());
        }
        thread::sleep(Duration::from_millis(40));
    };
    // Also terminate grandchildren that retained the output pipes.
    process.stop();
    let out = stdout.join().map_err(|_| "无法读取程序输出。")?;
    let err = stderr.join().map_err(|_| "无法读取程序错误。")?;
    if !status.success() {
        return Err(String::from_utf8_lossy(&err).trim().to_string());
    }
    Ok(out)
}

pub(crate) fn append_error(log: &Path, error: &str) {
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(file, "\nScientify: {error}");
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn capture_closes_inherited_pipes_and_stops_descendants() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("escaped");
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "(sleep 1; echo escaped > \"$1\") & echo captured",
                "sh",
            ])
            .arg(&marker);
        let start = Instant::now();
        let output = capture(&mut command, Duration::from_secs(3)).unwrap();
        assert!(String::from_utf8_lossy(&output).contains("captured"));
        assert!(start.elapsed() < Duration::from_secs(2));
        thread::sleep(Duration::from_millis(1200));
        assert!(!marker.exists(), "a descendant survived the owning command");
    }
}
