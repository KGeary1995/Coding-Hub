# Documentation

Start with [`AGENTS.md`](../AGENTS.md) at the repository root. It's the short guide for anyone, human or AI agent, about to change, build or release Trace.

## Current

Keep these accurate when you change the behaviour they describe.

| Doc | Covers |
|---|---|
| [architecture.md](architecture.md) | Processes, IPC, the launch pipeline, approval alerts, usage, memory, security boundaries, data locations, names that must not change |
| [development.md](development.md) | Prerequisites, running from source, every npm script, what CI runs, how to verify a change, conventions |
| [windows-releases.md](windows-releases.md) | Packaging (Windows and Mac), signing, publishing to `trace-releases`, update behaviour, installer tests |
| [troubleshooting.md](troubleshooting.md) | Symptoms, causes and fixes, both for users and for development and CI |
| [reference.md](reference.md) | What each feature does, from the user's side, plus local storage. The top sections are older release notes (v1.2–v1.7) |
| [RELEASE_NOTES.md](RELEASE_NOTES.md) | Notes for the current or next release. The Release workflow publishes this file as the release description |
| [design/midnight/](design/midnight/README.md) | **Midnight**, the visual design specification: tokens, shared parts, the frame, the channel tile, pages, words and the rules for changing a screen. `src/tokens.css` and `src/ui.css` implement it |
| [design/trace/DECISIONS.md](design/trace/DECISIONS.md) | Design decisions and deviations from October 2026 on, including why Midnight replaced Flight Deck Lite |

## Historical

Snapshots from earlier versions. They are useful for the reasoning behind decisions, but not for current behaviour: names, limits and paths have changed since (for example "AI Coding Hub" became Trace in 1.11, and four channels became eight). The Design workspace some of them describe (design archive, live preview, annotations, screenshot comparison, Claude Design buttons) has been removed.

| Doc | From |
|---|---|
| [audit-2026-11-17.md](audit-2026-11-17.md) | Read-only code audit of 1.22.0: the 1 to 3 second freezes, and what to fix first |
| [audit-2026-11-17-findings.md](audit-2026-11-17-findings.md) | Every finding of that audit, with the independent check made of each |
| [audit-2026-11-17-fixes.md](audit-2026-11-17-fixes.md) | What was fixed after that audit, the choices made, what was left and what was not verified |
| [audit-2026-10-26.md](audit-2026-10-26.md) | Code audit before 1.11.1, with findings and repairs |
| [audit-v1.7.1.md](audit-v1.7.1.md) | Code audit at 1.7.1 |
| [models-stability-v1.7.2.md](models-stability-v1.7.2.md) | Codex model catalog and crash-recovery work in 1.7.2 |
| [workflows-v1.6.md](workflows-v1.6.md), [workflows-v1.7.md](workflows-v1.7.md) | Workflow guides for 1.6 and 1.7 |
| [design/trace/README.md](design/trace/README.md), [design/trace/design/](design/trace/design/) | The October 2026 Trace design hand-off and its prototypes: fonts, colours and look replaced by Midnight |
| [design/trace/CLAUDE_CODE_PROMPT.md](design/trace/CLAUDE_CODE_PROMPT.md) | The prompt used to implement the redesign |
