# AI Coding Hub 1.7 productivity workflows

The existing terminal workspace stays focused. One Workflow center hosts recovery, search, templates, and support in tabs. Delivery and design tools are expandable; no commands or provider requests start just because a panel is opened.

## Session recovery and durable conversations

Choose Workflow center → Recovery, select the affected tile, and run recovery checks. They inspect the exact directory, engine, and named Claude profile. Guidance classifies known diagnostic wording without treating an exit code as a diagnosis. Open the suggested setup screen, inspect recorded output, or explicitly retry. Recent failed runs can restore settings to an idle tile; with four tiles, the first idle one is replaced and active tiles are retained.

Configure → Session name & budget alerts saves a human name. When local structured logs identify the native conversation UUID, it is retained in the saved configuration. After restart, the tile is idle and Start resumes that context if the CLI file still exists and resume is supported. Unsupported/missing logging cannot provide a reliable identity. Start a fresh conversation next time clears the reference without deleting native history. Duplicate creates a fresh conversation with the same launch parameters.

Session history → View native CLI conversations → Name and pin conversation stores labels and pinned references locally and sorts pins first. Discovery remains bounded; removed or unscanned CLI files cannot be resumed. Named account references preserve their profile IDs. This does not import claude.ai or Claude desktop/cloud chat.

Prepared coaching/design requests are saved in the workspace and included in local backups. They remain pending until delivered successfully. Start the tile, complete trust/setup prompts, then explicitly send the request. Nothing auto-answers a CLI prompt or auto-sends provider requests after restart. Partial transport failures can leave uncertain delivery; inspect the terminal before retrying.

## Unified local search

Use Workflow center → Search, the command menu, or Ctrl/Cmd+Shift+F. Search source filenames/content in the selected directory, curated memory notes, canonical rules, and design annotations. Recorded output is a separate opt-in. Results show category, location, and a bounded context snippet; Open routes to the relevant view, and design hits select their snapshot.

The scan skips symlinks, known credential files, .env files, dependency/build/cache folders, and agent credential directories. It visits at most 3,000 entries, reads at most 8 MiB, skips text files over 128 KiB, and returns at most 100 hits. Recorded output searches up to 100 retained runs, taking a 64 KiB tail per run. Limits are reported. Private text in ordinary source files or opted-in output can still appear locally; the app sends none of it to a model automatically.

## Reviewed Git delivery

Changes continues to show read-only diffs. Expand Git delivery for Stage, Commit, Push, or Pull request. Select individual paths for staging/unstaging. Commit reviews ALL staged paths and the message. Push sends current HEAD to the selected existing remote and current named branch, with no force flag. PR creation uses the local GitHub CLI and its account; push the branch first, choose base/title/body, and optionally create a draft.

Stop coding sessions and verification before changing repositories. Every write or remote action has a native confirmation. Repository fingerprints bind HEAD, Git status, index/worktree diffs, untracked contents, and remote URLs. A changed fingerprint before or during review rejects the operation. Git hooks and configuration run with local permissions. Fingerprints reduce stale-review risk; they are not an OS lock against unrelated external processes. Large reviews use bounded output/content limits. Working files are preserved by unstage; no discard, hard reset, force push, or automatic merge is exposed. The PR body is passed using a private temporary file and removed afterward. Result links currently support github.com PR URLs.

The app waits for reviewed delivery/template operations before normal window close, and blocks competing coding/check launches, backups, and update installation during those operations. Failed commands surface recoverable errors; refresh and verify the actual repository/remote before retrying. A timed-out remote action may have completed remotely.

## Design iteration

Open a trusted local server through Design workspace's live preview controls. Select Mobile (390×844), Tablet (768×1024), or Desktop (1440×900), then resize the live viewport before capturing. Browser isolation and same-origin network restrictions remain in force.

