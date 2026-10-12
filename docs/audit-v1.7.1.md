# AI Coding Hub code audit — v1.7.1

Reviewed on 2026-10-12 in the Linux cloud workspace. This was a code review across the application's first-party source areas, supported by failure reproductions and native Electron tests. It is not a guarantee that every possible bug has been found, a review of third-party package source, or a Windows certification.

## Coverage

The review covered the Electron main/preload boundary and IPC validation; CLI discovery, engine arguments, authentication and named-account isolation; PTY input/output and process stopping; SQLite workspace/log persistence; MCP configuration, rules, handoffs, Drive mirroring and usage telemetry; repository browsing, diffs, worktrees and project setup/checks; native conversation history, delivery, templates, search, tasks, verification, experiments, backup/restore, diagnostics, coaching, design archives and isolated live previews; React state/runtime integration, navigation and feature panels; shared contracts/parsers; and packaging, update/signing configuration and installation tooling. Tests were inspected and expanded around confirmed failure paths. Generated output, binaries, dependencies and user data were excluded from source review.

## Confirmed defects fixed

| Finding | Before | Fix and evidence |
| --- | --- | --- |
| Git push destination review | Changing a remote's separate push URL left its review fingerprint unchanged; a push could use a newly selected destination. | Hash both fetch and push URLs and recheck after confirmation. A real local-repository regression changes only the push URL and verifies no push occurs. Remote name parsing also accepts Windows CRLF output. |
| Short Codex session usage | A run ending before the next telemetry tick could skip its final rollout discovery and lose usage. | Permit final discovery when correlation is unambiguous; a regression creates the rollout immediately before exit. |
| Overlapping Codex correlation | After one same-directory run exited, the remaining run could guess a rollout from the other session. | Remember overlap for the life of each run and require a thread association. Missing evidence remains unknown. A regression stops both overlapping runs and rejects guessed attribution. |
| Unix descendant cleanup | A parent exiting on SIGTERM could prevent escalation for descendants that remain in its process group. | Send SIGKILL to the detached group after parent exit. Unit regression covers early parent exit; real native PTY smoke checks confirm process/child cleanup. Windows continues to use taskkill on the tree before closing ConPTY. |
| Linked design task editing | Saving a task through the ordinary editor omitted and removed its original annotation reference. | Preserve the stored design reference when an update omits it; regression edits an existing linked task. |
| Verification result persistence | Eight noisy steps or heavily escaped output could exceed the shared JSON limit after commands had already completed, losing the recorded result. | Measure actual serialized bytes including profiles; prune older results and visibly truncate retained output to fit. A regression runs eight real Python commands emitting escaped output and reloads their passing result. |
| Design metadata limits | Schema-valid escaped notes could produce metadata larger than the reader's bound, making the archive unreadable after a successful write. | Align the metadata read bound with the schema's worst-case JSON expansion; regression saves and reloads 4,000 escaped characters. |
| Handoff encoding limits | Schema-valid escaped content could be written, then silently omitted by the smaller read limit or time out through the MCP request limit. | Align bounded note and MCP reads with permitted JSON expansion; unit and standalone MCP regressions round-trip a maximum-length escaped handoff. |
| Redirected memory root | A symlink at the memory root was accepted and could redirect writes outside the intended store. | Require a real directory at construction and on directory access. Unix regression verifies the destination stays untouched. |
| Handoff capacity boundary | The 5,001st note could be written even though listing rejected projects above 5,000 records. | Reject the new note before crossing the readable limit; regression verifies existing records remain listable. Existing-ID imports remain idempotent. |
| Malformed MCP envelope | JSON null reached property access outside the handler's error boundary and crashed the standalone server. | Reject non-object envelopes and keep serving requests; actual MCP-process smoke sends null, arrays and primitives before negotiation. |
| Repeated Drive directory scans | Every unchanged note triggered another whole-project parse on each sync tick: 20 notes caused 42 full scans. | Compare known IDs during preflight and import only missing notes. Regression verifies two scans for an unchanged sync while conflict/revision tests retain their original assertions. |
| Signed upgrade baseline mismatch | Signed CI built 1.6.1 while the installation test always looked for 1.2.0. | Share and validate the baseline setting. A Node configuration regression verifies the signed workflow and installation helper agree. Actual signed Windows execution remains pending. |

## Dependency review

Updated Vitest from the 3.x dependency chain to 5.0.4, compatible with the existing Node 22.13+ requirement and installed Vite 6.4.4. All unit tests passed under the patched runner. The reported critical test-tool findings are cleared.

`npm audit --omit=dev --json` reported **zero production dependency advisories** at review time. This is registry advisory coverage, not proof that all runtime dependencies are safe.

The full audit still reported **15 affected development-package entries: 5 high and 10 moderate, zero critical**. These are transitive styling/build-tool chains involving Tailwind 3 (`braces`, `micromatch`, `chokidar`, `fast-glob`, `postcss-nested`, `postcss-selector-parser`) and Electron build/download tooling (`@electron/get`, `global-agent`, `roarr`, `sprintf-js`, builder packages). Counts include inherited advisories and are not 15 independent vulnerabilities. They do not appear in the production-dependency audit.

The registry proposes a Tailwind 4 migration and an Electron builder downgrade for these chains. Those changes need a separate styling/package validation effort, especially native Windows signing and installation; they were not forced into this bug-fix release. Keep development inputs and downloaded build content trusted while planning those tooling changes. Relevant underlying advisories include GHSA-vfj7-8cjw-p6xm, GHSA-rj75-hqrm-r3gf and GHSA-hp3w-g68c-fv3c.

## Validation performed

- Production build and frontend/native TypeScript checks passed.
- 141 unit tests across 24 files passed, including new failure reproductions that failed before their fixes.
- Six Node release/configuration checks passed.
- Six real Electron desktop smoke suites passed: desktop, profiles, workbench, enterprise, productivity, and design/layout. Desktop, enterprise and productivity were rerun after final service changes. These use isolated fixture CLIs, temporary local repositories and storage, real IPC/PTY transport, and no paid provider inference.
- Standalone Electron/Node MCP smoke passed, including malformed envelopes, expanded JSON content and cross-process handoff persistence.
- Native PTY smoke passed, including isolated directories, terminal input/resizing and descendant cleanup.
- Git diff whitespace checks and package/lockfile version agreement passed.

The screenshot/design preview security checks use sandboxed Electron windows. Test-only sandbox disabling is scoped to root execution in this cloud test environment; packaged application settings remain sandboxed and unchanged.

## Remaining validation and review limits

Native Windows ConPTY behavior with the installed official CLIs, real Claude/Codex OAuth and model completion, GitHub account permissions/real PR creation, Google Drive cloud transport and concurrent desktop sync, certificate trust, actual installed-app upgrades, and published-feed updates were not exercised from Linux. The workflow baseline fix was validated structurally, not by running a signed Windows installer. No signing certificate was supplied, and no release was published by this audit.

Verification output now may be shortened further to preserve result metadata; truncation is explicit. Ambiguous Codex usage is deliberately left unknown until a thread ID is available. Existing notes/design metadata within the expanded supported bounds can be read without a migration. Source version 1.7.1 does not replace an installed Windows shortcut: rebuild/install the new Setup.exe or run the source edition with npm.cmd start.
