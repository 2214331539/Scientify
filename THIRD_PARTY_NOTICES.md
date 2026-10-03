# Third-party notices

Scientify's Apache-2.0 license applies to original project content. It does not relicense dependencies, upstream executables, fonts, icons, fixtures, or other third-party material. Retain the applicable copyright, license, and notice files when redistributing them.

## Bundled Agent engine

- Project: [OpenAI Codex](https://github.com/openai/codex).
- Pinned upstream release: [`rust-v0.158.0`](https://github.com/openai/codex/tree/rust-v0.158.0).
- Integration: an unmodified upstream executable, downloaded by [prepare-agent.mjs](scripts/prepare-agent.mjs) and run as a separate process.
- License: [upstream Apache-2.0 text](docs/licenses/codex-LICENSE).
- Notice: [upstream NOTICE](docs/licenses/codex-NOTICE), including its Ratatui attribution.

The executable is not committed to this repository. A binary distribution containing it must include the upstream license and notice. Changing `SCIENTIFY_CODEX_VERSION` requires reviewing the new release's notices; the files here cover only the pinned version above.

## Main application dependencies

| Project                                                     | Use                                 | Upstream license                             |
| ----------------------------------------------------------- | ----------------------------------- | -------------------------------------------- |
| [Tauri](https://github.com/tauri-apps/tauri)                | Desktop application and IPC         | MIT OR Apache-2.0                            |
| [React](https://github.com/facebook/react)                  | User interface                      | MIT                                          |
| [Zustand](https://github.com/pmndrs/zustand)                | Frontend state                      | MIT                                          |
| [CodeMirror](https://github.com/codemirror/dev)             | Text editing                        | MIT                                          |
| [PDF.js](https://github.com/mozilla/pdf.js)                 | PDF rendering and supporting assets | Apache-2.0; retain bundled asset notices     |
| [xterm.js](https://github.com/xtermjs/xterm.js)             | Terminal interface                  | MIT                                          |
| [Lucide](https://github.com/lucide-icons/lucide)            | Interface icons                     | ISC, with upstream icon attribution retained |
| [Vite](https://github.com/vitejs/vite)                      | Frontend build tooling              | MIT                                          |
| [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | Styling tooling                     | MIT                                          |

Exact versions and transitive dependencies are recorded in [pnpm-lock.yaml](pnpm-lock.yaml) and [Cargo.lock](Cargo.lock). The build runs [prepare-licenses.mjs](scripts/prepare-licenses.mjs) to collect their license texts, including build/test dependencies, and bundles them under `licenses/` with the Agent and copied PDF asset notices. GitHub Releases also provides `THIRD_PARTY_LICENSES.txt`. Each dependency's original terms remain authoritative. Packages whose archives omit notices use the version-specific sources documented in [supplemental notices](docs/licenses/upstream/README.md); the test-only `stackback` package has an explicitly identified declaration-only record.

## References, contributions, and research material

Oleafly, VS Code, and other projects appear in design research or documentation as references. Mentioning or studying a project does not grant permission to copy its code under Scientify's license. Any contributed third-party code must identify its source, version, license, and modifications and satisfy its original obligations.

Do not add copyrighted papers, private datasets, credentials, or user research directories to the repository. Examples must be original, public-domain, or explicitly licensed for redistribution, with attribution where required. Provider APIs and any separately downloaded model weights have their own terms.
