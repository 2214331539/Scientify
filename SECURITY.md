# Security policy

Scientify is an early-alpha desktop application. Security reports in Chinese or English are welcome. The current development branch is the maintained line; older commits and prerelease builds do not have a separate long-term support policy.

## Report a vulnerability privately

If GitHub private vulnerability reporting is available, use [Report a vulnerability](https://github.com/2214331539/Scientify/security/advisories/new). Availability depends on repository settings; this document does not enable that feature.

If that entry is unavailable, open an issue containing only a request for a private contact channel, addressed to [@2214331539](https://github.com/2214331539). Do not include exploit details, credentials, private paths, browser sessions, or research material in a public issue. There is currently no dedicated security mailbox or guaranteed response time.

Include the affected commit/version, platform, impact, and a minimal reproduction using disposable files once a private channel is established. Please coordinate disclosure while the issue is investigated and a fix is prepared. There is no bounty program at present.

## Current boundaries

- Provider credentials are stored unencrypted in a local credential file. Application data backups may include those credentials and browser sessions. Do not upload the entire data directory to an issue or public repository.
- Remote model requests can send selected context or Agent-read content to the configured provider. Local storage is not a promise of entirely offline processing.
- Trusted manual terminals and experiments execute with the local user's permissions, including network and filesystem access. Only run code and dependency commands you trust.
- AI formal runs use a workspace sandbox. External webpages are separate webviews without application IPC capabilities. These boundaries do not make arbitrary code or downloaded files safe.
- JSON export excludes PDFs and source files. Unsaved drafts are not guaranteed to survive crashes; back up linked directories separately.
- Desktop CI targets Windows x64 and macOS Apple Silicon. The Mac preview is ad-hoc signed and unnotarized; Developer ID distribution, Intel Mac, automatic updates, complete manual-device coverage, and complete installer recovery are not established support claims.

## Contribution and release requirements

Keep credentials, environment secrets, runtime data, model histories, and browser profiles out of commits and logs. Report suspected exposure privately and rotate affected credentials; deleting a file from the latest tree does not remove it from Git history.

Changes to permissions, IPC, file access, process execution, model context, or migration require explicit review and regression coverage. Release maintainers must verify dependency provenance, notices, package contents, and platform behavior before publishing an installer. The current source workflow does not certify a binary distribution as audited or signed.
