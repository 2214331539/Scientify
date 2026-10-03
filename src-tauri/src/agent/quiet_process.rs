//! Run the unmodified engine on a non-interactive desktop. Startup probes and
//! helper processes inherit this desktop; sandbox policy is unchanged.
use std::{
    collections::BTreeMap,
    ffi::{OsStr, OsString},
    fs::File,
    io,
    os::windows::{
        ffi::OsStrExt,
        io::{FromRawHandle, OwnedHandle},
    },
    process::{Command, ExitStatus},
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Security::SECURITY_ATTRIBUTES,
    System::{Pipes::CreatePipe, StationsAndDesktops::*, Threading::*},
};

pub struct QuietChild {
    process: OwnedHandle,
    desktop: HDESK,
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    pub stderr: Option<File>,
}
// The desktop stays alive until the engine exits and is never switched onto the display.
unsafe impl Send for QuietChild {}

fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}

fn quote(value: &OsStr) -> Vec<u16> {
    // Windows CRT argv quoting, including trailing backslashes and embedded quotes.
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for c in value.encode_wide() {
        if c == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            b'\\' as u16,
            if c == b'"' as u16 {
                slashes * 2 + 1
            } else {
                slashes
            },
        ));
        slashes = 0;
        result.push(c);
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    result
}

fn pipe(child_reads: bool) -> io::Result<(File, OwnedHandle)> {
    let security = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    };
    let (mut read, mut write) = (ptr::null_mut(), ptr::null_mut());
    unsafe {
        if CreatePipe(&mut read, &mut write, &security, 0) == 0 {
            return Err(io::Error::last_os_error());
        }
        let read = OwnedHandle::from_raw_handle(read);
        let write = OwnedHandle::from_raw_handle(write);
        let (parent, child) = if child_reads {
            (write, read)
        } else {
            (read, write)
        };
        use std::os::windows::io::AsRawHandle;
        if SetHandleInformation(parent.as_raw_handle(), HANDLE_FLAG_INHERIT, 0) == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok((File::from(parent), child))
    }
}