Save two screenshot versions at matching dimensions. Select the newer one and expand Screenshot differences. Compare with its predecessor, adjusting a 0–255 per-channel tolerance. Red pixels changed; muted grayscale pixels are unchanged at that threshold. Alpha differences count too. Comparisons support up to four million pixels and refuse mismatched dimensions rather than inventing alignment. Counts measure change, not visual quality, accessibility, or semantic correctness.

Within annotation review, expand Turn feedback into an implementation task, choose a comment, project, and relative file scopes, then create the task. It stores snapshot/annotation IDs and the original comment as evidence. Task coordination offers View linked design to return to that snapshot. Scope audits and completion checks remain advisory/reviewed.

## Per-session usage targets

Set a per-run token target, estimated USD cost target, and context-warning percentage in session settings. A compact notice appears only when reported telemetry reaches a configured threshold; expand it for details. The target is saved per tile and reused across runs, while measured totals describe the current run. Missing telemetry or unpriced models do not become zero-cost estimates. Codex cached input/reasoning is not counted twice. Context requires a reported window limit.

Alerts are advisory, can lag, and are not provider billing caps or automatic termination. Claude's existing raw max-session-token control remains separate and has its own reported-token enforcement. Templates can reuse alert configuration.

## Project templates

Save the current workspace under Workflow center → Templates. Inspect the captured raw engine settings, layout, budgets, optional canonical rules, and verification profiles for the root project. Conversation IDs, prepared prompts, credentials, and historical verification results are excluded. Up to 50 templates are supported.

Choose a target project and review application. All tiles target that selected directory; independent bindings retain independent mode but are rebound to it. New IDs avoid reusing process identities. No processes or checks start automatically. Existing canonical rules are preserved/applied by default; explicitly choosing replacement rules updates the shared canonical document and may require reapplication to other registered projects. Check commands are copied as profiles and still require their own execution confirmation. Application is not a cross-service filesystem transaction: if a later operation fails, inspect rules/profiles before retrying. Native rule writes preserve their existing stale-file checks and backups.

Templates and conversation labels are local JSON records included in app backups. External repository contents and provider credential directories remain excluded.

## Support and signed releases

Support exports app/platform versions and redacted engine diagnostics. It excludes session output, prompt text, credentials, environment values, and configuration contents. Home/project paths are abbreviated before JSON encoding. Choose the destination through the native save dialog. Support can inspect the running Windows executable's Authenticode status and public signer subject; source editions clearly report that they have no installer signature.

`npm.cmd run dist:win:signed` is a prepared certificate-required path. Configure CSC_LINK and CSC_KEY_PASSWORD securely and WINDOWS_PUBLISHER_NAME as the exact public certificate identity. Native Windows is required. Missing signing configuration fails before staging; invalid/untrusted signatures or a mismatched publisher prevent promotion. Installer, portable, and unpacked application EXEs are verified and hashed. The manual Signed Windows release verification workflow builds signed baseline/current versions and runs the existing installed-app upgrade/data-retention checks. It uploads candidates and reports without publishing a release.

No certificate is bundled or configured by this source release, and no signed release has been published. The ordinary `dist:win` command remains available and is unsigned without a certificate. Follow [Windows releases](windows-releases.md) for secure signing configuration, native upgrade validation, and reviewed publication. Native certificate validation and a real published-feed upgrade require Windows and your signing setup; Linux fixture suites cannot establish them.

## Validation

Unit tests exercise cancellation/stale Git review, selected staging and commits, a local bare-remote push, templates, private-file exclusions, token/context accounting, pixel comparisons, path redaction, and signing preflight. The productivity desktop suite exercises the native bridge, retained conversation identity/requests, pinned metadata, recovery, budget notices, local previews, linked design tasks, search, delivery, templates, support export, small-window layout, and backup restore. PR creation is simulated by a local fixture CLI on Unix; no real GitHub PR or provider inference is sent. Existing desktop/profile/design/coaching suites remain in place. Windows release and signing workflows must pass on their platform before claiming installation or signing validation.
