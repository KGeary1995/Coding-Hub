## What's new

1.15.3 fixes saving with a single channel:

- **One channel saves again.** With only one channel open, Trace showed "Too small: expected array to have >=2 items" and couldn't save your channels or install updates. Since 1.15.0 you can close channels down to one, but the save still required two. It now accepts one. To install this update from 1.15.0 to 1.15.2 with one channel open, open a second channel first (**+ Channel**); you can close it afterwards.

1.15.2 shows every screen of a Windows computer (update the Windows computer):

- **All displays, not just the main one.** Viewing a Windows computer from another computer showed only its main display. **Screen** now shows every display side by side, arranged as in Windows' display settings, and clicks and drags land on whichever display you point at. One display is sent as before (up to 1920×1200); several share up to 3840 wide, so two ordinary monitors stay full size. The viewer fits the whole picture in its window, so with two displays each one shows at about half the size; make the window wide or full screen.

1.15.1 fixes seeing and controlling a Windows computer's screen from another computer (update both computers):

- **No more "Screen sharing is off" when it isn't.** When the Windows computer took a while to start sharing its screen, the other computer gave up after 10 seconds and said sharing was off. It now waits up to 30 seconds, and if the screen still hasn't started, it says so and offers **Reconnect**.
- **A stuck screen no longer leaves you waiting.** If the Windows computer can't start capturing its screen within 20 seconds, it stops trying and says why. Turning **Share this screen** off and on there starts it fresh.
- **Says when a Windows computer is locked.** Windows takes no keys or clicks from other programs at its lock screen, so typing did nothing with no explanation. **Screen** now says the computer is locked and that it has to be unlocked there, and names the setting that keeps it from locking while you're away. This needs Trace open on the Windows computer.

1.15.0 coaches your prompts as you send them, keeps today's token counts through restarts, allows a single channel, and opens Windows terminals as administrator:

- **Live coaching.** Trace checks each prompt you send in a Claude Code or Codex channel and shows up to two tips under that channel, for example when an error has no message or a task has no way to tell it worked. The checks run on your computer and use none of your plan. **Ask AI** has Claude Haiku review that prompt in a few seconds, with advice and a rewrite you can copy; that uses a little of your Claude plan. Every prompt is also listed under **AI coaching → Live coaching**, where you can save it as an example or turn live coaching off.
- **Today's tokens hold through restarts.** Each channel's `tok` shows its tokens today, and keeps counting when the channel or Trace restarts. **Σ today** now reads Claude Code's and Codex's own logs, so it also counts what you did outside Trace or while it was closed.
- **Resumed conversations no longer count twice.** When a channel resumed a conversation that had used subagents (the Task tool), Trace counted those subagents' usage again, so a channel could show far more than it used. Usage history is corrected too.
- **Usage counts the day it happened.** The Usage screen's totals and chart now come from the same logs as **Σ today**, by the day each reply was written (the last 60 days), so they match the status bar and include what you did outside Trace. The table still lists Trace's sessions.
- **Alerts from your other computers.** When a channel on another computer waits for you or fails, Trace shows a notification while it isn't in front (click it to open that computer's tab), and the status bar lists it.
- **Update another computer from here.** **Update** on another computer's tab installs the latest Trace there and restarts it. On a Mac that can't update itself, Trace checks that the new version starts and answers, and puts the old one back if it doesn't. Both computers need 1.15 for this, so the Mac needs one last install by hand.
- **Coaching everywhere.** Tips also show under another computer's channels and on your phone. **Ask AI** uses Codex when Claude Code isn't installed, and its usage now counts in your totals.
- **Notifications for this computer's channels.** A channel here that waits for you or fails now notifies you too, while Trace isn't in front.
- **Daily budget and limit warnings.** Set a daily token or dollar budget under **Settings → Alerts and daily budget**. Trace warns you at 80% (or the share you choose) and when it's used up, and does the same for Claude's and Codex's session and weekly limits.
- **A coaching week in review.** Coached prompts are kept for 30 days, and the Coaching page sums up the last 7: how often a prompt had no way to check it worked, no error text, and so on, and what would help most. **Clear coached prompts** forgets them.
- **Older usage, by the right day.** Claude runs recorded before this version are dated reply by reply from Claude Code's own logs, so a run that went past midnight counts on both days.
- **Tasks that run themselves.** **Task** on a channel gives it a job, and optionally the files it may change. **Save and send** types it into the agent. The task moves to Working, then to Ready for review when the agent finishes, with the files it changed, and you mark it done; you can also drag cards between columns. Trace warns you, on the task and under the channel, when an agent changes files outside its task or the same files as another task. The screen is now just **Tasks**, in plain words, with a how-to.
- **Smaller fixes.** History loads without pausing the window. A chat approval that Claude withdraws now closes. A channel that fails to start no longer leaves its setup behind. Removing a worktree deletes its branch when that branch's work is already merged. Sent images under a channel can be removed one by one, or all at once with **Clear**.
- **One channel is enough.** You can close channels until only one is left. Before, Trace always kept two.
- **Terminals as administrator on Windows.** Terminal channels open PowerShell as administrator through Windows' own sudo, and Windows asks for approval each time one starts. Turn sudo on once in Windows Settings → System → Advanced → **Enable sudo**, and set it to **Inline**. Until then, terminals open normally and say how to turn it on.

