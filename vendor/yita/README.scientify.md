# Yita embedded in Scientify

This is a source snapshot of Yita at the revision recorded in `UPSTREAM.json`.
The upstream application uses .NET 8 / Avalonia. Its actual frontend is the
AXAML and C# in `src/Yita.Desktop`, not Scientify's React components.

Scientify builds these sources into a self-contained component. End users do not
install Yita or .NET separately. The integration does not run an HTTP listener.

## Ownership

- Yita owns global selection, Windows UIA worker isolation, clipboard fallback,
  macOS Swift helper, floating windows, prompts, streaming presentation, retries,
  cache/coalescing, glossary, corrections, records, and translation settings.
- Scientify owns the component process, its data location, provider credentials,
  network requests, and the handoff to the workspace AI assistant.
- Embedded mode has no separate tray, startup registration, or standalone
  single-instance guard. The Scientify parent is the owner. Closing the parent
  closes the pipe and stops Yita and its native input helpers.
- Translation requests cannot invoke Agent or workspace mutation commands.

## Integration changes

`ScientifyBridge.cs` is an injected HttpClient handler. Original Yita providers
still build prompts and parse SSE. The handler forwards only the request body
over inherited standard pipes. Scientify chooses the saved provider and model,
loads its own credentials and returns deltas. A marker in the adapter's API-key
field is not a real credential. No API keys are sent to this component.

`MainWindow.Scientify.cs` handles configuration, status, pause/resume, clipboard,
manual text, and opening the original settings window. A model fingerprint
separates cache entries across model/endpoint changes. Existing in-flight
requests keep their model snapshot; stale queued requests fail explicitly.

Small changes in App, MainWindow, DesktopPlatformServices and the two popup
windows add host lifecycle, scoped data and assistant handoff. macOS correction
encryption uses a Scientify Keychain service rather than standalone Yita's.
Both translation and question windows offer handoff without sending the user's
draft automatically. Original quick chat remains available.

The original frontend/runtime/native tests are retained. Extra bridge tests cover
parallel stream ownership, cancellation and pipe disconnect. Windows and macOS
native adapters are included; macOS system authorization still requires a Mac.

## Building and testing

From the Scientify repository root:

```sh
pnpm prepare:translation
dotnet test vendor/yita/tests/Yita.Desktop.Tests -c Release
dotnet test vendor/yita/tests/Yita.Core.Parity.Tests -c Release
dotnet test vendor/yita/tests/Yita.Core.Tests -c Release
dotnet test vendor/yita/tests/Yita.Native.Windows.Tests -c Release
dotnet test vendor/yita/tests/Yita.Native.Mac.Tests -c Release
node scripts/verify-translation-service.mjs
```

Developers need .NET 8 SDK (or `SCIENTIFY_DOTNET` pointing to it). macOS builds
also need Xcode command-line tools. Packaging includes runtime and dependency
notices. The source tree is pinned; build scripts never fetch a moving Yita branch.
`bin`, `obj`, runtime binaries and user data are excluded from Git.

When updating upstream, compare the integration files above, rerun the native
and host tests, and manually check clipboard restoration, pinned windows,
multi-monitor positioning, permissions, and assistant handoff. Do not replace
Yita's UI with a second React implementation.

See the root `LICENSE`, `NOTICE.md`, `LICENSES/` and font license. Scientify's
Apache license does not replace the third-party licenses in this subtree.
