## What's new

1.11.3 fixes two things on Claude Code channels:

- **Approval alerts clear when Claude moves on.** A channel no longer stays on HOLD ("needs approval") after you've answered. Before, if you answered before the alert reached Trace, it stayed until you typed in that channel again. Now it also clears when Claude finishes the tool or its turn.
- **See how much context Claude is using.** The channel header shows the tokens in Claude's context after its last reply, for example `ctx 241K`. Claude Code doesn't report its window size, so there's no percentage; Codex channels still show one.

Also in 1.11.2: memory keeps working in projects where it was installed before the rename, Trace warns when a project's memory uses a separate set of notes, and installing memory uses the automatic key. Also in 1.11.1: chat channels keep their conversation and behave, a chat CLI that fails to start can no longer crash Trace, the phone reconnects by itself, security fixes for linked computers, complete conversation history, and more accurate usage. Also in 1.11.0: Trace installs as Trace, scrolling and typing on your phone, channels no longer shrink by themselves, copying several lines from Claude Code, and today's token count including channels started yesterday. In 1.10.x: chat channels with images, plan limits, no lag while agents work, and copying that keeps sentences whole.

## Install

- **Windows:** download `Trace-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