1.14.0 lets you read whole conversations, see your Mac's screen from your phone, and close and arrange another computer's channels (update both computers and reload the phone app):

- **Conversation.** Claude Code and Codex channels have **Conversation**, which shows the channel's whole conversation, including what was said before restarts. It works on the computer itself, on another computer's tab and on the phone.
- **Screen on your phone.** **Screen** above the channel list shows your Mac's screen and lets you control it: tap to click, drag to move, type in the field under it. It uses the Mac's own Screen Sharing and asks for your Mac's user name and password. A locked Mac still shows black.
- **Close another computer's channels.** **Close** on a channel in another computer's tab stops it and removes it there, after you confirm.
- **Arrange another computer's channels.** Drag another computer's channels by their grip and resize them by their corner. The arrangement is kept on this computer only; that computer's own layout doesn't change.
- **Locked Mac, said plainly.** The Screen note now says that with only Screen Sharing on, a locked Mac takes no keys from Trace, so unlock it at the Mac.

1.13.3 keeps Claude Code channels' conversations across restarts, and says when a Mac is locked (update both computers):

- **Claude Code channels keep their conversation again.** When Trace was opened or updated by a Claude session (for example, asking the Claude app to update Trace), every Claude Code channel acted as part of that session and stopped saving its conversation; a restart then resumed from before it. Trace now starts Claude Code without that session's settings. Quit and reopen Trace once after updating.
- **Locked Mac, always noticed.** Trace on a Mac now asks macOS whether the screen is locked. Before, a Trace that started or updated while the Mac was already locked said the Mac was unlocked, so the PC showed a black screen without saying why. With only Screen Sharing turned on, macOS 26 takes no keys from Trace at its lock screen, so unlock the Mac there.

1.13.2 lets you unlock a Mac whose Trace cannot say it is locked (update the PC):

- **Unlock, always there.** A Mac's lock screen shows black to Trace: macOS shows it only to Apple's own viewer. When Trace on the Mac is closed or older than 1.13.1, so it cannot say it is locked, **Unlock** in the Screen bar opens the password field. **Wake and unlock** wakes the Mac, types your password at its lock screen and presses Return.

1.13.1 says when your Mac is locked, and unlocks it from your PC (update both computers):

- **Locked Mac, said plainly.** A Mac's screen goes black to Trace while the Mac is locked. Trace now says the Mac is locked instead, and asks for its password.
- **Wake and unlock from the PC.** **Wake and unlock** wakes the Mac, types your password at its lock screen and presses Return, then shows the desktop. **Use saved password** uses the password you saved for Screen. Trace on the Mac must be open for it to say it is locked.

1.13.0 finds your other computers on Tailscale and links them without a code (update both computers):

- **Your computers find each other on Tailscale.** Every computer signed in to your Tailscale account with Trace open appears under **Settings → Other computers** within a minute. This works even when their Drive sync folders differ.
- **No link code between your own computers.** Two computers on the same Tailscale account link by themselves, and each gets its own tab. Tailscale confirms who is connecting, so phones, devices shared from someone else's account, tagged devices and the internet still need a code.
- **You decide.** **Link my computers automatically** (on by default) turns it off. A computer you unlink stays unlinked until you link it again with a code.

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
