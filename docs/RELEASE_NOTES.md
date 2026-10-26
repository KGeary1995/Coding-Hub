## What's new

- **Terminal channels.** **+ Channel → Terminal** opens your normal shell in the project folder: zsh or bash on a Mac, PowerShell on Windows. It sits in the grid next to Claude Code and Codex and shows up on the phone page. Nothing it prints is saved to history.
- **See the images you paste.** Paste a screenshot into a Claude Code or Codex channel (Ctrl+V, or Cmd+V on a Mac) and a thumbnail appears under the terminal; click it to see it full size. Dropping a file on a channel types its path, and dropped images join the strip.
- **Phone access on Macs with Tailscale from the App Store.** Setup no longer fails with "Unexpected token 'T' … is not valid JSON" when Trace is opened from the Dock.
- **Security updates.** Electron 44.9.3 and zod 4.6.7 fix published security advisories.

## Install

- **Windows:** download `AI-Coding-Hub-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications. The first time, macOS blocks it because it is not notarized by Apple: open **System Settings → Privacy & Security** and click **Open Anyway** next to the message about AI Coding Hub.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
