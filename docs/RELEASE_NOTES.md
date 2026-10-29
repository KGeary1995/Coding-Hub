## What's new

1.12.1 pastes screenshots into your other computer's channels, and makes controlling your PC's screen more responsive (update both computers):

- **Paste images into another computer's channels.** A screenshot pasted into a Claude Code or Codex channel on your other computer now reaches it, from the PC to the Mac and the other way round: Ctrl+V on Windows, ⌘V or Ctrl+V on a Mac. Claude Code there attaches it as if you had pasted it on that computer. It replaces what was on that computer's clipboard.

- **Changes arrive as they happen.** The PC sends each change to the screen as soon as it happens instead of waiting to be asked for every frame, so a change takes one trip across the network instead of two. It captures 30 frames a second instead of 15, and when the connection is busy it sends the newest picture rather than queuing old ones.
- **A dot shows where your mouse is at once.** The PC's own cursor follows a moment later.

1.12.0 lets your computers see and control each other's screens:

- **Screen on another computer's tab.** **Screen** shows that computer's screen and gives you its mouse and keyboard. It uses the Mac's own Screen Sharing, not Trace, so it still works when Trace on the Mac has closed (to reopen it, for example). Turn it on once on the Mac: **System Settings → General → Sharing → Screen Sharing**. It connects only over Tailscale, to computers you have linked.
- **Sign in once.** Sign in with your Mac user name and password. Trace can save them on this computer, encrypted by Windows or macOS; **Forget password** removes them.
- **Mac shortcuts from a PC.** **Ctrl as ⌘** (on by default on Windows) sends Ctrl as Command, so Ctrl+C and Ctrl+V copy and paste on the Mac. Ctrl+V first sends the text you copied on the PC, and text you copy on the Mac lands on the PC's clipboard. **View only** watches without sending anything.
- **Your Windows PC from your Mac, even with Trace closed.** Windows has no built-in screen sharing, so Trace brings its own; there is nothing else to install. On the PC, turn on **Settings → Other computers → Share this screen**. A small Trace service then starts whenever you sign in to Windows and runs whether Trace is open or not. On the Mac, **Screen** on the PC's tab opens it, with no password: the link between your computers signs it in. **⌘ as Ctrl** makes ⌘C and ⌘V copy and paste on Windows. While someone is watching, a Trace icon by the clock says who, with **Disconnect**. The PC must be on, awake and unlocked.

Also in 1.11.9: copy and paste in another computer's channels, and **+ Channel** adds channels on that computer. Also in 1.11.8: another computer's channels fill their tiles, and every Claude Code channel shows which account it runs on. Also in 1.11.7: the phone fills its screen with the channel. Also in 1.11.6: on the phone, Claude Code's scroll-to-end button works, press and hold selects text, every key fits on screen, and a linked computer's channel keeps your phone's size. Also in 1.11.5: the Trace icon, and linked computers' channels at their full size. Also in 1.11.4: a round of fixes from an audit of the whole app. Pasting images on Windows; scrolling, copying and sizing on the phone; safer Git reads; usage that includes Claude Code subagents; fixes for chat channels, linked computers, sync, updates and startup. Also in 1.11.3: approval alerts clear when Claude moves on, and Claude channels show how much context is in use. Also in 1.11.2: memory keeps working in projects where it was installed before the rename. Also in 1.11.1: chat channels keep their conversation, the phone reconnects by itself, security fixes for linked computers, and more accurate usage. Also in 1.11.0: Trace installs as Trace, scrolling and typing on your phone, and copying several lines from Claude Code. In 1.10.x: chat channels with images, plan limits, no lag while agents work, and copying that keeps sentences whole.

## Install

- **Windows:** download `Trace-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
