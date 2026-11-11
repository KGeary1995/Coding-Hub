## What's new

Not released yet: handoffs stay in front of automatic summaries, a hierarchy review has to say it found nothing, and screen sharing recovers by itself:

- **Your handoffs come before automatic summaries.** At launch, notes someone wrote (a handoff, a review record) are listed first, and at most two of Trace's automatic session summaries follow in the space left. Before, summaries counted the same as handoffs and could push them out.
- **Fewer empty summaries.** A session that changed no files, made no commits and ended on a short message (under 200 characters, such as "AGREE") no longer writes a summary. The hidden agents at a Round Table (a discussion table's partner, a hierarchy table's planner and reviewer) write none of their own; the channel you see still writes one.
- **A review must end with findings or NO FINDINGS.** At a hierarchy table, a Codex reply with neither (empty, or a question) used to count as a clean review and go straight to the final review. Now the table stops at the review and says so; **Continue** runs the review again. A second-round reply that only verifies fixes (`VERIFIED F1`) still moves on.
- **The planner writes its plan in the chat.** Its brief now says Trace runs it in Claude's plan mode, so it writes the whole plan in its reply instead of a plan file, and does not try to leave plan mode (Trace declines that).
- **A step that fails inside Trace says why.** The table stops with "Trace could not finish this step (…). Continue tries it again." instead of stopping without a reason.
- **Screen sharing recovers by itself.** A linked computer's screen that drops connects again on its own (**Reconnecting…**), up to three times, before it shows **Disconnected** and waits for **Reconnect**.
- **A shared Windows screen no longer freezes without a word.** When its capture failed or stopped, the last picture stayed up and nothing more was sent; now the session ends and the viewer reconnects. Plugging in or removing a display, or changing resolution or scaling, does the same, so the picture and clicks match the new layout.
- **The first clicks and keys on a shared Windows screen go through at once.** The helper that presses them starts when you connect, not on your first click.
- **Copied text keeps every character.** Between Trace's viewer and a shared Windows screen, curly quotes, long dashes and emoji no longer turn into "?".
- **No more strip that never updates.** When the picture of a shared Windows screen was not a multiple of 64 pixels wide (common with two displays of different sizes), changes reaching its right-hand edge were never sent.
- **Less lag on a slow link.** A shared Windows screen keeps at most two pictures on their way to the viewer, so a slow connection shows fewer, newer pictures instead of falling further and further behind.
- **Sharper text.** Once the shared screen has been still for a moment, the parts sent quickly while it changed are sent again at high quality.
- **One display at a time.** With several displays, **Display** on the screen's bar shows one of them on its own at full size, or all of them again.
- **The screen service starts again by itself** after an error, and Trace, while open, starts it again if it has stopped.
- **See and control a Windows computer from the phone.** **Screen** in the phone app now works on a Windows computer that shares its screen, for a phone with **Can start and stop agents** turned on (Settings → Phone access; off by default). There is no extra password, and turning the setting off closes the phone's screen at once. The computer shows the phone's name by the clock while it watches. Reload the phone app.
- **Control apps running as administrator.** **Also control apps running as administrator**, under Settings → Other computers → Share this screen, runs the screen service as administrator. Windows asks permission once, and an administrator account is needed. Windows prompts and the lock screen still cannot be controlled. **Know the cost before turning it on:** the service then runs as administrator at every sign-in without asking, from a folder your account can change, so any program running as you could use it to get administrator rights without Windows asking; and anyone viewing the screen controls apps running as administrator.

1.17.1 shows which model is at work at a hierarchy Round Table, fixes several ways a hierarchy table could go wrong, and keeps backups out of your projects (update every computer):

- **See who is working.** A hierarchy table's bar lists its three seats (the planner, the builder and Codex), each with what it is doing now and its tokens today, and each step names its model: "Fable 5.2 writing the plan…", "Opus 5.5 building…". The planner's messages have their own colour (lime), so they no longer look like the builder's.
- **Your reply goes on with the task.** When the table stops or needs you, what you write continues the same task: it goes with the step when it continues, or to the builder as changes that the planner then reviews again. Before, it replaced the task, so "go ahead" became the whole task. A new task starts once the table is idle or done, or when you send one from Tasks.
- **Continue after Stop waits for the agent to stop.** Pressing Continue right after Stop could let the stopped turn move the table on, to the review while the builder was still working. The bar now says **Stopping…** until the agent has stopped, then offers Continue.
- **A planner or reviewer that stops no longer leaves the builder working alone.** The table refuses messages and tasks instead of sending them to the builder unplanned and unreviewed, and offers **Reopen**, which starts that agent again and picks the work up at its step.
- **"Each channel must have exactly one grid tile" is fixed** after closing a Round Table opened from the phone, or one whose agent took a while to stop.
- **Findings are kept.** A closed table's findings that could not be saved to shared memory stay with the channel through a restart.
- **Restart and Close from the phone** wait for a hierarchy table's planner too.
- **A task from Tasks reaches a hierarchy table's steps cleanly.** Its "end with TASK COMPLETE" instruction is left out, since the planner's APPROVED decides, so it can no longer hide APPROVED or PLAN READY.
- **Backups stay out of your projects.** When Trace changes `CLAUDE.md`, `AGENTS.md`, `.mcp.json`, Codex's `config.toml` or `.claude.json`, it now keeps the earlier version in its own data folder (`~/.coding-hub/config-backups`, the newest 20 per file) instead of a `.coding-hub-backup-…` file beside it. Backup files already in your projects are left alone; you can delete them.

