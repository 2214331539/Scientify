//! Runs inside Codex's sandbox. Structured argv and raw byte logs stay intact.
//! Windows buffered command/exec lacks streaming and terminate controls, so a
//! per-run Job Object and host heartbeat own the entire process tree.
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, SystemTime},
};

#[derive(Deserialize, Serialize)]
pub struct Request {
    pub command: Vec<String>,
    pub cwd: PathBuf,
}

pub fn run(request: &Path) -> Result<i32, String> {
    let result = execute(request);
    if let Err(error) = &result {
        if let Some(path) = request
            .parent()
            .map(|directory| directory.join("output.log"))
        {
            if scientify_core::research::reject_links(&path).is_ok() {
                if let Ok(mut log) = fs::OpenOptions::new().create(true).append(true).open(path) {
                    let _ = writeln!(log, "Scientify runner: {error}");
                }
            }
        }
    }
    result
}

fn execute(request: &Path) -> Result<i32, String> {
    scientify_core::research::reject_links(request)?;
    if fs::metadata(request).map_err(|e| e.to_string())?.len() > 256 * 1024 {
        return Err("运行请求过大。".into());
    }
    let input: Request = serde_json::from_slice(&fs::read(request).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let directory = request.parent().ok_or("运行目录无效。")?;
    let log = fs::File::create(directory.join("output.log")).map_err(|e| e.to_string())?;
    let program = input.command.first().ok_or("运行程序缺失。")?;
    let mut command = Command::new(program);
    command
        .args(&input.command[1..])
        .current_dir(input.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000 | 0x00000004);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let _job = match job::Job::attach(&child) {
        Ok(job) => job,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    loop {
        let heartbeat = directory.join("heartbeat");
        let connected = fs::metadata(&heartbeat)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|time| SystemTime::now().duration_since(time).ok())
            .is_some_and(|elapsed| elapsed < Duration::from_secs(10));
        if directory.join("stop").exists() || !connected {
            #[cfg(windows)]
            _job.terminate()?;
            #[cfg(not(windows))]
            let _ = child.kill();
            let _ = child.wait();
            return Ok(1);
        }
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            return Ok(status.code().unwrap_or(1));
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(windows)]
pub(crate) mod job {
    use std::{os::windows::io::AsRawHandle, process::Child};
    use windows::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::{Diagnostics::ToolHelp::*, JobObjects::*, Threading::*},
    };
    struct Owned(HANDLE);
    // Job handles are kernel objects; ownership may move across threads.
    unsafe impl Send for Owned {}
    impl Drop for Owned {
        fn drop(&mut self) {
            unsafe {
                let _ = CloseHandle(self.0);
            }
        }
    }
    pub struct Job(Owned);
    impl Job {
        pub fn attach_pty(handle: std::os::windows::io::RawHandle) -> Result<Self, String> {
            unsafe {
                let owned = Owned(CreateJobObjectW(None, None).map_err(|e| e.to_string())?);
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    owned.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                )
                .map_err(|e| e.to_string())?;
                AssignProcessToJobObject(owned.0, HANDLE(handle)).map_err(|e| e.to_string())?;
                Ok(Self(owned))
            }
        }
        pub fn attach(child: &Child) -> Result<Self, String> {
            // Start suspended, assign the job, then resume. No descendant can
            // escape between process creation and job assignment.
            unsafe {
                let handle = Owned(CreateJobObjectW(None, None).map_err(|e| e.to_string())?);
                let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                SetInformationJobObject(
                    handle.0,
                    JobObjectExtendedLimitInformation,
                    &limits as *const _ as *const _,
                    std::mem::size_of_val(&limits) as u32,
                )
                .map_err(|e| e.to_string())?;
                AssignProcessToJobObject(handle.0, HANDLE(child.as_raw_handle()))
                    .map_err(|e| e.to_string())?;
                let job = Self(handle);
                let snapshot = Owned(
                    CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(|e| e.to_string())?,
                );
                let mut entry = THREADENTRY32 {
                    dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                    ..Default::default()
                };
                Thread32First(snapshot.0, &mut entry).map_err(|e| e.to_string())?;
                loop {
                    if entry.th32OwnerProcessID == child.id() {
                        let thread = Owned(
                            OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                                .map_err(|e| e.to_string())?,
                        );
                        if ResumeThread(thread.0) == u32::MAX {
                            return Err("无法启动实验线程。".into());
                        }
                        return Ok(job);
                    }
                    if Thread32Next(snapshot.0, &mut entry).is_err() {
                        return Err("实验线程不存在。".into());
                    }
                }
            }
        }
        pub fn terminate(&self) -> Result<(), String> {
            unsafe { TerminateJobObject(self.0 .0, 1).map_err(|e| e.to_string()) }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn runner_start_failure_is_visible_in_log() {
        let directory = tempfile::tempdir().unwrap();
        let request = directory.path().join("request.json");
        std::fs::write(
            &request,
            serde_json::to_vec(&super::Request {
                command: vec![directory
                    .path()
                    .join("missing-program")
                    .display()
                    .to_string()],
                cwd: directory.path().to_path_buf(),
            })
            .unwrap(),
        )
        .unwrap();
        let error = super::run(&request).unwrap_err();
        let log = std::fs::read_to_string(directory.path().join("output.log")).unwrap();
        assert!(log.contains("Scientify runner:"));
        assert!(log.contains(&error));
    }

    #[test]
    #[ignore = "child entrypoint for real sandbox integration tests"]
    fn managed_runner_child() {
        let path = std::env::var_os("SCIENTIFY_FIXTURE_RUNNER").expect("test runner request");
        match super::run(std::path::Path::new(&path)) {
            Ok(code) => std::process::exit(code),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
}
