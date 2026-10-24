# Trace redesign: decisions and deviations

The Claude Design handoff in this folder (`README.md`, `design/`, `tokens.css`) is the visual source of truth. These decisions, made after reviewing it against the codebase, take precedence where they differ.

## Decisions (October 2026)

| Topic | Handoff | Decision |
|---|---|---|
| Waiting state and approvals | Approve / Deny type `y` / `n` into the PTY | Detect "waiting" (Claude Code through a `--settings` notification hook, Codex best effort). **Approve focuses that channel's terminal**, so the person answers the CLI's own prompt. Nothing is typed for them. |
| Scope-strip trace | Tokens per second from usage events | **Terminal activity**: PTY output per second. Usage arrives once per message or turn, so a token trace would be flat with rare spikes. Token totals stay in the header and status bar. |
| Product name | "trace" wordmark; name open | **Trace** in the interface. Installer, data folders, app ID and update channel keep their existing names so upgrades keep working. |
| Delivery | Six phases | One pull request per phase, each through CI and review. |

## Deviations found in review

- **Usage table:** shows the session's name, not its first prompt. Conversation text is deliberately kept out of the renderer (`electron/services/hub/telemetry.ts`).
- **Files and Help:** the handoff gives them no place. Files is reachable from Changes and the command menu; Help from the top bar and the command menu.
- **Templates:** has a form, so it moves to Projects rather than into the command menu.
- **Revert hunk / Discard…:** new destructive actions that the app does not have today. They are left out of the redesign.
- **Context percentage:** only Codex reports its context window. Claude tiles show `ctx —`, and "limit" for Claude comes from session budgets.
- **Price table version:** prices are user-configured, so the Usage cost cell cites "configured rates" instead of a version.
- **Phase 1 type scale:** the existing 13–14 px scale is kept until each view is rebuilt with the Trace type scale in later phases.
