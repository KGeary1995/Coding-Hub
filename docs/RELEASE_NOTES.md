## What's new

- **Trace is now called Trace everywhere.** The app installs as Trace (Trace.app, Trace.exe and its shortcuts) instead of AI Coding Hub. Your settings, channels, history, phone pairing and sync carry over.
  - **Windows:** the installer replaces AI Coding Hub.
  - **Mac:** drag Trace to Applications. Trace then offers once to move the old AI Coding Hub to the Trash (it stays unless you click Move to Trash). If AI Coding Hub is in your Dock, remove it and add Trace.
- **Scroll the conversation on your phone.** Claude Code draws full screen and keeps its conversation itself, so swiping on the phone only moved the visible screen. A swipe now scrolls Claude Code's conversation, as the trackpad does on your computer.
- **Typing from your phone is no longer garbled.** Typed straight into the terminal, the phone keyboard's autocorrect and predictions rewrote words as you typed, and each rewrite reached the CLI. Tapping the terminal now opens the message box at the bottom: type there and tap Send (Enter on the keyboard works too). The key row still sends Enter, Esc, arrows, Tab and Ctrl C.
- **Today's token count includes channels started yesterday.** "Σ today" counted a channel's tokens on the day it started, so a channel left running past midnight added nothing. Each reply now counts on the day it was used.

Also in 1.10.2: copying from a channel keeps sentences whole. In 1.10.1: no lag while agents work, and the model on every channel. In 1.10.0: chat channels for Claude and Codex with images, and your plan limits always in view.

## Install

- **Windows:** download `Trace-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
