## What's new

1.12.0 shows your Mac's screen in Trace on your PC, and lets you control it:

- **Screen on another computer's tab.** **Screen** shows that computer's screen and gives you its mouse and keyboard. It uses the Mac's own Screen Sharing, not Trace, so it still works when Trace on the Mac has closed (to reopen it, for example). Turn it on once on the Mac: **System Settings → General → Sharing → Screen Sharing**. It connects only over Tailscale, to computers you have linked.
- **Sign in once.** Sign in with your Mac user name and password. Trace can save them on this computer, encrypted by Windows or macOS; **Forget password** removes them.
- **Mac shortcuts from a PC.** **Ctrl as ⌘** (on by default on Windows) sends Ctrl as Command, so Ctrl+C and Ctrl+V copy and paste on the Mac. Ctrl+V first sends the text you copied on the PC, and text you copy on the Mac lands on the PC's clipboard. **View only** watches without sending anything.

Also in 1.11.9: copy and paste in another computer's channels, and **+ Channel** adds channels on that computer. Also in 1.11.8: another computer's channels fill their tiles, and every Claude Code channel shows which account it runs on. Also in 1.11.7: the phone fills its screen with the channel. Also in 1.11.6: on the phone, Claude Code's scroll-to-end button works, press and hold selects text, every key fits on screen, and a linked computer's channel keeps your phone's size. Also in 1.11.5: the Trace icon, and linked computers' channels at their full size. Also in 1.11.4: a round of fixes from an audit of the whole app. Pasting images on Windows; scrolling, copying and sizing on the phone; safer Git reads; usage that includes Claude Code subagents; fixes for chat channels, linked computers, sync, updates and startup. Also in 1.11.3: approval alerts clear when Claude moves on, and Claude channels show how much context is in use. Also in 1.11.2: memory keeps working in projects where it was installed before the rename. Also in 1.11.1: chat channels keep their conversation, the phone reconnects by itself, security fixes for linked computers, and more accurate usage. Also in 1.11.0: Trace installs as Trace, scrolling and typing on your phone, and copying several lines from Claude Code. In 1.10.x: chat channels with images, plan limits, no lag while agents work, and copying that keeps sentences whole.

## Install

- **Windows:** download `Trace-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
