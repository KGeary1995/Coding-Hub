## What's new

- **Mac app.** Trace now comes as a Mac disk image: `macOS-arm64` for Apple silicon (M1 and later), `macOS-x64` for Intel Macs. Terminals start in the packaged app, and it finds Claude Code, Codex and Node.js where your terminal does.
- **Up to eight channels.** Add up to eight Claude Code or Codex channels. Past four, the grid goes three or four across; each channel runs its own CLI, so more channels use more memory.
- **Phone access: guided Tailscale HTTPS.** When Tailscale needs HTTPS certificates turned on (or Serve approved), Trace shows the steps, opens the right Tailscale page, and finishes setup by itself when you come back.
- **Simpler menus.** Design workspace, AI coaching, Task coordination and Verification profiles moved to **Insight → More tools**. Nothing in them changed.
- **Updates.** Settings → Application updates has an **Open downloads page** button. Installed Windows copies check this page for new versions.

## Install

- **Windows:** download `AI-Coding-Hub-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications. The first time, macOS blocks it because it is not notarized by Apple: open **System Settings → Privacy & Security** and click **Open Anyway** next to the message about AI Coding Hub.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
