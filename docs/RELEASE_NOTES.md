## What's new

1.11.2 fixes shared memory for projects where memory was installed by hand:

- **Memory keeps working after Trace moves.** A project's own memory server entry (in `.mcp.json` or `.codex/config.toml`) that still points at the old AI Coding Hub program is updated to this install the next time a channel starts there, so its CLIs stop reporting "Connection closed".
- **No more silently separate notes.** If a project's memory server uses a different key from the folder's automatic one, Trace tells you, and so does the session, instead of reading and writing a separate set of notes without saying so.
- **Installing memory uses the automatic key**, so CLIs started from other terminals share notes with channels started in Trace.
- **A chat CLI that cannot start shows the real reason** on Windows, instead of `kill EINVAL`.

Also in 1.11.1: chat channels keep their conversation and behave, a chat CLI that fails to start can no longer crash Trace, the phone reconnects by itself, security fixes for linked computers, complete conversation history, and more accurate usage. Also in 1.11.0: Trace installs as Trace, scrolling and typing on your phone, channels no longer shrink by themselves, copying several lines from Claude Code, and today's token count including channels started yesterday. In 1.10.x: chat channels with images, plan limits, no lag while agents work, and copying that keeps sentences whole.

## Install

- **Windows:** download `Trace-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
