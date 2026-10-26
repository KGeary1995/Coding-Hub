## What's new

- **Token counts that agree.** "tok" on channels, in the status bar and in today's total now all count the same thing: new tokens (input outside the prompt cache, plus output). Channels used to add Claude's cache re-reads, which repeat the whole conversation every turn, so they could show more than the day's total. Hover a count to see the cache reads. Session budgets and Claude's session token limit count new tokens too.
- **Typing from your phone no longer comes out garbled.** While a channel is open on your phone it stays at the phone's size, even when the desktop window or tiles change; the desktop gets its size back when you leave the channel on the phone or type at the desk.

Also in 1.9.1: steadier under heavy output, accurate usage for long sessions, and a faster start.

## Install

- **Windows:** download `AI-Coding-Hub-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
