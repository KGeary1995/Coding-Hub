## What's new

- **Steadier under heavy output.** Each channel's CLI is held to the pace the window can draw, so a channel printing huge amounts of output no longer piles up work that makes Trace sluggish. Nothing is lost; the CLI just waits to write.
- **Accurate usage for long sessions.** When a session ends, Trace now reads all of its usage, not just the first few megabytes. A run whose usage could not be read completely is marked **incomplete** in Usage, and if usage cannot be read during a session you are told, including when a session token limit cannot be enforced.
- **Faster start.** Screens you don't need at start (Settings, Usage, Help and the like) load in the background, making the start-up bundle about a third smaller.

## Install

- **Windows:** download `AI-Coding-Hub-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
