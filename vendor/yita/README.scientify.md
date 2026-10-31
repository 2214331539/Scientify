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
  network requests, shared conversation persistence, and the workspace AI assistant.
- Embedded mode has no separate tray, startup registration, or standalone
  single-instance guard. The Scientify parent is the owner. Closing the parent
  closes the pipe and stops Yita and its native input helpers.
- Translation requests cannot invoke Agent or workspace mutation commands.

## Integration changes

`ScientifyAppearance.cs` adapts the host palette and reuses the main app's light/dark
brand assets. Embedded windows use fine borders, restrained shadows and compact
corner radii. The host sends resolved theme changes through the private pipe;
these update resources without rebuilding the transcript or clearing selections
and drafts. Upstream motion cancellation and reduced-motion preferences remain
in use. The reading surface is high-opacity, not native backdrop blur. Yita names
remain in namespaces, persisted settings and license notices for compatibility.

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
Both translation and question windows offer an arrow to open the **same session**
in the sidebar, without sending the user's draft automatically. Original quick
chat and the question window remain available. There is no translation Dock tab.

`QuestionAnswerWindow.Scientify.cs` uses the existing Scientify ChatRuntime over
the private pipe. One session has one active turn, one persisted history and one
cancel operation. A closed popup does not stop that shared task. The window can
continue to receive sidebar replies, and input remains editable while answering.
Snapshot polling is serialized (150 ms while running, 750 ms idle); unchanged
transcripts are not rerendered. Large snapshots show recent content with a tooltip;
full history is retained by Scientify. Retry keeps the existing user turn.

Translation and explanation still use the original Yita prompt/runtime. Question
turns use Scientify's chat prompt with bounded translation material. They retain
chat semantics in the sidebar, rather than silently gaining filesystem execution.
The initial project binding is fixed; another project's view rejects access.
Yita's manual records and optional automatic records for turns sent in a visible
question window are retained. If that window closes before completion, Scientify
still saves the full conversation, but the popup cannot write its Markdown record.

Scientify's single application tray provides open app, selection toggle, clipboard
translation, original settings, and input repair. Settings changes in Yita update
the tray through status notifications. No separate Yita tray or startup item is added.

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
