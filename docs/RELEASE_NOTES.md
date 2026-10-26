## What's new

- **Pasted images behave like attachments.** Images you paste or drop into a channel show under it as **Attached**, numbered like Claude's `[Image #1]`. When you press Enter they move to a smaller **Sent** row with the time, so the next message starts empty. (The conversation itself still shows only the image's number or path: Claude Code draws it as text.)
- **Channels named after their repo.** A channel you haven't renamed shows the folder it works in (say *Coding-Hub* or *ADHD-Tax*) instead of "Claude Code" or "Codex"; the model and badge colour still tell them apart. While Claude Code works on something, its summary of the task appears next to the name, on your phone too. A name you give a channel always wins.
- **Token counts that agree.** "tok" on channels, in the status bar and in today's total now all count the same thing: new tokens (input outside the prompt cache, plus output). Channels used to add Claude's cache re-reads, which repeat the whole conversation every turn, so they could show more than the day's total. Hover a count to see the cache reads. Session budgets and Claude's session token limit count new tokens too.
- **Typing from your phone no longer comes out garbled.** While a channel is open on your phone it stays at the phone's size, even when the desktop window or tiles change; the desktop gets its size back when you leave the channel on the phone or type at the desk.

Also in 1.9.1: steadier under heavy output, accurate usage for long sessions, and a faster start.

## Install

- **Windows:** download `AI-Coding-Hub-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