1.17.0 brings a hierarchy Round Table, work you can trust is finished, checks that say what they tested, and memory that keeps track (update every computer and reload the phone app):

- **A task is done when the agent says so.** Every task asks the agent to end with `TASK COMPLETE`, or `TASK BLOCKED:` and what it needs. Only `TASK COMPLETE`, as the reply's last line and after that send of the task, moves a task to Ready for review; `TASK BLOCKED` keeps it in **Working** as waiting for you, and a turn that ends any other way (a question, say) keeps it there marked "not confirmed done". A channel that stops or fails, or a chat turn that ends in an error, marks the task too, with **Send again**. A quiet Codex terminal is checked the same way from its transcript.
- **Checks say which files they tested.** A verification run records the files it ran on (by content) and whether they changed while it ran. Verification and task cards say whether a pass still holds, the files changed since, or Trace can't tell.
- **Everything about a task in one place.** Each task card has **Everything about this task**: what was asked, channel, folder, branch and commit, changed files, the check, Round Table findings and the pull request opened from it. **Tasks** is in the top bar now.
- **A task in its own worktree.** **New worktree…** on a To do task makes a branch and folder from the last commit, applies your shared rules there, adds a Claude or Codex chat and sends the task. Dependencies are not installed for you.
- **Tasks reach both agents at a Round Table**, and a task shows only its own evidence: the findings reported while it was the channel's task, and the pull request you chose it for (**For task** in Changes → Delivery).
- **Needs you, on the computer and the phone.** A status bar cell, and the top of the phone's channel list, list everything waiting for you: approvals (with the request and how long it has waited), failed channels, and tasks that stopped, went quiet or are ready for review, each with its next step.
- **After a restart.** One notice says which tasks were cut short. A Round Table keeps its findings, and a message that was waiting for the agents is kept, with its images up to a size limit, until you choose **Send now** or **Drop it**. Closing a table saves its whole review record, and each finding not yet verified as an open item, in shared memory; if that fails, the table stays open.
- **A hierarchy Round Table.** **+ Channel → Round Table (hierarchy)** gives a task to three agents in fixed steps: Fable 5.2 writes the plan, you approve it (or say what to change), Opus 5.5 builds it, Codex reviews, Opus fixes (up to two review rounds), and Fable gives the final review. The task is done only when Fable says APPROVED; CHANGES NEEDED goes back to the Fix step (Opus fixes, Codex reviews again, Fable reviews again), up to twice, before the table asks you. Only Opus edits files. The bar shows each step, **Approve plan**, **Stop** and **Continue**, and both Claude models, which you can change. It runs three agents, so it counts as three of the eight channels. The Round Table where both agents discuss is still there.
- **Round Table findings.** The reviewer reports problems as findings (F1, F2, …); the driver answers each FIXED or DECLINED and the reviewer checks it VERIFIED or REOPENED. The table bar lists them with their evidence and the files they were reviewed on; a finding from a turn during which files changed says so. The next round waits until the record is written.
- **Shared memory keeps track.**
  - **Pinned decisions** stay in front of every session until retired, and **open items** (to-dos) until resolved. Both come first at launch; the Shared memory screen lists them with **Retire** and **Resolve**.
  - Agents can search notes, revise one, and name the commits a handoff made: Trace says whether each is pushed, as of the last fetch.
  - Codex chats and Round Table reviewers can use shared memory (Codex refused its tools there).
  - A channel's settings choose its **Shared memory project**; a channel in your home folder gets a warning, since everything started there would share one set of notes.
  - Notes written by later versions of Trace are kept rather than skipped.

1.16.4 gives Trace a new logo (update every computer and reload the phone app):

