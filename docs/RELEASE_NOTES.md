## What's new

- **No more lag while agents work.** Trace was redrawing a busy channel's tile many times a second (each frame of the CLI's spinner); it now updates only when something changes. Plan-limit checks run every five minutes rather than each time you return to Trace.
- **The model is back on every channel**, in plain words (Opus 5.5, GPT-6.1 Sol), including right after a restart, before the channel's first reply.

Also in 1.10.0: chat channels for Claude and Codex with images in the thread, and your plan limits always in view.

## Install

- **Windows:** download `AI-Coding-Hub-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