impl QuietChild {
    pub fn spawn(command: &Command) -> io::Result<Self> {
        use std::os::windows::io::AsRawHandle;
        let (stdin, child_in) = pipe(true)?;
        let (stdout, child_out) = pipe(false)?;
        let (stderr, child_err) = pipe(false)?;
        let name = wide(OsStr::new(&format!(
            "ScientifyAgent-{}",
            uuid::Uuid::new_v4().simple()
        )));
        let desktop = unsafe {
            CreateDesktopW(
                name.as_ptr(),
                ptr::null(),
                ptr::null(),
                0,
                DESKTOP_CREATEWINDOW
                    | DESKTOP_READOBJECTS
                    | DESKTOP_WRITEOBJECTS
                    | DESKTOP_ENUMERATE,
                ptr::null(),
            )
        };
        if desktop.is_null() {
            return Err(io::Error::last_os_error());
        }
        let result = (|| {
            // CreateDesktopW uses this process's window station. A CI runner
            // or service may not belong to WinSta0; a relative desktop name
            // keeps the child in the same station as the desktop we created.
            let mut desktop_name = name.clone();
            let mut argv = quote(command.get_program());
            for arg in command.get_args() {
                argv.push(b' ' as u16);
                argv.extend(quote(arg));
            }
            argv.push(0);
            let mut env: BTreeMap<String, (OsString, OsString)> = std::env::vars_os()
                .map(|(k, v)| (k.to_string_lossy().to_uppercase(), (k, v)))
                .collect();
            for (key, value) in command.get_envs() {
                let index = key.to_string_lossy().to_uppercase();
                if let Some(value) = value {
                    env.insert(index, (key.to_os_string(), value.to_os_string()));
                } else {
                    env.remove(&index);
                }
            }
            let mut environment = Vec::new();
            for (_, (key, value)) in env {
                environment.extend(key.encode_wide());
                environment.push(b'=' as u16);
                environment.extend(value.encode_wide());
                environment.push(0);
            }
            environment.push(0);
            let cwd = command.get_current_dir().map(|p| wide(p.as_os_str()));
            let mut size = 0;
            unsafe {
                InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &mut size);
            }
            let mut buffer = vec![0usize; size.div_ceil(std::mem::size_of::<usize>())];
            let attributes = buffer.as_mut_ptr().cast();
            unsafe {
                if InitializeProcThreadAttributeList(attributes, 1, 0, &mut size) == 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            let handles = [
                child_in.as_raw_handle(),
                child_out.as_raw_handle(),
                child_err.as_raw_handle(),
            ];
            let spawned = (|| {
                let mut info: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
                info.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
                info.StartupInfo.lpDesktop = desktop_name.as_mut_ptr();
                info.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
                info.StartupInfo.wShowWindow = 0;
                info.StartupInfo.hStdInput = handles[0];
                info.StartupInfo.hStdOutput = handles[1];
                info.StartupInfo.hStdError = handles[2];
                info.lpAttributeList = attributes;
                let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
                unsafe {
                    if UpdateProcThreadAttribute(
                        attributes,
                        0,
                        PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                        handles.as_ptr().cast(),
                        std::mem::size_of_val(&handles),
                        ptr::null_mut(),
                        ptr::null(),
                    ) == 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    if CreateProcessW(
                        ptr::null(),
                        argv.as_mut_ptr(),
                        ptr::null(),
                        ptr::null(),
                        1,
                        CREATE_NO_WINDOW
                            | CREATE_UNICODE_ENVIRONMENT
                            | EXTENDED_STARTUPINFO_PRESENT,
                        environment.as_ptr().cast(),
                        cwd.as_ref().map_or(ptr::null(), |v| v.as_ptr()),
                        &info.StartupInfo,
                        &mut process,
                    ) == 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                    CloseHandle(process.hThread);
                    Ok(OwnedHandle::from_raw_handle(process.hProcess))
                }
            })();
            unsafe {
                DeleteProcThreadAttributeList(attributes);
            }
            spawned
        })();
        match result {
            Ok(process) => Ok(Self {
                process,
                desktop,
                stdin: Some(stdin),
                stdout: Some(stdout),
                stderr: Some(stderr),
            }),
            Err(error) => {
                unsafe {
                    CloseDesktop(desktop);
                }
                Err(error)
            }
        }
    }
    pub fn kill(&mut self) -> io::Result<()> {
        use std::os::windows::io::AsRawHandle;
        if unsafe { TerminateProcess(self.process.as_raw_handle(), 1) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        use std::os::windows::{io::AsRawHandle, process::ExitStatusExt};
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(ExitStatus::from_raw(code)))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        use std::os::windows::io::AsRawHandle;
        if unsafe { WaitForSingleObject(self.process.as_raw_handle(), INFINITE) } == WAIT_FAILED {
            return Err(io::Error::last_os_error());
        }
        self.try_wait()?
            .ok_or_else(|| io::Error::other("engine is still running"))
    }
}
impl Drop for QuietChild {
    fn drop(&mut self) {
        unsafe {
            CloseDesktop(self.desktop);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn argv_quoting_preserves_unicode_spaces_quotes_and_backslashes() {
        let input = OsStr::new("F:\\实验 项目\\a\"b\\");
        assert_eq!(
            String::from_utf16(&quote(input)).unwrap(),
            "\"F:\\实验 项目\\a\\\"b\\\\\""
        );
    }

    #[test]
    fn a_direct_helper_runs_without_showing_a_console_on_the_interactive_desktop() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GetWindowTextW, IsWindowVisible};
        unsafe extern "system" fn collect(window: HWND, context: LPARAM) -> i32 {
            let (titles, visible_only) = &mut *(context as *mut (Vec<String>, bool));
            let mut title = [0; 512];
            let n = GetWindowTextW(window, title.as_mut_ptr(), title.len() as i32);
            if (!*visible_only || IsWindowVisible(window) != 0) && n > 0 {
                titles.push(String::from_utf16_lossy(&title[..n as usize]));
            }
            1
        }
        fn titles(desktop: HDESK, visible_only: bool) -> Vec<String> {
            let mut context = (Vec::<String>::new(), visible_only);
            unsafe {
                SetLastError(0);
            }
            let result = unsafe {
                EnumDesktopWindows(
                    desktop,
                    Some(collect),
                    &mut context as *mut (Vec<String>, bool) as LPARAM,
                )
            };
            let error = unsafe { GetLastError() };
            assert!(
                result != 0 || error == 0,
                "EnumDesktopWindows failed: {error}"
            );
            context.0
        }
        let marker = format!("ScientifyHiddenProbe-{}", uuid::Uuid::new_v4().simple());
        let script = format!("$si = New-Object System.Diagnostics.ProcessStartInfo; $si.FileName = 'cmd.exe'; $si.Arguments = '/c title {marker} & ping -n 4 127.0.0.1 >nul & echo {marker}'; $si.UseShellExecute = $false; $si.CreateNoWindow = $false; $p = [System.Diagnostics.Process]::Start($si); $p.WaitForExit(); if ($p.ExitCode -ne 0) {{ throw 'helper failed' }}; Write-Output 'child-done'");
        let mut command = Command::new("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
        let mut child = QuietChild::spawn(&command).unwrap();
        let interactive = unsafe { GetThreadDesktop(GetCurrentThreadId()) };
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while std::time::Instant::now() < deadline {
            assert!(
                !titles(interactive, true)
                    .iter()
                    .any(|s| s.contains(&marker)),
                "helper console leaked onto the user desktop"
            );
            if child.try_wait().unwrap().is_some() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        if child.try_wait().unwrap().is_none() {
            let _ = child.kill();
        }
        let status = child.wait().unwrap();
        let mut output = String::new();
        use std::io::Read;
        child
            .stdout
            .take()
            .unwrap()
            .read_to_string(&mut output)
            .unwrap();
        let mut errors = String::new();
        child
            .stderr
            .take()
            .unwrap()
            .read_to_string(&mut errors)
            .unwrap();
        assert!(
            status.success(),
            "helper failed: {status:?}; stderr: {errors}; stdout: {output}"
        );
        assert!(output.contains("child-done"));
        assert!(
            output.contains(&marker),
            "the child command must actually execute"
        );
    }
}
