# Managed experiment tools

`tools.rs` implements the `item/tool/call` host flow in bundled Codex 0.158.0.
Dynamic tools require `experimentalApi: true`; they are supplied only to code
threads on `thread/start` and are restored by Codex on `thread/resume`.

`execution.rs` defines the shared workspace-write policy. Formal runs use a
dedicated app-server connection and `command/exec`. On Windows, Codex 0.158
does not support streamed output or terminate for sandboxed commands. The
application's `--scientify-runner` entrypoint runs inside the sandbox, writes
raw byte logs, and uses a Job Object, stop file and host heartbeat for cleanup.
It opens no Tauri window. Runs do not depend on the chat lifecycle.
Network and filesystem escalation are never granted by host tools. Normal AI
commands retain their existing inline approval flow.
Both model and execution connections select `windows.sandbox="unelevated"`
at startup. `command/exec` caches startup configuration, so completing setup
after launching an unrestricted connection does not update its sandbox mode.

Protocol reference: https://developers.openai.com/codex/app-server

Windows engine startup uses `quiet_process.rs`: stdio pipes with an explicit
handle allowlist, `CREATE_NO_WINDOW`, and a private non-interactive desktop.
Upstream startup helpers inherit that desktop, so they cannot display consoles
over Scientify. This is a presentation boundary, not a replacement for Codex's
workspace sandbox. Agent-owned temporary files use `CODEX_HOME/runtime-temp`.
No upstream binary patches, sandbox disabling, or hiding of unrelated windows
are used. Tests monitor the interactive desktop while a real direct helper executes and run the
bundled engine's protocol and managed experiment flow.

After a Windows release build, `node scripts/verify-experiment-runner.mjs`
verifies the production entrypoint through the real bundled Codex sandbox.
It uses disposable directories, observes live logs, reads the result JSON,
and checks that writing an external test file is rejected. No model is called.