- **New logo: the amber key.** The app icon, the logo in the top bar and the phone's logo are now an amber keycap with a bold T cut out of it, sitting on a darker amber edge. It replaces the cyan ring. The small icons in the Windows taskbar and title bar have their own drawing, with a heavier T, so the T stays clear at 16 and 32 pixels.

1.16.3 fixes saving with a Round Table, lets agents work without asking for every edit, and fills the context gauge for Claude (update every computer and reload the phone app):

- **Saving works with a Round Table.** With a Round Table open, Trace showed "Each session must have exactly one grid tile" and "Storage needs attention", and saved nothing: the second agent has no tile of its own, and the save still expected one. It now saves, and tables saved by 1.16.0 and 1.16.1 still load.
- **Permissions for every channel.** Each Claude and Codex channel has **Permissions**: **Ask** (the CLI's own settings), **Allow edits** (edits files without asking; Codex also runs commands in the project) or **Full access** (never asks; shown in orange). The default is now **Allow edits**, including for channels you already have. A chat changes it from beside the message box, even mid-conversation; a terminal channel takes it from its settings when it starts. At a Round Table it applies to both agents, and the reviewer still stays read-only. Phones and other computers can't change it.
- **Writing to a Round Table no longer stops the agents.** A message sent while they work waits until both finish their turn, then goes next. Several messages go together. **Stop** still stops them. The driver also no longer asks whether to go ahead with what you already asked for.
- **The context gauge fills for Claude.** Claude Code channels now show how much of the context window is in use, from the window size Claude itself reports (1M for current models). Chats and Round Tables get it with each reply. Terminal channels get it through a status line Trace adds, which shows nothing; if you have a status line of your own, Trace leaves it alone and that channel shows only the token count.
- **A Round Table is labelled and counted as one.** Its channel says **Round Table**, and its token count includes both agents. On the phone it's listed as a Round Table, and a chat or Round Table opened from an alert now shows its conversation instead of an empty terminal.
- **Claude in Chrome.** A Claude channel's settings have **Claude in Chrome**, which starts Claude with the Claude in Chrome extension so it can use your Chrome and its sign-ins. The extension must be installed and connected.
- **One logo everywhere.** The app icon, the logo in the top bar and the phone's logo are the same mark: one bold cyan ring with crosshairs and an amber centre.
- **Token counts when Trace is opened from Claude.** When Trace was opened from inside a Claude Code session, its Claude Code terminals saved no transcript, so they showed no tokens. Trace now starts them without that session's setting.

1.16.2 keeps Claude Code channels on the conversation you're actually in, and puts a Round Table in one tile (update every computer):

- **Channels follow /clear and /resume.** When you start a new conversation (`/clear`) or switch to another (`/resume`) inside a Claude Code channel, Trace now follows it. **Conversation**, restarts and usage all use the conversation you're in. Before, they stayed on the one the channel first opened, so a restart could take you back days. Needs Claude Code 2.1.319 or later. Codex channels don't follow yet.
- **A Round Table is one tile.** The second agent runs in the background instead of taking its own channel. The table bar shows its state, and **Show Codex** / **Show Claude** switches the tile to its side of the conversation. Its approval requests still appear in the tile. Closing the table stops it, and tables you already have become one tile when Trace starts. It still counts toward the eight channels, because it is a running agent.

1.16.1 finishes the new look and makes the Round Table easy to find (update every computer and reload the phone app):

- **Round Table from + Channel.** **+ Channel → Round Table** starts a Claude chat and seats Codex beside it, Claude driving first. Before, it was only reachable from the message box of a running chat channel. In the thread, each agent's messages carry its seat and whether it is driving or reviewing.
- **Flight Deck on every screen.** Page titles, section labels, buttons, Agent setup, Usage, Help, the start screen and the status bar now all follow the new design, not just the channels.
- **Channels read like instruments.** The header shows the channel number with its agent; a footer shows the context gauge, today's tokens and output speed. The channel you're working in gets the corner brackets.
- **New app icon.** Trace's icon on Windows, macOS and the phone is the new reticle.
- **A shorter + Channel menu.** The descriptions under each choice are gone.

1.16.0 brings a new look, the Round Table, and a much more capable phone app (update every computer and reload the phone app):

- **A new look.** Trace has a new design, "Flight Deck": dark slate with a faint grid, Claude in amber and Codex in cyan, square frames, and the Chakra Petch typeface for the interface. Corner brackets mark the channel you are in and any channel that needs you, and only a channel waiting for you glows. Context shows as a segmented gauge. The phone app uses the same design.
- **Round Table.** Bring Codex into a Claude chat, or Claude into a Codex chat, with the people button beside the message box. Both agents answer you, then each sees the other's answer and replies, for up to two rounds (you choose up to five), stopping early when both agree. One drives and edits files; the other reviews and stays read-only, and **Swap** changes who. The conversation shows as one thread, each agent in its own colour, with their tokens today. A Round Table comes back after a restart, and works on the phone and on your other computers' tabs.
- **The phone does much more.**
  - Chat channels are a real chat on the phone, with approvals, photos and Stop, instead of "use the computer".
  - New tabs: **Usage** (today's tokens and cost, budget and plan limits), **Tasks**, **History** and **More** (memory handoffs).
  - With **Can start and stop agents** turned on for that phone (Settings → Phone access, off by default), it can start, stop, restart and add channels, move tasks, resume conversations and open a Round Table. Removing a phone still locks it out at once.
- **Chats on your other computers.** Another computer's tab now shows its chat channels in full, and you can write to them and answer their approvals from here.
- **The Design workspace is gone.** It was hard to use and nothing put designs in it. Designs and notes you saved are left on disk; Claude Design is in Claude itself (claude.ai).

1.15.4 fixes several problems with accounts, usage, sync, linked computers and shared memory:

- **Default channels use your own Claude login.** When Trace was started from a terminal with an API key or login token exported (for example a work token), Default channels and the usage card quietly used that account. Trace now drops inherited keys and tokens for the default sign-in, as it already did for named profiles. A `CLAUDE_CONFIG_DIR` you set is still respected. The usage card names the account Default is signed in as.
- **Usage checks no longer start a dozen CLIs at once.** Checking plan limits ran every Claude profile's check at the same time, which slowed the computer and could make checks time out. They now run two at a time.
- **New programs work without restarting Trace (Windows).** A CLI or tool installed while Trace was open (Node.js, winget, an npm with its own folder, a PATH change in System Properties) wasn't found until Trace restarted. New channels now pick up Windows' current PATH.
- **Token counts include what Claude writes to its cache.** Claude reports input it caches apart from other input, and Trace left it out, so a turn that sent 40,766 new tokens could show 766. Counts, today's total, Usage and budgets now include it. Cache re-reads are still not counted. Session token limits are reached sooner than before.
- **Prices match dated model names.** A rate entered for `claude-opus-5-5` now also prices runs logged as `claude-opus-5-5-20261101`, and case no longer matters. Context-size variants such as `[1m]` still need their own row.
- **Sync says why a Drive folder can't be used.** A Mac started with the Windows folder `G:\My Drive\Coding Hub` and never synced, without saying so. On a Mac there's now no default folder, and Memory and **Settings → Sync between computers** say when the folder isn't chosen, isn't a full path on this computer, or is missing. **Sync between computers** also warns when a computer on your tailnet never appears in this sync folder, which usually means the two use different Drive folders.
- **A removed link offers a code.** When another computer removed this one, Trace showed an error but kept the dead link, and you had to **Unlink** before you could enter a code. The link is now dropped, the row says "Removed on <name>", and the code box is right there. Trace doesn't link it again on its own, since the removal there was on purpose.
- **Shared memory problems are easier to spot and fix.**
  - When a project's own memory entry uses a different key or notes folder from Trace's automatic memory, **Memory** shows it and offers **Use automatic key**. That only changes Trace's own entry, and only when you click.
  - An entry Trace didn't install, which turns automatic memory tools off for that folder, is now explained.
  - Installing memory into a subfolder of a repository is refused, because CLIs only read project settings from the top folder.
  - Shortly after Trace starts, memory entries left pointing at a program that no longer exists are fixed in every folder you've run agents in, so CLIs started from other terminals work again.

1.15.3 fixes saving with a single channel, copying on Windows, and Changes outside Git:

- **One channel saves again.** With only one channel open, Trace showed "Too small: expected array to have >=2 items" and couldn't save your channels or install updates. Since 1.15.0 you can close channels down to one, but the save still required two. It now accepts one. To install this update from 1.15.0 to 1.15.2 with one channel open, open a second channel first (**+ Channel**); you can close it afterwards.
- **Ctrl+C copies on Windows.** In a channel on this computer, Ctrl+C with text selected sent the CLI an interrupt instead of copying, while channels from your other computers copied. It now copies and clears the selection, as Windows Terminal does; with nothing selected, Ctrl+C still interrupts. Claude Code's full-screen view copies as you finish dragging, as before.
- **Changes outside Git says so.** For a folder that isn't a Git repository, **Delivery** showed "The command failed or timed out" and stayed on "Reading the repository…". It now says the folder isn't a Git repository.

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
