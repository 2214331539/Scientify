# Scientify

**A local research workspace, organized around your project.**

Read papers, keep notes, edit and run Python experiments, and revisit the parameters, logs, and outputs of each run in one desktop workspace.

[简体中文](README.md) · [Contributing](CONTRIBUTING.md) · [Roadmap](ROADMAP.md) · [Issues](https://github.com/2214331539/Scientify/issues) · [License](LICENSE)

> **Early alpha for Windows x64 and macOS Apple Silicon.** Download pre-releases from [GitHub Releases](https://github.com/2214331539/Scientify/releases). Windows is unsigned; the Mac preview is ad-hoc signed and not notarized. Intel Mac, Linux, and mobile builds are not provided.

## What you can do

- Organize research projects and connect existing local directories.
- Read local PDFs and keep a dedicated, adjacent Markdown notebook for each paper.
- Browse websites in native Windows / macOS webview tabs and download papers.
- Maintain project notes, with automatic saving and source links.
- Edit code, select Python interpreters, manage venv or existing Conda environments, and use interactive terminals.
- Run local experiments without a model key; inspect logs, outputs, execution conditions, and basic metric comparisons.
- Review Git changes and manage staging, commits, local branches, stashes, and worktrees.
- Edit Markdown, LaTeX, and BibTeX files; preview Markdown.
- Connect your model provider and use project-bound Agent sessions with approval and interruption controls.

Start with a small task: **create a project → connect papers and code → take a reading note → run a Python script → inspect its results.**

## Download

Open [Releases](https://github.com/2214331539/Scientify/releases) and download `Scientify_<version>_windows_x64_setup.exe` from the newest pre-release. Node.js and Rust are not needed to use the installed app. Windows 10 / 11 x64 is required; the installer downloads WebView2 if it is missing. Install Python and Git separately when using their respective features.

On Apple Silicon (M-series) Macs with macOS 14+, download `Scientify_<version>_macos_arm64.dmg` and drag Scientify into Applications. If macOS blocks this unnotarized preview, verify the download source and use System Settings → Privacy & Security → Open Anyway. Do not disable Gatekeeper. Verify the download using `shasum -a 256 <installer>` and `SHA256SUMS.txt`.

The Windows alpha installer is not code-signed and Windows may display an unknown-publisher warning. Compare `Get-FileHash <installer> -Algorithm SHA256` with the release's `SHA256SUMS.txt` to verify integrity. Before updating, close Scientify and back up `ScientifyData` and externally linked folders. Automatic updates are not available yet.

## Run from source

On Windows x64, install Node.js 24 LTS, pnpm 10.11.0, stable Rust, and the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows), including MSVC C++ Build Tools and WebView2.

For macOS, use native arm64 Node and Rust, macOS 14+, and Xcode Command Line Tools (`xcode-select --install`). The commands below are shared.

```sh
git clone https://github.com/2214331539/Scientify.git
cd Scientify
corepack enable
corepack prepare pnpm@10.11.0 --activate
pnpm install --frozen-lockfile
pnpm start
```

The first run prepares PDF assets and downloads a pinned Agent engine from GitHub. Install Python and Git separately for their respective features. Reading and note-taking do not require a model key.

Build a local desktop executable:

```powershell
pnpm tauri build --no-bundle
```

On Windows, run `Scientify-MVP.cmd`. This repository launcher is not an installer. Use `node node_modules/@tauri-apps/cli/tauri.js build --bundles nsis -- --locked` to build an NSIS installer. The release workflow runs checks and isolated installer smoke tests before publishing; signing and automatic updates remain planned. See the [release and branch guide](docs/技术方案/版本发布与分支管理.md).

On Mac, use `node node_modules/@tauri-apps/cli/tauri.js build --bundles app,dmg -- --locked`; the DMG is in `target/release/bundle/dmg/`.

`pnpm dev` starts an isolated frontend preview. It is not a complete web application: desktop filesystem access, execution, terminals, and embedded browsing are unavailable there.

## Data and execution

PDFs, adjacent paper notes, and code stay in local folders. Windows release builds store application data in `ScientifyData/` near the writable installation. Mac builds use `~/Library/Application Support/com.scientify.desktop/ScientifyData/`, outside the app bundle. Development uses a separate `.tauri-data/` directory.

**JSON export excludes PDFs and source files.** Back up the application data and every externally linked directory. See the [desktop guide](docs/产品功能文档/桌面使用说明.md) for details.

Remote model requests may send selected material or Agent-read content to your configured provider, under that provider's billing and data policies. Provider keys currently live in an unencrypted local credential file. Do not share application data, browser profiles, or secrets in reports. See [SECURITY.md](SECURITY.md).

Trusted manual terminals and runs execute with your local user permissions. AI formal runs use a workspace sandbox; these permission models are different.

## Current limits

- Team spaces are local organization, without accounts, online collaboration, or synchronization.
- Paper recommendations, subscriptions, OCR, PDF annotations, and a full-text research corpus are not implemented.
- Notebook kernels, Python debugging, remote GPU scheduling, and complete Git remote/conflict workflows are not included.
- LaTeX compilation is not integrated. Recording execution conditions does not guarantee a fully reproducible environment.
- Unsaved file drafts are not guaranteed to survive crashes; terminal processes are not restored after restart.
- Mac uses WKWebView; real websites, the minimum OS version, and complete manual research workflows need further device testing. Intel Mac and Linux are not supported. See the [cross-platform implementation](docs/技术方案/跨平台适配路线.md).

## Contribute

We welcome focused code changes, documentation, translations, reproducible bug reports, and research examples. Read [CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), and [GOVERNANCE.md](GOVERNANCE.md). Discuss new features, dependencies, storage formats, and permission changes in an issue before implementation.

The stack is **Tauri 2 / Rust, React 19 / TypeScript, Vite, Zustand, CodeMirror, and PDF.js**. Most detailed product and architecture documentation is currently in Chinese, indexed in [docs](docs/README.md).

Run `pnpm run build` first to generate ignored assets and protocol bindings, then:

```powershell
pnpm check
pnpm test --maxWorkers=2
cargo fmt --all --check
cargo test --workspace --locked
cargo clippy --workspace --all-targets --locked -- -D warnings
```

[Windows CI](.github/workflows/ci.yml) and [Apple Silicon CI](.github/workflows/macos.yml) check builds and regressions. Mac CI also verifies controlled native browsing and the packaged DMG. This is not a substitute for complete manual desktop validation.

## License and acknowledgements

Original Scientify code and documentation are available under [Apache-2.0](LICENSE). Contributors retain their copyright. Third-party code and assets retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). No trademark rights or endorsement are granted for modified distributions.

Built with Tauri, React, CodeMirror, PDF.js, xterm.js, OpenAI Codex, and other open-source projects. Scientify is independent and is not officially affiliated with their maintainers or organizations.
