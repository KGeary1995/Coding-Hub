## What's new

1.11.1 fixes the problems found in a review of 1.11.0:

- **Chat channels keep their conversation.** A chat is saved in the channel's history, so it can be searched and exported, and resuming a saved conversation shows its earlier messages instead of an empty thread.
- **Chat channels behave.** The channel header's interrupt button and "Send prepared request" now go through the chat instead of breaking it, approval buttons close when a reply is interrupted, and closed chats no longer hold on to their messages and images.
- **A chat CLI that fails to start can no longer crash Trace.**
- **Phone and linked computers:** chat channels are labelled as chat and explain that they are answered on their computer, instead of showing an empty screen. The phone reconnects by itself when its connection goes silent, instead of showing "live" indefinitely.
- **Security:** a computer you remove can no longer finish asking for a phone key it started requesting just before, and an unusual request from a linked computer can no longer make the list of paired devices unreadable.
- **Conversation history** lists the newest conversations from Claude, Codex and every Claude profile, however large one history is, and resuming a saved channel finds its conversation however old it is.
- **Usage:** a run whose usage could not all be read shows its warning at once and is shared with your other computers; other computers' usage is priced with this computer's rates; the daily bars count tokens on the day they were used.
- **Restoring a backup:** channels on a named Claude profile start a new conversation instead of refusing to start (backups don't include those profiles' conversations).
- **Closing and quitting** also ask about a sign-in terminal that could not be stopped, and **design screenshots** compare correctly on Retina displays.
- **Memory summaries** are no longer missed for short conversations.

Also in 1.11.0: Trace installs as Trace, scrolling and typing on your phone, channels no longer shrink by themselves, copying several lines from Claude Code, and today's token count including channels started yesterday. In 1.10.x: chat channels with images, plan limits, no lag while agents work, and copying that keeps sentences whole.

## Install

- **Windows:** download `Trace-<version>-Windows-x64-Setup.exe` and run it. Windows may warn about an unrecognized app because the installer is not code-signed yet: choose **More info → Run anyway**.
- **Mac:** download the `.dmg` for your Mac (Apple menu → About This Mac shows Chip: Apple = arm64, Intel = x64), open it and drag the app to Applications.

Your settings, history, rules and memory stay in `~/.coding-hub` and carry over between versions.
