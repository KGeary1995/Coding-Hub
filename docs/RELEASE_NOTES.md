## What's new

1.11.4 is a round of fixes from an audit of the whole app.

- **Pasting images on Windows.** Ctrl+V in a Claude Code or Codex channel now attaches an image when the clipboard holds only an image. Text still pastes as before.
- **Phone: scroll, copy and size.** Swipe to scroll a channel's history, and copy its text from a sheet. While you use the computer, its size wins. The phone can switch between **Fit to phone** and **Desktop size**, and shrinks text to fit.
- **Safer Git reads.** Trace's own Git checks no longer run a repository's hooks, fsmonitor or filter programs.
- **Usage includes subagents.** Tokens used by Claude Code subagents now count toward usage, and the memory panel opens on the project's automatic key.
- **Chat channels.** A Codex chat that fails or is stopped now says so. Chat channels report when the CLI exits, and copying waits until the clipboard is written.
- **Phone and linked computers.** Removing a phone also removes the keys it was given on linked computers. The phone app keeps working offline when the computer returns a server error. Streams no longer break on unusual characters in text. A link that goes quiet for a minute reconnects.
- **Sync, updates and startup.** Sync stops if its folder disappears. Memory notes are written before an update restarts Trace. Opening Trace a second time brings up the running window. Turning off phone access also stops sharing it over Tailscale.
- **Smaller fixes.** Search in the workflow center opens what it found. The worktree picker can go back to the workspace. Shortcuts don't fire while a dialog is open. The phone key row adds Shift+Tab and Backspace. The memory server answers newer MCP clients and oversized requests correctly.

Also in 1.11.3: approval alerts clear when Claude moves on, and Claude channels show how much context is in use. Also in 1.11.2: memory keeps working in projects where it was installed before the rename. Also in 1.11.1: chat channels keep their conversation, the phone reconnects by itself, security fixes for linked computers, and more accurate usage. Also in 1.11.0: Trace installs as Trace, scrolling and typing on your phone, and copying several lines from Claude Code. In 1.10.x: chat channels with images, plan limits, no lag while agents work, and copying that keeps sentences whole.

## Install

- **Windows:** download `Trace-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
