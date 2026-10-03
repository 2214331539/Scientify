# Supplemental dependency notices

Some upstream package archives omit their license files. `sources.json` maps
exact package versions to the texts retained here and their upstream source.
The build fails when another dependency has no notice; dependency updates must
review and update this map rather than reuse a notice for a different version.

- The downloaded upstream texts are retained verbatim. For dual-licensed
  `MIT OR Apache-2.0` packages whose archive omits both texts, the MIT option is
  used here.
- Platform npm archives use the notices from their installed, same-version
  parent package (`esbuild`, `rollup`, `@napi-rs/canvas`, `@tauri-apps/cli`).
- `selectors` declares MPL-2.0 in its Cargo manifest and source headers. The
  complete license is Mozilla's canonical text. Its exact source commit is
  linked in `sources.json`; Scientify does not modify this dependency.
- `stackback` is used by the test toolchain only. Its source and npm archive
  contain an MIT declaration but no separate license text. The supplemental
  record identifies this limitation explicitly; it is not a runtime component.

The generated report deliberately includes build/test dependencies as well as
runtime dependencies. It is bundled under `licenses/`, alongside the project,
Agent and PDF asset notices. It is not a claim that every listed package ships
inside the executable.
