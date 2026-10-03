//! Process groups belong only to children created by Scientify.
pub(crate) struct Group(Option<i32>);
impl Group {
    pub fn new(pid: u32) -> Self {
        Self(i32::try_from(pid).ok().filter(|id| *id > 1))
    }
    pub fn stop(&mut self) {
        let Some(pid) = self.0.take() else { return };
        // A missing group is already gone; never signal pid 0 or the caller's group.
        if unsafe { libc::kill(-pid, libc::SIGTERM) } == 0 {
            std::thread::sleep(std::time::Duration::from_millis(100));
            unsafe {
                libc::kill(-pid, libc::SIGKILL);
            }
        }
    }
}
impl Drop for Group {
    fn drop(&mut self) {
        self.stop();
    }
}
