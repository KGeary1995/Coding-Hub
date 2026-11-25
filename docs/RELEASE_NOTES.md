## What's new

1.44.0 adds Review again, catches a turn's end a CLI forgot to report, compacts chats after their handoff, and lines up emoji in terminals.

- **Review again.** When a hierarchy Round Table's final review still asks for changes after its two rounds, **Review again** on its bar runs one more round: the builder makes the changes, the reviewers check them, and the final review runs again. Up to five final reviews per task.
- **A turn's end that the CLI did not report.** When a Claude Code or Codex terminal stops showing work and stays quiet for 8 seconds without saying its turn ended, Trace ends the turn itself, so Done, tasks and automatic checks are not left waiting. A turn's end is never counted twice. Any agent whose CLI sends OSC 7501 status, as Gemini does, is read the same way.
- **Chats are compacted after their handoff.** Near the end of its context, a Claude Code or Codex chat that saved its handoff is compacted, as terminal channels already were. The conversation shows `/compact`.
- **⚠️ and ✔️ line up in terminals.** Emoji made wide by a variation selector now take the two columns the CLIs draw them in, so the text after them is no longer a column off.
- **Fixed:** a click on a channel's Controls could miss while a busy chat's state word changed (Working, Done, Your turn), because the word changed the header's layout under the pointer. The state stays one width now.
- **Prices** checked against Anthropic's, OpenAI's and Google's pages on 2026-11-25: unchanged.
- **Tried:** unit tests (each new behaviour), the desktop and terminal smoke tests, `/compact` in Claude Code's chat mode with the real Claude Code (2.1.332), and the emoji widths on Node 22 and 24.
- **Not tried yet:** Review again with real agents, the turn-end check with a real CLI that missed its signal, and Codex's compaction with the real Codex.

1.43.0 keeps your computers reachable from each other, and makes **New channel** shorter.

- **Open Trace when you sign in.** Trace now starts in the tray when you sign in, so your phone and other computers can reach this computer after a restart or an update, without anyone opening Trace. It's on by default, set on each computer: Settings → Preferences → **Open Trace when you sign in**. On Windows it is **Trace** under Settings → Apps → Startup; if you turn it off there, Trace leaves it off.
- **Ask before quitting.** While a phone or another computer can reach this one, Trace's **Quit** (in the tray, and Cmd+Q on a Mac) asks first and offers to keep Trace in the tray instead. **Don't ask again** turns it off. Shutting down or signing out of your computer never asks.
- **Open Trace on your other computer.** When your Windows PC can't be reached because Trace is closed there, its tab here offers **Open Trace on** it. With **Share this screen** on, the PC's screen service, which runs from sign-in, starts Trace in its tray, and the tab connects by itself. Only your linked computers can ask; phones can't. On a Mac, or when the computer is asleep, the tab says what to do instead. The PC needs 1.43.0 for this.
- **Gemini in Accounts.** Accounts → Command-line tools now lists Gemini (`agy`) with its sign-in state, and **Connect Gemini** starts it in the sign-in terminal. When you sign in, choose your Google account and the free or individual option: Google Cloud and Pay As You Go ask for a Cloud project, and quitting at that step leaves Gemini signed out. Fixed on the way: the Accounts check never ran for Gemini, so it showed as not verified even when signed in.
- **A shorter New channel.** One row per agent, with **CLI** or **Chat**, and one **Round Table** row with **Discussion** or **Hierarchy**. Agents you added get the same row when they have a chat. The phone's **+** menu has the same rows.
- **Fixed:**
  - **A chat that continued after Restart showed no reply.** The first answer after a restart got the same name as the first answer before it, so it was added to that old message, or dropped when the words were the same. This hit chats with agents you added and Gemini chats. Also, when such an agent changed its own mode between turns, the next message now goes instead of waiting forever.
  - **Memory listed commits on a remote branch called "origin"** that does not exist, with git 2.48 and later.
  - **A phone that reconnected took a channel's size back**, even while you were typing at the computer. Now it waits until you touch the channel on the phone.
  - **Error lines showed leftover terminal codes** before the message (`1u1uu4;0m q`), from what Codex sends as it exits.
  - **The restart line said "Claude"** for every agent; it now names the one in the chat.
  - **Gemini tasks:** **Start in worktree** offers a Gemini chat, and Tasks and scheduled jobs no longer say Trace can't read Gemini: it reads TASK COMPLETE from its screen, and other agents can read its replies.
  - **The app preview covered Trace's own menus and dialogs** that opened over it; it now steps aside while they are open.
  - **A notice raised to the top could cover the header of the terminal** you were working in; a failed Round Table partner's notice is shown when its lead's Round Table bar is out of view.
  - **An agent whose program is its chat server** (like Claude Code's ACP adapter) is offered as a chat only, not as a terminal that would only show the protocol.
- **Tried:** unit tests (the screen service only opens Trace for a linked computer's key, at most once in 20 seconds, and refuses phones, Funnel and sharing turned off); the desktop and Round Table smoke tests; and Trace started hidden (`--hidden`) loads its window without showing it.
- **Also tried:** the restart fix with the real Claude Code ACP adapter (the chat continued the conversation after Restart), and Gemini's Accounts row with the real `agy`.
- **Not tried yet:** the sign-in entry in an installed Trace on Windows and on a Mac, the Quit question by hand, and opening Trace on a real Windows PC from the Mac. The phone's reconnect change was not tried on a phone.

1.42.0 shows your other computer's conversations, and resumes them there.

- **History on another computer's tab.** Open your other computer's tab and choose **History**: its Claude Code, Codex and Gemini conversations are listed, newest first, with a filter by title, folder or agent. **Resume** continues one on that computer: it is added there as a new channel, which shows on its tab here, ready to start.
- **Why not on this computer?** Each CLI keeps its conversations in its own folder on the computer that ran them, filed under the project's path there (`C:\Users\…` on Windows, `/Users/…` on a Mac). Trace does not copy them between computers, so a conversation always continues where it was held. Your phone's **History** already worked this way.
- Needs Trace's window open on the other computer. Only this computer needs 1.42.0: the other one answers from Trace 1.16 on.
- **Tried:** unit tests, including a stand-in for the other computer, a list it cannot read, and an older Trace there.
- **Not tried yet:** the tab with two real computers, and the screen by hand.

1.41.1 makes Codex start again in projects where shared memory was installed into the project.

- **Fixed: Codex stopped as it started.** In a project where **Memory** → install into project had added Trace's memory server to `.codex/config.toml`, every Codex channel quit at once with "failed to load workspace requirements: invalid data". Trace passed Codex only an approval for that server, which Codex does not join to the project's own entry. Trace now passes the whole entry again, with the project's own memory key, so the channel uses the same notes as before.
- **Tried:** unit tests; and with the real Codex (0.164.0 and 0.172.0) in such a project: the old start fails, the new one starts, and Codex used the shared memory without asking.
- **Not tried yet:** the packaged app on Windows with a project set up this way.

1.41.0 completes agents you add yourself (Agent setup → **Agents**).

- **From a list.** **Add an agent** → **From a list**:
  - **Show shared agents** lists ready-made agents that people share on GitHub. Nobody reviews that list, so check each one yourself.
  - You can also paste a GitHub address.
  - The agent you pick opens in the usual form. Nothing runs until you save it and confirm the program in the system dialog.
- **Your agents follow you.** Agents sync between your computers with your other settings.
  - One that arrives from another computer stays **Off** until you check it and turn it on there.
  - When both computers change the same agent, the newer change wins. The older version is kept in Trace's backups.
- **Chat and Round Tables.**
  - An agent that speaks the Agent Client Protocol, the one Gemini uses, gets a **<Name> chat** in **New channel**, on the computer and the phone.
  - It can take any Round Table seat, including leading and making the changes.
  - At **Ask** it only reads: a file change it asks for is declined, and the chat says so.
  - **Draft it for me** fills this in when the program's help mentions it.
- **Continue a conversation from a list.** In a custom channel's settings, **List its conversations** shows the agent's past conversations to pick from, when its program can list them.
- **First request with the start.** Start in order and scheduled jobs give an agent its first request as it starts, when its program takes one that way.
- **Another computer's tab** offers that computer's agents in **New channel**.
- **Clearer settings.** An agent without permission levels says so instead of showing an empty list, on the computer and the phone. The Usage page says that usage isn't tracked for agents you add, since each program reports it differently.
- **Fixed:** a test that checks a channel resumes after Trace restarts sometimes failed on its own. It now reads the channel's saved output.
- **Tried:**
  - Unit tests and every smoke test, with stand-in agent programs.
  - The real Gemini (agy 1.5.16), defined as a custom agent and driven through the new chat code: at Ask it changed nothing in the project, and at Allow edits it wrote the file it was asked to.
- **Not tried yet:**
  - A real shared agent on GitHub.
  - Sync between two real computers.
  - Another ACP agent than Gemini.
  - The new screens by hand in the running app.

1.40.1 makes Ask mean read-only for Gemini.

- **Gemini at Ask only reads.** In a terminal and in a chat, Gemini at **Ask** now runs in its plan mode: it answers questions and makes plans, but does not change your files. If it still asks to change a file, Trace says no and tells you so in the chat. To let it edit, choose **Allow edits**. A Round Table led by Gemini at Ask discusses but does not edit. Claude Code and Codex are unchanged.
- **Tried:** unit tests; and with the real Gemini (agy 1.5.16), asked in plan mode to create a file and change another, it changed neither.
- **Not tried yet:** a Gemini chat at Ask inside Trace with the real Gemini.

1.40.0 lets you add any command-line agent to Trace yourself, without waiting for a new version of Trace.

- **Add an agent.** Agent setup → **Agents** → **Add an agent**. There are three ways:
  - **Draft it for me:** Trace reads the program's help, and your Claude Code writes the description.
  - Fill in a short form.
  - Paste a definition.
- **Before it's saved:**
  - **Test start** shows what the program prints.
  - A system dialog shows the exact program and arguments Trace will run. Nothing is saved until you confirm.
- **What the new agent gets:**
  - Its own **New channel** entry, colour and initials, on the computer and the phone.
  - A model list and permission levels, when its program has them.
  - Needs you and Done.
  - The automatic checks, Undo last turn, Start in order, scheduled jobs and Tasks.
  - Shared memory and the task tools, when the program accepts MCP servers.
- **Safe by default:**
  - Trace runs the program directly, never through a batch file or a shell.
  - A definition changed by hand, or copied in from elsewhere, stays **Off** until you confirm it again.
- **Tried:**
  - Unit tests.
  - The desktop and productivity smoke tests, with a stand-in agent program.
  - **Draft it for me** with the real Claude Code against the real Gemini (agy): it wrote a correct definition, with models, permission levels and resume, and it needed no fixes.
- **Not tried yet:**
  - A real third-party agent program running as a custom channel.
- **Not in this version** (planned):
  - A shared list of ready-made definitions.
  - Syncing definitions between your computers.
  - Usage and cost, a chat view, and Round Table seats for custom agents.

1.39.1 puts chats in **New channel**.

- **Claude Code chat, Codex chat and Gemini chat** are now in **New channel**, on the computer and the phone, beside the terminal versions. A chat shows the conversation in Trace's own view, with approvals as cards. Before, a chat came only from a Round Table, a task or a scheduled job. A Gemini chat follows its permission level as a Gemini seat does; at Ask, Gemini's own settings decide whether it asks before edits.
- **Tried:** unit tests, and the desktop and phone smoke tests with the new menus. **Not tried:** a plain Gemini chat with the real Gemini inside Trace.

1.39.0 adds a safety net and more automation, and makes Gemini a full peer of Claude Code and Codex.

- **Undo last turn.** Before each turn, Trace keeps a hidden copy of the project's files for every agent channel in a Git project: Claude Code, Codex and Gemini. **Undo last turn** on the channel puts every file back as it was before that turn, and **Redo** takes it back. Files your .gitignore leaves out are never touched, and Trace never changes your commits, branches or staged files.
- **A finished task becomes a pull request.** When a task moves to Ready for review in a project on GitHub, Trace waits for the project's checks to pass, then saves the changes on a new branch, pushes it and opens a pull request. The description has a plain summary, and the link appears on the task. If something is missing, such as no GitHub sign-in or failing checks, nothing is sent and the task says why. It never pushes to the main branch. Turn it off in Settings → Preferences → **Open a pull request when a task is ready for review**.
- **See your app inside Trace.** When a channel starts a dev server that prints a local address (`http://localhost:5173`), Trace opens the app beside your channels in a locked-down view. The channel's **Preview** button reopens it. On the phone, the channel's preview shows a live picture of the app.
- **Scheduled jobs.** Tasks → **Scheduled jobs**: give Claude Code, Codex or Gemini a request every day at a time, on chosen weekdays, or every few hours, for example "update dependencies and run the tests". Each run opens a fresh channel and shows on the Tasks board. Trace must be running; closing its window keeps it running in the tray.
- **Fewer approval prompts.** At Allow edits, Claude Code and Gemini run commands that only look at the project (git status, diff and log) or run its own tests, typecheck, lint and build without asking first. Anything else still asks. Gemini's rules match a command exactly as written. Turn it off in Settings → Preferences → **Let agents run safe commands without asking**.
- **Getting started.** A small guide at the bottom right ticks itself off as you open a project, start an agent, ask it something, see your project checked and set up the phone. Hide it with ×; the command menu shows it again.
- **Gemini, like the others:**
  - **Shared memory:** handoff notes at launch, and the memory, channel and task tools, through a small "trace" plugin that Trace keeps for agy. Your own agy settings are untouched.
  - **Search:** its past conversations are searchable in Session history, and its **Conversation** view works on the computer and the phone.
  - **Tasks:** it takes tasks, in a terminal (Trace reads TASK COMPLETE from its screen) and in a chat.
  - **Round Tables:** it can lead a Round Table and be the seat that edits. A table led by Gemini shows in a Gemini chat channel, and its edits follow the table's permission level. At Ask, Gemini's own settings decide whether it asks before an edit.
  - **Everything else from 1.38 and 1.39** works with Gemini too: the automatic checks, Start in order, Undo last turn and safe commands.
- **Fixed: Done and Needs you stayed after you had looked.** A channel whose turn ended while Trace was in the background was cleared only by clicking into it again. Typing in it, or coming back to Trace with that channel selected, now clears it too.
- **Tried:**
  - Unit tests for every change.
  - With the real Gemini (agy 1.5.15 and 1.5.16): its permission rules, the plugin's memory tools and launch notes, where its conversations are stored, its agent-protocol modes and approvals.
  - All desktop smoke tests, including a new app-preview step.
- **Not tried yet:**
  - A Gemini-led Round Table with the real Gemini inside Trace.
  - A pull request opened on github.com.
  - Scheduled jobs and Undo with the real agents over a day's work.
  - The phone's app preview on a real phone.

1.38.0 does more on its own and shows less you don't need, with ideas taken from herdr's plugins.

- **Simple by default.** Menus, the command menu and Settings show only the everyday parts. AI coaching, verification profiles, shared memory and rules, MCP servers, event hooks, engine and worktree details, model pricing and a few preferences come back with **Settings → Show advanced tools**. Nothing was removed.
- **Your project is checked after each agent turn.** When Claude Code, Codex or Gemini ends a turn that changed files, Trace runs the project's own checks: its `typecheck` and `test` scripts in package.json, or `cargo test`, or `go test ./...`. The result shows on the channel. A failure goes back to that agent to fix, up to 3 times in a row, then it is over to you. Turn it off in Settings → Preferences → **Check the project after each agent turn**. The checks are the project's own commands, run as you. A project without such scripts is not checked.
- **Start in order.** Give channels a step (each channel's settings → Start in order). A shell can have a command typed once it starts, an agent a first request, and a step can wait for a text in its output, such as a dev server's "ready". Channels with a step start on their own, lowest first, when the workspace opens (unless channels are already running) and when a template is applied. An agent's first request is sent once it is ready, after any trust prompt. **Start in order** on the top bar runs it again.
- **Speak a message on the phone.** A microphone next to Send, in terminal and chat channels. Your words fill the box, and nothing is sent until you press Send. It uses your phone's speech service: Apple's on an iPhone, Google's on Android.
- **Search inside past conversations.** Session history → Native: type some words and press **Search inside conversations** to find every Claude Code and Codex conversation that mentions them. The matching lines are highlighted, with Resume in a new channel. It searches what you and the agents wrote, not tool output. Gemini's conversations are not searched.
- **Commit history on Changes.** **History**, next to **Uncommitted**, shows the latest 200 commits with a branch graph and labels for HEAD, branches, remote branches and tags. Choose a commit to see its message and the files it changed. It only reads the repository.
- **Agents can use the Tasks board.** Claude Code and Codex channels can list their project's tasks, add one to To do, and move one to Working or Ready for review with a signed note. Only you mark a task Done, remove it, or change its title. Each change asks your permission as the CLI usually does. It is on by default; turn it off in Settings → Preferences → **Let agents read and update Tasks**.
- **Send code from VS Code.** Settings → VS Code → **Connect VS Code** installs Trace's extension. In VS Code, right-click selected code, choose **Send to a Trace channel**, pick a running agent and say what to do. The code arrives with its file and lines. There are no keys to copy: the extension finds Trace through a key Trace writes for your user only. A channel waiting for your approval is not sent to.
- **Gemini is called Gemini,** as Claude Code and Codex carry no "CLI". Channels still named "Gemini CLI" count as the default name.
- **Fixed:** a flaky failure in a release build. When Git's output passed its limit, Trace stopped only the first Git process, and the rest kept running in the repository.
- **Tried:**
  - Unit tests for every change, including the automatic checks with real npm scripts and the editor bridge's refusals.
  - VS Code's own installer installing the extension into a test folder.
  - All desktop smoke tests, with the advanced views reached through the new switch.
- **Not tried:**
  - Dictation on a real phone.
  - The automatic checks and Start in order with the real Claude Code and Codex.
  - The extension used inside a real VS Code window.
  - History on a very large repository.

1.37.0 installs Trace plugins from GitHub.

- **Install from GitHub** on Skills & plugins → Trace plugins: `owner/repo` (or a folder inside it), with an optional branch, tag or commit. Trace fetches it with this computer's Git, so private repositories work when Git is signed in to GitHub here; Trace never sees a token.
- **A preview before anything runs:** the exact commit, what it may ask Trace to do, every command it may run, and its files. Install asks once more in a system dialog, then runs its build steps.
- **Updates you choose:** a daily check (or **Check for updates**) shows **Update to …**; the update preview lists commands added or removed and new permissions. The version before is kept for programs still running it.
- **Browse** finds repositories with the topic `trace-plugin` on GitHub. Nobody reviews that list.
- **Tried:** unit tests against real Git repositories (preview, install with a build step, a failed build or a refusal installing nothing, update detection and its preview, the version kept, removal) and the input checks; the productivity smoke test installs a plugin from a repository through the page. **Not tried:** github.com itself and a private repository (the tests use local repositories in GitHub's place).

1.36.0 keeps terminal channels running after Trace quits, crashes or updates, brings them back when it opens, and makes the phone app usable.

- **Closing Trace by mistake no longer stops your agents.** Claude Code, Codex and Gemini CLI terminals, and shells, now run in a small background part of Trace (the runner). Quit, a crash or an update leaves them working; when Trace opens again each one is back in its tile, still running, with what it wrote meanwhile on screen. Settings → Preferences → **Keep channels running after Trace quits** (on by default, the installed app only) turns it off.
- **Stopping them:** each channel's **Stop**, or **Stop all channels and quit** in the tray menu. Restarting the computer stops them, and **Start channels again when Trace opens** brings the agents back on their conversations, as before.
- **Approvals still reach you** for a channel that kept running: Trace's hook servers come back on the ports they had, with each run's token, and the screen check from 1.35.3 is there if a port was taken.
- **Not followed again for such a channel:** its per-run usage entry and a session token limit. The run's log also lacks what it wrote while Trace was closed. Chat channels still stop when Trace quits.
- **On Windows, updates install while channels run:** they no longer wait for channels in the runner to stop, and the updated Trace takes them up. A Mac update still waits for them.
- **Stopping a channel on Windows ends everything it started,** including programs that left its process tree, which a process-tree stop missed: the runner puts each channel's program in a Windows job object, through a small helper that ships with Trace (`trace-jobs.exe`, built from `native/trace-jobs.c`).
- **The phone app, after herdr:**
  - **No more unreadable text.** A channel on the phone is drawn at the phone's size whenever you use it there (open, touch, type). If you then use it at the computer, the phone shows the wider screen at your text size, to swipe sideways, and a touch brings it back. **Desktop size** and **Fit to phone** are gone.
  - **Nothing takes the size by itself:** waking the phone, reconnecting or the screen turning waits for a touch.
  - **More room for the terminal:** one row of keys (Enter, Esc, Ctrl C, ↑, ↓, **More**). More holds the rest of the keys and the tools, and stays as you leave it.
  - **☰ switcher** in a channel's header: every channel, those that need you first, with their count on the button.
  - **Busy channels:** a phone that falls behind gets the screen as it is when it catches up, instead of a backlog. While no computer answers, the last screen stays, dimmed, and typing waits.
- **Fixed: Trace could freeze behind "A JavaScript error occurred in the main process"** (from 1.35.3). The screen check's off-screen terminal kept no lines above the screen, and in that setting the terminal library can fail after a channel is resized; the error stopped Trace until the box was closed. It now keeps one line, and a test repeats the sequence that failed.
- **Fixed: a channel restarted while the phone shows it** sometimes lost its first lines on the phone, when they arrived before the updated channel list.
- **Plugin tiles:** **New channel** lists the tiles of the plugins that are on (a plugin's `tiles` in its manifest). A plugin tile is a channel running that plugin's program, which Trace finds in the installed manifest; the window only names the plugin and the tile. It starts, stops, moves and shows on the phone like a Terminal channel, and is saved with the workspace; if its plugin is gone or off, starting it says so.
- **Why a copy:** the runner runs from its own copy of the files it needs in `~/.coding-hub/runner/kits/` (about 265 MB on Windows), because Trace's installer stops everything running from its install folder before an update.
- **Tried:** unit tests for the runner's protocol, its output buffer, the runner, Trace's connection to it, the copy, PtyManager taking a channel up, and the hook servers' ports; `npm run test:runner` (a real terminal kept while nothing is connected, from a real copy, with the runner leaving when idle); and a new end-to-end test that kills Trace's main process while a channel runs, opens Trace again, and finds the channel back with its screen, answering, and then stopped from Trace. On Windows, the runner test also stops a program whose detached child left its process tree and checks the child ended. The phone smoke test checks the phone's size on use, the computer's size shown at the chosen text size, waking without taking the size, More, the switcher, the dimmed offline screen and the 320 px layout; a unit test checks a phone that falls behind gets a fresh screen, not a backlog. The desktop smoke test passes with the runner off.
- **Not tried:** an installed build being updated while channels run; a Mac (the runner runs from Trace's own Electron there for now); real Claude Code and Codex hooks after a restart.

1.35.3 reads Claude Code's and Codex's screens as a second check of what they are doing, with rules taken from herdr:

- **An approval the CLI did not announce still shows as Needs you.** If Claude Code shows its confirm or select form, or Codex shows "Allow command?" or "Action Required", and the CLI's own signal (Claude's hook, Codex's notice) did not say so within 5 seconds, the tile says Needs you with the question from the screen.
- **A "Needs you" left behind clears itself** once the screen shows the agent working again (its spinner in the title, or "esc to interrupt"). herdr moved to reading the screen after the same signals left panes stuck.
- **Strict on purpose:** only those known forms count as waiting, and a change counts only when read twice in a row, so a passing line of output does not raise anything.
- **Tried:** the unit tests (each rule on sample screens, including look-alike text that must not count; a change counted only when read twice), and the desktop smoke test: a stand-in Claude Code draws its approval form without its hook, the tile shows Needs you with the question, and drawing its working line clears it. The workbench, enterprise, remote, productivity, table seats and design smoke tests pass.
- **Not tried:** real Claude Code and Codex releases beyond the screens in herdr's rules; their wording can change.

1.35.2 replaces the rules for whose size a channel has with herdr's single rule:

- **A channel is drawn at the size of whoever last used it.** Using it means typing in it, clicking into its tile, or, on the phone, opening, touching or typing in it. Showing it does not count, and neither does the computer being idle or Trace being in front. This replaces the idle timers, the "in front" check from 1.34.0 and the phone's quiet time, which together made channels shrink and bounce back while you only read them.
- **On the desktop:** typing in a channel's tile or clicking into it takes the channel back from a phone or another computer.
- **On the phone:** nothing changes in use. Opening a channel, touching it, typing, or **Fit to phone** takes it; leaving it, locking the phone, or **Desktop size** gives it back. A computer merely being used, anywhere, no longer takes it from the phone.
- **On another computer's tab:** its tile's size is used once you type into that tile, not while it is only shown. Before, it was used whenever nobody had touched this computer for two minutes.
- **Tried:** the unit tests (a viewer that only watched takes the size once it types; the desktop takes it back on focus; a linked computer's tile takes it once typed into and steps back when its phone leaves), and the remote smoke test, rewritten for the rule: a restart from the desktop tile is the desktop's, sending from the phone takes it, typing or clicking into the tile takes it back, touching the phone takes it again. The desktop, workbench, screen, phone screen and design smoke tests pass.
- **Not tried:** a real phone and your Mac's tab together.

1.35.1 is the first fix taken from herdr's source code:

- **Your other computer comes back after sleep.** When this computer wakes, each linked computer connects again at once. Before, its tab could show stale channels for up to a minute, or stay disconnected until the next retry.
- **A dead link is noticed in 30 seconds, not 60.** Trace now pings linked computers and phones every 10 seconds instead of 25. 30 seconds still works with a computer on an older Trace.
- **A link that keeps dropping backs off.** Retries wait 2 seconds, doubling to 30, and start again from 2 seconds only after a connection has held for a minute. Before, any connection that worked for a moment put the wait back to 2 seconds, so a flapping link was retried every 2 seconds.
- **Tried:** the unit tests, including a new one where a linked computer, woken, drops its stream and has a new one within 1.5 seconds; the remote and screen smoke tests. The screen smoke test failed once on a pasted-keys check and passed twice after, with no change; it is not caused by this.
- **Not tried:** a real sleep and wake with your Mac linked.

1.35.0 starts Trace plugins (design: docs/plugins.md):

- **Trace plugins**, in Agent setup → Skills & plugins. A plugin is a folder with a trace-plugin.json manifest and its programs, in any language. **Link a folder** adds one after a system dialog shows every command it may run and what it may ask Trace to do. It runs as you and nobody reviews it, so add only ones you trust.
- **What a plugin can do:** add actions to the command menu (for the workspace, the channel you are in, or the repository on Changes); run commands when a channel needs you, ends its turn, fails, starts or stops, a task is ready for review, a worktree is made, or Trace starts; and call Trace back, through the `trace` helper or its local address, to list, read, message, wait for, start, stop and add channels, read and add tasks, and show notices. Each call needs the permission its manifest declares.
- **Turning a plugin off** stops its programs and its access to Trace at once. Each plugin shows its last runs and the end of their output; a failed run raises an alert.
- **Not yet:** plugin tiles (1.35.1), and installing from GitHub, updates and the list to browse (1.35.2).
- **Tried:** the unit tests (manifests read whole or refused with why; programs found only in the plugin's folder or on PATH, never through a batch file; linking only after the confirmation; actions and events run with what happened; a plugin turned off stops running; the API allows only declared permissions, and only its own secret address). The productivity smoke test links a sample plugin through Skills & plugins, runs its actions from the command menu (one lists channels through the API, one through the `trace` helper, one is refused a permission it did not declare), turns it off and on, and hears its channel.started event. The desktop, design, workbench, enterprise, table seats, remote and channel-tools smoke tests pass.

1.34.0 keeps your channels running when you close Trace's window:

- **Closing the window no longer stops your agents.** Trace hides to its icon in the system tray (the menu bar on a Mac), and channels, the phone, linked computers and alerts keep going. Click the icon, open Trace again, or click an alert to bring the window back. The icon's menu shows how many channels are running and has **Quit Trace**, which stops them as before (with Start channels again when Trace opens, they come back on their conversations next time). The first time, a notice says where Trace went. **Settings → Preferences → Keep running when the window is closed** turns it off.
- **Channels no longer shrink for a moment when another computer has this one's tab open.** Each tile on the other computer asks for its channel at the tile's size, and this computer applied it once its mouse and keyboard had been still for two minutes, so reading a long reply was enough; the next mouse move put the size back a second or two later. It now also waits until Trace's window is not in front, and a size applied while it was in the background goes back as soon as Trace is in front again. A phone's own "Fit to phone" works as before.
- **Next:** a background runner that keeps channels running even when Trace quits, crashes or updates, and plugins.
- **Tried:** the unit tests (another computer's size waits while Trace is in front, is drawn once it is not, and goes back when it is again), and the desktop smoke test: closing the window hides it while both channels keep running, and typing works when it is shown again. The remote, screen, design, workbench, productivity and enterprise smoke tests pass.
- **Not tried:** the tray icon and its menu by hand on Windows and a Mac (the smoke tests cannot click it).

1.33.2 closes the items left open by the herdr work:

- **Codex terminals say Done too.** Trace now asks Codex for its end-of-turn notice as well as its approval requests, and tells them apart by the approval requests' fixed wording ("Approval requested: …", "Approval requested by …", "Codex wants to edit …"). Only a reply that itself began with one of those would be taken for an approval. A Codex turn's end also reaches event hooks and the channel tools' wait.
- **Correction:** 1.32.1's notes said Gemini CLI terminals do not say Done. They do: Trace already read agy's own status (working, then idle or done) as the end of a turn.
- **Channel tools:** a message to a Round Table goes to the whole table, as one typed there does (before, its lead alone got it). Codex takes the three tools that only look (list, read, wait) without asking, so a Codex chat can use them; sending a message still asks, so a Codex chat still cannot send.
- **GitHub Actions** now run the Node.js 24 versions of checkout, setup-node, upload-artifact and download-artifact (each pinned to its exact commit). The changes in between were read first; none affects Trace's workflows.
- **Smaller:** the design tour waits for a diff before its Needs you picture, and for no notice at all where two can be drawn; one circular import between two Settings components is gone.
- **Tried:** the unit tests (Codex's approval wordings and other notices; which run leads a table); the real codex-cli 0.171.0 reading Trace's exact channel-tool settings; and the desktop smoke test, where a stand-in Codex ends its turn while you are in another channel and its tile says Done, not Needs you. The design, workbench, enterprise, table seats, remote, productivity and channel-tools smoke tests pass.
- **Not tried:** the design tour's changed waits. Seven of its scenes fail before reaching them, on main too (a tile's Restore grid control is not found after it is isolated), so the tour needs its own repair.

1.33.1 is the last idea from herdr for now, a careful version of its plugins:

- **Event hooks:** Settings → **Event hooks** runs a program of your own when a channel needs you, ends its turn, or fails, such as a script that sends a message to your phone. It is told which channel and why in environment variables (TRACE_CHANNEL, TRACE_CHANNEL_NAME, TRACE_MESSAGE, TRACE_FOLDER, TRACE_EVENT). Trace asks you to confirm the exact command in a system dialog before saving it. It runs without a shell and is stopped after 30 seconds; one hook runs at most once every 10 seconds for a channel. **Test** runs it once.
- **Your verification profiles are actions in the command menu:** *Run verification: name* opens Verification profiles and runs it there, after its usual confirmation.
- **Not done:** add-ons that draw their own panes or tiles, and installing add-ons from GitHub, as herdr's plugins do. Those need more design before Trace runs other people's code.
- **Tried:** the unit tests (a hook is saved only once confirmed and only with a program's full path; it runs with what happened in its environment, once per channel in ten seconds; Test and Delete), and the productivity smoke test: a hook added in Settings runs when the Codex channel asks for an approval, told CH2 and the request, and a profile runs from the command menu. The design, desktop and workbench smoke tests pass.

1.33.0 is the fourth idea from herdr, whose agents can start, prompt and wait for each other:

- **Agents can see and message other channels, if you turn it on.** Settings → Preferences → **Let agents see and message other channels**, off by default. Claude Code and Codex channels started afterwards get four tools: list this computer's channels, read another channel's last replies, send another channel a message, and wait for its turn to end (or an approval, or a stop). So one agent can hand work to another and pick up the result.
- **Limits:** a message is marked as coming from the other channel's agent, not from you. An agent cannot message its own channel, a stopped one, or one waiting for you to answer an approval. The CLI asks your permission for each tool as it does for any MCP tool, unless the channel runs at Full access. Turning the setting off stops the tools at once, even in running channels.
- **Not covered:** Gemini CLI channels (agy takes MCP servers only from its own global settings), and Codex chats, which have no prompt for the permission and so refuse the tools. A message to a Round Table reaches its lead only.
- **Tried:** the unit tests (the tools' rules: the caller's own channel, stopped and waiting channels, marked messages, waiting for a turn end, an approval or a stop, the secret address, turning off); a smoke test of the MCP server as a CLI starts it (Linux CI runs it with the memory server's); and the desktop smoke test, where the Codex channel's agent lists the channels and messages the Claude Code channel through Trace. The enterprise, remote, workbench, profiles and memory smoke tests pass.

1.32.2 is the third idea from herdr, whose most-used add-ons include reviewing an agent's diff and sending comments back:

- **Comment on a line of a diff in Changes and send the comments to the agent.** In Unified view, the button at the start of a line opens a comment on it. Comments stay under their lines while Changes is open. The bar above the diff sends them all as one message to an agent channel running in that repository, typed in as you would: each with its file, line and code. **Send to** picks the channel when there are several.
- **Tasks are sent the same way as before.** Sending a task and sending comments now share one piece of code.
- **Not done:** commenting in Split view (it shows comments; switch to Unified to add one). Comments are not saved when Trace closes.
- **Tried:** the unit tests (the message's wording; which channels are offered: running agents in the repository or a folder inside it, never a shell or another folder), and the desktop smoke test: a comment on a changed line, sent, arrives in the Claude Code channel working in that repository as one message, and is then cleared. The workbench, enterprise, design and table seats smoke tests pass.

1.32.1 is the second idea from herdr:

- **A channel says Done when its agent finishes while you are elsewhere.** The tile's badge and the status bar show **Done** in blue, and **Needs you** lists it last as *CHn finished its turn*, with **Open channel**. Clicking the tile or moving into its terminal clears it. A turn that ends while you are in that channel, with Trace in front, is not marked. Before, a running channel showed Working whether or not its agent was still busy.
- **Where it comes from:** Claude Code terminals (Claude Code's own end-of-turn hook), chat channels, and Round Tables (when the driver's reply ends; at a hierarchy table, the planner's approval already says so). **Not yet** Codex or Gemini CLI terminals: Codex's own end-of-turn notice carries the reply's first words rather than a fixed text, so Trace cannot yet tell it from an approval request.
- **Tried:** the unit tests (Done after a turn, a waiting approval still first; Needs you lists it last and not once the channel asks something or stops), and the desktop smoke test with a stand-in Claude Code that ends its turn the way Claude Code does: the tile and Needs you show Done while another channel has the keyboard, clicking into it clears it, and a turn watched to its end is not marked. The workbench, design, productivity, table seats and remote smoke tests pass.

1.32.0 starts on ideas from herdr, an open-source terminal tool for coding agents:

- **Channels running when Trace closes start again when it opens.** Each agent continues its saved conversation and each shell starts afresh; a Round Table's seats start too, so the table opens again. Before, every channel came back stopped until you pressed Start on each. A notice says how many were started. Channels you had stopped stay stopped, and so does an agent channel with no saved conversation, since starting it would begin a new one. The programs that were running inside the channels do not come back.
- **To turn it off:** Settings → Preferences → **Start channels again when Trace opens**. It is per computer and not synced.
- **Not covered:** reloading the window, and a start after Trace crashed or the computer lost power. Trace notes the channels as it quits, so neither of those starts any.
- **Tried:** the unit tests (the list is given once and then forgotten; a damaged one starts nothing), and the productivity smoke test (a running channel started again on its conversation after a restart, the others left stopped, the notice shown). The desktop smoke test turns the setting off and checks every channel comes back stopped. The enterprise, remote, profiles, models, workbench, table seats and design smoke tests pass.

1.31.7 finishes what was left of the review apart from rewriting the phone app:

- **A verification profile can be deleted.** **Delete** asks first; the profile's recorded results stay, since a task may name one as its evidence.
- **Settings no longer puts back an old Drive folder.** With other settings changed and not yet saved, choosing a Drive folder in Sync between computers (or a sync from another computer) changed the saved settings but not the form, so the next **Save preferences** wrote the old folder back. The form now takes in each change made elsewhere to a field you have not edited, and keeps the ones you have.
- **The phone's Screen has a Display picker**, when a Windows computer has more than one display: all of them side by side (as before, squeezed into a strip on a phone) or one at full size. It is remembered while the phone stays on Screen.
- **Actual size** on the phone's Screen shows the picture at its own size: drag to move around it, and a tap still clicks where it shows. Tap it again to fit the picture to the phone.
- **View only** on the phone's Screen lets you look without a stray tap clicking on the computer.
- **The Windows release candidate now runs the phone and screen smoke tests**: the phone app, Screen between computers, Trace's screen service and a phone's Screen. The last two ran nowhere in CI, and the first two only on Linux.
- **Not done:** pinch-to-zoom on the phone's Screen (Actual size and dragging do this job without throwing taps off); the phone's Usage, Tasks and History following the computer picked above the list; rewriting the phone app in React. These wait until you have tried 1.31.4 and 1.31.6 on a real phone.
- **Tried:** the unit tests (a deleted profile keeps its results; the form keeps edits and takes in other changes; the phone's display passed to the screen service and reported back), and the productivity, phone screen, screen, screen service and remote smoke tests, with new checks for Delete and for Actual size, View only and the Screen controls fitting the phone.
- **Not tried:** a computer with more than one display from a real phone.

1.31.6 is the phone app's second stage. Please try it on your phone with 1.31.4's fixes:

- **Back leaves a channel instead of the app.** Android's Back button and the iPhone's swipe from the edge closed the app from a channel or the screen. They now go back to the channel list, as the app's own Back does; on the list, Back still closes the app.
- **The chat's message box stays above an iPhone's keyboard.** The chat was as tall as the whole screen, which iOS keeps while its keyboard is open, so the box went under it. It now fits the part of the screen the keyboard leaves.
- **Usage, Tasks, History and Memory say which computer they show**, when the phone knows of more than one: the one it is connected to, whichever computer the channel list is showing. Picking another computer above the list does not change them; showing that computer's figures there is a larger change, not in this version.
- **Checked and not changed:** the review said a channel's header and tool bar ran past the edge of a small phone. They do not: at 320 px wide nothing runs over and the channel's name keeps its room. The remote smoke test now checks this.
- **Tried:** the remote smoke test (Back from a channel returns to the list; the channel screen at 320 px), the phone screen smoke test and the unit tests.
- **Not tried:** a real iPhone or Android phone (the keyboard above all), and a phone that knows of more than one computer.

1.31.5 finishes the review's Phase 2, apart from the Changes screen (1.31.3). Each item was checked in the code first:

- **AI coaching and Verification profiles are in the Insight menu.** The More tools page held only these two, one step further away. G then L, which opened it, is gone; G then O and G then V open them.
- **The command menu opens Tasks, AI coaching, Verification profiles and each linked computer**, which it did not list.
- **The "?" beside a heading can be pressed.** Its words open as a note under it, from the keyboard or a tap too, and Escape closes it. They were a tooltip only, out of reach of the keyboard, touch and screen readers.
- **Settings says when it holds changes not saved yet**, beside Save preferences, with **Discard** to put them back.
- **A verification profile can be edited.** **Edit** loads it into the editor, which then saves over it. Before, it could only be copied into a new one.
- **A saved prompt experiment shows its two prompts.**
- **Tasks:** the project folder can be cleared and typed again. Emptied, it put the channel's folder straight back.
- **Usage:** the "unpriced" count beside the estimated cost now counts the same records the cost is added up from; it counted Trace's own runs instead.
- **Tailwind:** its utility classes are left out. No component used them, and they brought in stray classes picked up from the code (.table, .fixed, .block, .blur and others). Its reset, which every screen is drawn on, stays.
- **Checked and not changed:** the review said a terminal with the keyboard swallows Ctrl+Shift+P. It does not in this version (tried in the workbench smoke test, which now keeps checking it).
- **Not done:** deleting a verification profile (Trace's host has no way to yet), and the review's larger Settings and Accounts reorganisation.
- **Tried:** the unit tests, and the design, productivity, workbench, desktop and remote smoke tests, with new checks for the Insight menu, a "?" opened and closed from the keyboard, Settings' unsaved changes and Discard, editing a verification profile, and Ctrl+Shift+P from a terminal.

1.31.4 is the first stage of the phone app's fixes. Each was checked in the code first; please try them on your phone:

- **A channel's buttons follow it.** On a terminal channel, Start, Stop and Restart stayed as they were first drawn, so a channel stopped or started from the computer still showed the old buttons. They now change with the channel.
- **Ask AI shows on this computer's own channels.** Live coaching offered Ask AI only for a channel with no computer name, and Trace names its own channels too, so the button never showed.
- **What the phone may do is known after a reconnect.** Opened while the computer could not be reached, the phone did not offer Start, Stop or + Channel until you left the list and came back. It now asks once it connects.
- **No zooming into the Round Table's menus on an iPhone.** Their 12 px text made iOS zoom the page when tapped. They are 16 px on the phone.
- **Dark menus and scroll bars** (the page now says it is dark), **a visible track on the usage meters**, and **an image's Close button clear of the notch**.
- **Tried:** the unit tests, and the remote smoke test in a phone-sized window, with a new check that stopping and starting a terminal channel from the phone changes its buttons (it fails with 1.31.3's code). The phone screen smoke test.
- **Not tried:** a real iPhone or Android phone, Ask AI on a real channel, and opening the app while the computer is off.
- **Next stages** (planned, not in this version): the iPhone keyboard covering the chat box, the channel header crowding on narrow phones, the Back gesture, and which computer the Usage, Tasks and History tabs show.

1.31.3 rebuilds Changes in the three columns you chose:

- **One file list, which also stages.** Each file has **+** (stage) or **−** (unstage) at its end, and each group has **Stage all** or **Unstage all**. **Filter files** narrows the list. Before, a second list of check boxes in the Delivery card did the staging, apart from the list beside the diff, and picking a staged and an unstaged file at once disabled both buttons.
- **Ship** (the Delivery card) now holds only **Commit**, **Push** and **Pull request**, each ticked once done. Steps 2 to 4 used to stay unticked whatever happened. Push says how many commits are left to push and is ticked once there are none. The commit message and the pull request's title and description clear once used.
- **The diff** can be shown **Split**, old and new side by side, and **Wrap** wraps long lines.
- **Tried:** the unit tests, and the productivity smoke test, which stages and unstages a file from the list, opens Split and checks that Push is ticked after a push. The desktop smoke test and screenshots at 1440 and 1100 px wide.
- **Not tried:** a real repository with an upstream, a branch behind its remote, and a pull request (the smoke test makes one only on macOS and Linux).

1.31.2 makes the chat and the Round Table easier to follow (the review's Phase 1):

- **Stop stays while you write the next message.** While an agent works, the Stop button used to give way to Send as soon as you typed. Both are now there. A message of images only can be sent too.
- **Latest:** scrolled up to read, one press goes back to the newest message, and new replies follow again.
- **Code blocks** in a reply show their language and a **Copy** button above them. Headings come in four sizes instead of one.
- **A hierarchy table can show a seat's own conversation**, as a discussion table could, with **Show** on its bar.
- **A folded hierarchy bar also counts the findings still open**, beside 1.31.1's challenge count.
- **The Round Table setup panel asks before replacing seats you changed** when you pick another table or kind. Before, the names, models and instructions you had typed were lost without a word. **Escape** on one of its questions now closes only that question, not the whole panel.
- **Not changed:** a second Approve plan button above the message box. Approve plan stays on the bar, also when it is folded, with the challenge count beside it, and the message box already says to write what to change.
- **Tried:** the unit tests, and the remote, table, design and desktop smoke tests, with new checks for Stop beside Send, code-block Copy, Show at a hierarchy table, the setup panel's question and Escape.
- **Not tried:** a real Claude Code or Codex chat, and the phone.

1.31.1 fixes nine more problems found in the review of the interface. Each was checked in the code first:

- **A channel that failed on another computer shows as Failed** on its tab, with why. It read as Idle.
- **Trace's shortcuts step aside in another computer's screen.** F1, Ctrl+Shift+F and Alt+1–8 were taken by Trace while you typed into the screen, and opening another page closed it. They now go to that computer, as do Ctrl+Shift+P and the G letters.
- **Pasting into the screen of a computer of the same kind.** Between two Windows PCs or two Macs, the paste key pasted what was on the other computer's own clipboard. It now hands this computer's text over first, as it already did between Windows and a Mac.
- **A folded hierarchy bar says how many challenges the plan has**, beside Approve plan. The tasks queued from Tasks also stay in view when it is folded; before, both were hidden until you opened it.
- **Higher contrast keeps a focused field's blue border, a field's error red, and an error's colour.** A rule meant to strengthen borders outweighed all three.
- **Compact density no longer adds padding** to the Changes and Files cards and the explorer, which are drawn edge to edge.
- **Accounts no longer says to install a CLI while it is still checking** whether it is installed.
- **Help no longer draws a Round Table's finding numbers (F1, F2) as keys.** F1 the key still is one.
- **A file opened from the command menu shows in the Files tree**, its folders opened to it.
- **Tried:** the unit tests, and the desktop, design, screen, remote, workbench, table and productivity smoke tests, with new checks: F1 in a remote screen (fails with 1.31.0's code), the contrast and density rules (fail with 1.31.0's stylesheet), the Files tree, the challenge count and the pasting rule for each pair of computers.
- **Not tried:** a real Mac viewing a Mac, a real Windows PC viewing another, and a real linked computer's failed channel.

1.31.0 retires the Workflow center. Its four tools now sit where you would look for them:

- **Failed runs** is part of **Session history** (a **Failed runs** button beside **View native CLI conversations**). **Open log** on a failed channel, or its notice, goes there, with that channel chosen. The command menu's **Recover a failed channel** does too.
- **Search** is a page of its own, in the **Insight** menu. **Ctrl+Shift+F** (Cmd+Shift+F on a Mac) and the command menu's **Search local workspace** open it. The command menu still finds files and memory notes as you type.
- **Project templates** is part of **Projects**, below opening, creating and cloning a project.
- **Export a support report** and **Release integrity** are part of **Settings → This app**.
- **Agent setup** no longer lists **Workflow center**. Nothing about the tools changed except where they are.
- **Tried:** the unit tests, and the productivity smoke test, which now reaches each tool in its new place (Open log, Ctrl+Shift+F, Projects, Settings); the desktop, design and workbench smoke tests; screenshots of the four places.

1.30.3 fixes six more problems found in the review of the interface, and one that 1.30.2 missed:

- **Codex's and Gemini CLI's commands are shown whole on their approval cards.** 1.30.2 said every command's card showed the whole command, but Codex and Gemini CLI name their commands Shell, which it did not cover: their cards cut the command at 120 characters. Codex's file-change approvals now also list the files with their folders.
- **A renamed Codex seat gets Codex's approval buttons.** At a Round Table the card chose its buttons by the seat's name, so a Codex seat named "Reviewer" was offered Claude's **Allow edits this run**. It now goes by the seat's agent.
- **Refresh changes refreshes the Delivery card.** In a Git repository, **Refresh changes** updated the file list and the diff but not the Delivery card, which kept the files it had read before; a step taken on it then failed as out of date. It now reads the card again, and clears an error that stayed on it after a check that worked.
- **The budget fields can be typed into.** **Warn at this share** turned the first digit of 75 into 50, and **Daily cost budget** turned the 0 of 0.5 into 0.01. Both are now kept to their ranges when you leave the field or save.
- **Enter sends on another computer's tab.** The chat there had no Enter-to-send and its box did not grow; both now work as on this computer. On a phone Enter stays a new line, as the Send button is beside it.
- **The folded hierarchy bar no longer measures the window on every keystroke.** It measured the layout each time anything in the channel was drawn, typing included. It now does so when the tile or the conversation is resized or the bar's content changes.
- **Releases:** the step that publishes a release after the Windows release candidate now waits up to two minutes for GitHub to list the candidate as passed. 1.30.2's release stopped because it asked 18 seconds after the candidate passed, before GitHub listed it, and had to be started by hand.
- **Searching CLI conversation history finds the agent's name** ("codex" finds Codex's conversations).
- **Tried:** the unit tests, and the desktop, remote, workbench, design and table smoke tests. The desktop smoke now checks the Delivery card after **Refresh changes**; it fails with 1.30.2's code. The table smoke now checks the hierarchy bar folds in a short window, stays folded while typing and unfolds with room.
- **Not tried:** real Codex and Gemini CLI approvals, a real linked computer's tab, and a phone.

1.30.2 makes four fixes found in a review of the interface:

- **One alert in the status bar.** **Needs you** and a second chip naming the first waiting channel both showed, with different lists: the chip also had other computers' channels, **Needs you** also had tasks. The chip is gone and **Needs you** lists everything, other computers' channels that wait or failed included (**Answer** opens that computer's tab). Hover the chip to see what it holds.
- **An approval shows what an edit changes.** Claude's card for **Edit**, **MultiEdit** or **Write** showed only the file's name. It now shows the text removed and added, or the new file's content, scrolled within the card when long. This is in the chat channels on the computer, the phone and a linked computer. Codex's file-change approvals still name only the files, as Codex sends no more. A command's tool card, opened, now shows the whole command; before, it showed only a line cut short.
- **Full access asks first.** Choosing **Full access** beside a chat's message box changed a running agent, and every seat at its Round Table, at once. It now asks once more and says what it allows; **Cancel** keeps the level in effect. Channel settings, where the level applies when the channel starts, are unchanged.
- **A message being written is no longer lost.** Text and images typed in a chat were dropped when its tile was maximised or restored, or another page was opened, because the chat was drawn anew. They are now kept for each channel until it is sent or the channel is removed. They are not kept when Trace closes.
- **Tried:** the unit tests, and the remote, workbench, design and desktop smoke tests, which now check each of the four in the built app with stand-in agents.
- **Not tried:** a real Claude Code edit approval, the phone on a real phone, and a real linked computer's alert in **Needs you**.

1.30.1 fixes a chat that kept saying an agent was working after it had finished:

- **"Claude Code is working" no longer stays on after Claude Code has finished.** A chat or a Round Table could show the three dots and "Claude Code is working" with nothing running, while the Round Table's bar said **Your turn**.
  - **Cause:** when a command Claude Code had left running in the background finished, Claude Code wrote a reply by itself to report on it. Trace showed that reply as being written, and then never heard that it had ended: the end of such a reply was set aside whole, so that a Round Table, a task or an automatic handoff would not take it for the end of a turn.
  - **Fix:** the conversation is now told when such a reply has ended, and closes it. Nothing else acts on it: a Round Table does not move on, no task is marked and no handoff is asked for. If a message of yours is waiting behind such a reply, the chat stays busy until your own reply has ended.
  - While an agent writes a reply nobody asked it for, a Round Table's bar now says who is working, not **Your turn**. You can still send a message; it waits as any message sent to a busy table does.
- **If you see it in 1.30.0:** it is only the line that is stuck. You can type and send as usual, and the line clears when the next reply ends.
- **Tried:** the unit tests, which replay the messages Claude Code sends in this order (a reply after a background command, a reply while one of yours is still owed, a late report from a subagent, an error and Stop), the build, and the desktop tests with stand-in CLIs for Round Table seats, the desktop and the phone.
- **Not tried:** a real Claude Code chat running a background command and reporting back. The cause was read from the code and from when it was seen, not reproduced. Also not tried: a phone or a linked computer on an older version (which leaves a message it does not know alone), a Mac and the installed version.

1.30.0 refines the look of the channels and the status bar, and counts each Gemini CLI channel by itself:

- **Channels look like windows of the app, not bare terminals.** A channel is a card. Its header, notices and footer are on the card, and the terminal or the conversation is a dark panel set into it. A channel that has not started, and a chat, no longer sit on terminal black. Errors and approval requests are rounded banners above the terminal.
- **A channel's controls have their own place.** Press **⋯** in a channel's header to open a row with Stop, Settings, Maximize and the rest, and press it again to close it. The row used to appear over the terminal's first lines whenever you pointed at the header, and covered output. Its facts are in plain words ("Running · Folder …"); hover over them for the process ID and the folder's whole path.
- **A footer you can read.** Each channel's footer shows its context and its tokens today as labelled values, with a meter where the CLI reports a window, and a small trace of terminal output at the right. A chat has no output trace.
- **A status bar of chips.** What you can press is drawn as a chip: each channel, today's total, each plan's limits, Needs you and alerts. A channel that needs you, failed or is near its limit tints its chip.
  - **Today** now opens Usage, as the plan limits do.
  - **Plan limits** have a small meter and their engine's mark. A named Claude account that one of your channels runs on is added once it is near its cap, and dimmed numbers with a warning mark tell you the last check failed.
  - "Host · local" and "No alerts" are gone, and the saved state is one word, **Saved**, with the sentence in its tooltip.
  - In a narrow window with eight channels, Needs you, an alert and a storage failure stay in view.
- **Gemini CLI is counted per channel.** A Round Table's bar read "Gemini CLI 0" however much the seat had worked. Trace read Gemini CLI's usage only into the day's total.
  - Each Gemini CLI channel and seat is now counted from the conversation it writes to: its tokens today show in the Round Table's bar, in the status bar and in its tile's footer, and its runs are listed on Usage with their cost.
  - Until a seat's first request has been recorded the bar shows **—**; 0 means a counted zero. The count moves in steps: Gemini CLI records a request when it ends, and Trace looks every two seconds.
  - Two Gemini CLI terminals started in the same folder are not told apart while they run, so each shows no count until it quits. Round Table seats are always told apart.
  - These records stay on this computer: another computer's Usage does not list them. Today's total is unchanged and counts each request once.
- **Smaller fixes:** Gemini CLI's messages at a Round Table have their colour and indent, and its share shows in Usage's "By engine" bar. Meter tracks are visible on cards. Long limit names on Usage no longer run into each other. A Round Table's bar keeps to two lines in a small window while the driver makes the changes.
- **Tried:** the unit tests, the build, and the desktop tests with stand-in CLIs (design, workbench, desktop, Round Table seats, paste, productivity, profiles, models and stability, remote), and every screen at 1440 × 900 and 1100 × 800, also with Higher contrast. For Gemini CLI, a copy of a real seat's conversation was counted: 34 requests and 525,509 new tokens, where 1.29.1 showed 0.
- **Not tried:** a real Gemini CLI seat in this version (the count rising as it works), a Gemini CLI terminal channel, a linked computer's tab, the phone app, a Mac and the installed version. Not seen on screen: Today's budget colours, a named account near its cap, and a failed limits check.

1.29.1 fixes Full access for a Gemini CLI seat at a Round Table:

- **Full access now reaches a Gemini CLI seat.** At a table set to Full access, a Gemini CLI seat still asked before every command.
  - **Cause:** the seat was created without the table's permission level, and a change of level on an open table passed it over. Both were mistakes in 1.28.0, which added the seat.
  - **Fix:** it takes the table's level like every other seat, when the table starts and when the level changes. At Full access Trace allows its commands at once. It still cannot change files: it reviews or plans.
- **Tried with the real Gemini CLI and Claude Code:** on a table set to Full access, the Gemini CLI seat ran a command and reported what it printed, with no approval card. The same run used 1.29.0's new discussion order with a Gemini CLI seat.
- **For a table that is already open:** set the permissions once more (to another level and back), or close and start the table again, so the seat takes the level.

1.29.0 changes how a discussion Round Table works, so the seats talk first and the driver acts on what was said:

- **Discuss first, then the driver makes the changes.** Your message goes to every seat to discuss: each says how it would handle it, and nobody changes files yet. Each then sees the others' answers and replies, for the number of rounds you set or until they all agree. Then the driver alone gets a turn to make the changes, with the whole discussion in view. The bar shows this as **making the changes**.
  - **What was wrong:** the driver was told to start work on your message at once, beside the other seats and before it had heard them. Nothing told it to act on the discussion afterwards, and it never saw the others' last replies.
  - While they discuss, every seat is read-only, the driver included; Trace declines an edit asked for then.
  - Stop, a failed turn, or a new message from you ends the discussion without the driver's turn.
  - With **Rounds** at 0 there is no discussion: the driver starts at once, as before.
- **A hierarchy table is unchanged.** It already works in order: plan, challenge, build, review, final review.
- **Tried with the real Claude Code and Codex:** a table of three discussed for two rounds with no file touched, then the driver wrote the file with a line from every seat. The check is `scripts/real-discussion-check.cjs`.
- **Not tried:** a Gemini CLI seat at the new flow, a table that agrees early with real agents, a Mac, a real phone and the installed version.

1.28.1 fixes viewing a Windows screen with **Also control apps running as administrator** on:

- **The screen can be viewed again with the administrator option on.** With it on, every viewer was refused with "could not capture its screen: Could not start video source", from a linked computer and from the phone.
  - **Cause:** the option ran the whole screen service as administrator, and Windows refuses a program like Trace its screen capture when it runs as administrator (Windows 11 24H2 and later).
  - **Fix:** the service now always captures with your own rights, and only a small part that presses the keys and moves the mouse runs as administrator. It uses the scheduled task you already approved, so updating asks no permission.
  - If that part is not running, the screen is still shared and everything but apps running as administrator is still controlled; Trace says so under **Share this screen**.
- **Checked on Windows 11:** with the option on, the service captured both displays and a key pressed by a viewer arrived through the new part. That run was without administrator rights (Windows' permission prompt was declined during testing), so pressing keys into an app that runs as administrator is not yet confirmed in this version. Please try it after updating: open **Screen** from the phone or another computer and type into an app running as administrator.
- After updating, open Trace once on the Windows computer: it replaces the old administrator service and starts both parts.

1.28.0 brings Gemini CLI to the Round Table and counts its usage (update every computer; the phone app reloads itself):

- **Gemini CLI seats at both Round Tables.** In the setup panel a seat's agent can now be **Gemini CLI**, with its model chosen by name from what Gemini CLI lists for your account.
  - A Gemini CLI seat reviews or plans. At a discussion table it reviews beside the seat that edits. At a hierarchy it can plan, challenge the plan, review and give the final review.
  - It cannot lead a table, be the seat that edits, or build. The panel does not offer those, and Trace declines any file change it asks for. A command it wants to run shows as an approval.
  - It is text only (no images), and has no shared memory or tasks.
- **Gemini CLI usage is counted.** Trace reads Gemini CLI's tokens from its own conversation files, for terminal channels and Round Table seats alike. They are in today's total, on the Usage screen (with a Gemini filter and its own colour in the chart) and on the phone, by the day they were used, back to the last 60 days.
  - A Gemini channel's tile still shows no count of its own.
  - Gemini CLI does not document those files. Trace's reading was checked against the numbers Gemini CLI itself reports; if a later Gemini CLI changes the files, the count can read low until Trace is updated.
- **Gemini prices are built in**, from Google's published prices, like Claude's and GPT's. On a subscription Gemini CLI is not billed by the token, so the cost shown is what the same use would cost through the API. Gemini 4 Argon's price doubles on December 1, 2026, as Google announced, and Trace follows that date.
- **Tried with the real Gemini CLI (1.5.14) and Claude Code:** a discussion table with Claude Code leading and Gemini CLI reviewing, and a hierarchy with Gemini CLI challenging the plan and reviewing the work, through to the planner's approval.
- **Not tried:** a Gemini CLI seat that plans or gives the final review, a table with Codex and Gemini together, a Mac, a real phone and the installed version.
- **The release steps** now wait for the Windows check in one job and then publish (1.27.0's second step had to be started by hand). This release is its first full run.

1.27.0 fixes the phone app's settings and Screen, usage that did not pass between computers, and model choices that had to be typed (update every computer and reload the phone app):

- **Channel settings on the phone.** A channel's header on the phone has a settings button (on a phone with **Can start and stop agents** on, for that computer's own channels). It changes the channel's name, its permissions (Ask, Allow edits, Full access), its model and, for Codex, its reasoning effort. Models are chosen by name. Permissions reach a running chat at once; the model is saved while the channel is stopped, as on the computer. The Claude account, folder and budgets are still changed on the computer.
- **Screen on the phone works again on Windows.** With **Also control apps running as administrator** on, the screen service kept running the old version after every update. It still answered, but could not capture the screen, so the phone (and other computers) only saw "The screen connection closed". Trace now replaces a service left from another version when it starts, and the service makes way by itself after an update.
- **The phone says why the screen cannot be opened**, instead of only that the connection closed.
- **Known problem, not fixed:** on the Windows computer this was found on, the screen service cannot capture the screen while **Also control apps running as administrator** is on ("Could not start video source"), also on the current version. With that setting off it captures. Turn it off under **Settings → Other computers → Share this screen** to use Screen until this is understood.
- **A phone left open no longer keeps a tile squeezed.** A phone showing a channel kept it at the phone's size until you typed in that very channel at the computer. Now the computer's size comes back as soon as you use the computer (keyboard or mouse, anywhere) once the phone has gone untouched for ten seconds. A phone you are typing or tapping on keeps its size, and touching the channel on the phone takes it again. Locking the phone gives the size back more reliably too.
- **Usage between computers: Trace says when computers sync through different Drive folders.** Two computers set to different folders of the same Drive (`My Drive` on one, `My Drive/Coding Hub` on another) each synced into a folder of their own, so usage, settings, rules and memory notes never passed between them, and nothing said so. **Settings → Sync between computers** now names the computers that sync elsewhere and has **Use the same folder** on the computer that should move.
- **Context after compacting.** After `/compact` (or Claude Code compacting by itself) a channel kept showing the old, full context until the agent next answered, so it read as near its limit and offered **Write handoff** right after you had compacted. Trace now reads the compaction from Claude Code's log and shows what was kept at once.
- **A handoff near the context limit, by itself.** When a Claude Code or Codex channel reaches 80% of its context window, Trace asks the agent to save a handoff with `write_handoff` as soon as its turn ends, once (and again only if the context fills up again after compacting). Before, the tile only offered **Write handoff**, for you to write one. It follows **automatic memory** in Settings, is not sent while the channel waits for an approval, and not to a Round Table, a terminal or Gemini CLI. The message shows in the channel like one you typed.
- **Less to do by hand.**
  - After the handoff is saved at 80% of the context, a terminal channel is compacted by Trace when that turn ends (chat channels are not).
  - Trace checks that **Share this screen** can really capture the screen when it starts, and tells you if it cannot, instead of you finding out from the phone.
  - A computer that syncs through a different Drive folder than your others moves to theirs by itself, tells you, and has **Move back** under Settings → Sync between computers.
  - The phone app reloads itself after its computer was updated, once nothing is open in it. From this version on, "reload the phone app" is no longer needed.
  - After one computer updates, it asks your other linked computers to update too. One with anything running is asked again later. This starts with the update after 1.27.0.
  - Round Table findings that could not be saved to memory are tried again every few minutes (they were already saved when a table closes).
  - Prices and Claude Code's model names are refreshed from the downloads page once a day, so a price change or a new model does not wait for a release.
- **Prices are built in.** Trace prices Claude and GPT models itself from Anthropic's and OpenAI's published prices, so cost estimates work without entering anything. A rate you entered yourself still comes first. Claude's cache writes are priced at the one-hour rate, which is what Claude Code uses. Estimates use the standard price for every request (very long prompts that a provider charges more for are not told apart).
- **Models are chosen by name.** A Claude Code channel's model is a list (Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5, or Claude Code's default), and a Codex channel's is the list Codex gives for your account. **Another model…** still takes an exact ID.
- **Round Table setup: a seat's model list works.** A seat's model was a typed field whose suggestions showed nothing once it held a model, and it kept the other agent's model when you changed the seat from Claude Code to Codex or back. It is now a list of that agent's models by name; changing the agent starts from its default.
- **Gemini CLI:** its channels are in the phone's channel settings (permissions and the models Gemini CLI lists). Trace still cannot read Gemini CLI's token usage, so it has no counts or costs, and it still has no seat at a Round Table: both need work that is not in this version.
- **Tried:** the phone app in a test window on Windows, against the real screen service (picture, keys, taps) and the real size hand-back and settings; the unit tests. **Not tried:** a real phone, a Mac, and the installed version.

1.26.0 lets you choose who sits at a Round Table (update every computer and reload the phone app):

- **A setup panel for every Round Table.** **+ Channel → Round Table** and **Round Table (hierarchy)**, and the people button in a chat, now open a panel instead of starting at once. Press **Start Round Table** to get the table as it was before, or change it first.
- **Seats you choose.** Add and remove seats, and give each one its agent (Claude Code or Codex), its model, a name, and instructions of your own that Trace passes to that agent. Two Claude Code seats on different models, or three reviewers, are fine. Every seat is a running agent, so a table still counts toward the eight agents and terminals Trace runs at once.
- **Discussion table.** Two or more agents in any mix. One seat edits files and the others review, read-only; you choose which in the panel and can change it on the table's bar. Your message goes to every seat, and each then sees what the others answered.
- **Hierarchy table.** You decide who plans, who challenges the plan, who builds, who reviews and who gives the final review.
  - There is always one planner and one builder. The builder is the channel that shows the table; it is the only seat that edits files, and it only builds.
  - Add as many challengers and reviewers as you like. They take their step one after another, and a later one is shown what the earlier ones raised.
  - The challenger, the reviewer and the final reviewer can be left out. Without a final reviewer, a task is done when the review rounds end.
  - **Review rounds** (1 to 5) is on the table's bar. It was fixed at 2.
  - Any seat can be Claude Code or Codex: a Codex builder with a Claude Code reviewer works.
- **Your own tables.** **Save as preset** in the panel keeps a table under a name, to start again later. Trace's own two tables stay as they were. Presets are kept on this computer and are not synced to your others.
- **Seats on an open table.** **Seats** on the table's bar opens the same panel: rename seats, change their instructions and models, add or remove agents. Trace refuses while the agents are working, and at a hierarchy table seats are added, removed or given other steps only between tasks. A new model restarts that one agent, and its conversation is resumed.
- **Names, not agents, in the thread.** Messages are labelled with the seat's name. On Trace's own tables that reads "Claude Code" and "Codex" at a discussion table, and "Planner", "Builder" and "Reviewer" at a hierarchy (the model is on the table's bar).
- **Tables from before** open and work as they did. A chat can sit at only one Round Table at a time.
- **Phone and other computers** show any table and let you use it (messages, approvals from any seat). The phone still starts only the table of Claude Code with Codex, and seats are changed on the computer the table runs on.
- **Project templates** keep a table's seats with their names, instructions and steps.
- **The models field at a hierarchy table** moved into **Seats**.
- **Links in terminal channels open.** Hold Ctrl (Cmd on a Mac) and click a web address in a terminal channel's output, and it opens in your browser. Before, clicking a link there did nothing. A plain click still only selects or focuses, as before. Links in chat channels already opened.
- **Haiku for a read-only Claude Code seat:** type the full name, `claude-haiku-5-5`. Claude Code itself runs the short name `haiku` on Sonnet while a seat is read-only (its plan mode), so a reviewer or planner set to `haiku` works on Sonnet.
- **Tried with the real Claude Code and Codex:** a discussion of three with a named seat and its instructions, a model changed on the open table (the agent restarted and still knew the conversation), and a hierarchy with a Codex planner and final reviewer, a Claude Code builder and two reviewers in turn.
- **Not tried yet:** anything on a Mac, a real phone or another computer, and a table of eight seats.

1.25.1 stops the console window that flashed on Windows, and fixes what an audit of 1.25.0 found (update every computer and reload the phone app):

- **No console window from the usage check.** Since 1.25.0, with Gemini CLI installed, a console window flashed on Windows about every 20 minutes, over a full-screen game too. Trace's check of Gemini's plan limits made Gemini CLI start its own updater, and that updater opened the window. Trace's background questions to Gemini CLI no longer start its updater. Gemini CLI still updates itself when you use it in a channel, so starting a Gemini channel can still show the window once; that part is Gemini CLI's own.
- **No console window from a check's npm step.** A project check or a verification step that runs npm, pnpm or yarn kept a console window open on Windows for as long as it ran. It now runs with your installed Node.js.
- **A chat set back to Ask asks again.** A Claude chat channel started at **Ask**, raised to **Full access** and set back to **Ask** went on working without asking, while the window showed Ask.
- **A crafted repository cannot run its own program when Trace only reads it.** Trace switches off a repository's own Git filter programs before it reads the repository. A repository with a very long Git configuration (or a Git too slow to answer) slipped past that. Trace now refuses to run Git on it and says so.
- **Round Table.**
  - What a subagent wrote is no longer shown as the agent's own words or passed to the next seat.
  - A seat that started a subagent in the background is finished only when the subagent is, so its unfinished work no longer goes to the reviewer. **Stop** ends it at once.
  - A message or task sent while a seat's earlier turn was still ending now starts.
  - **Stop** while the lead writes its summary for a joining partner no longer starts the partner.
  - A long answer passed to the next seat keeps its end (the closing report), not its beginning.
  - At a hierarchy table, your own message starting with "[" shows in the thread.
- **Phone and other computers.**
  - **Remove** on a linked computer ends the screen session it has open on this Windows computer, within a few seconds.
  - A phone removed while one of your other computers was off loses its key there as soon as that computer is back.
  - A phone that reconnected keeps the channel at its size when its old connection is finally dropped, and a channel on another computer opens at the phone's size as a local one does.
  - On the phone, leaving **Screen** through an alert ends the screen session, and **Conversation** is no longer offered for Gemini channels, which have none.
  - A link code refused as "a different computer" no longer leaves an unused key on the other computer.
- **Plan limits** are read every five minutes as intended (it was every ten), each Claude account's check is three seconds quicker, and one account that cannot be checked no longer hides the others.
- **Checks.** A verification run or project check whose tool leaves a process running now ends; before, it stayed "running" and blocked updates and backups until Trace restarted.
- **Smaller fixes.**
  - A file dropped on a Windows Terminal channel is quoted so PowerShell takes its name as written.
  - A channel no longer stays **Failed** with no reason after you choose its folder.
  - On a Mac the hints for a channel's key say Cmd, and a Mac being updated from another computer starts no verification run or backup meanwhile.
  - A Gemini channel stopped before it wrote anything can no longer resume another Gemini conversation.
  - A damaged sync file is rewritten or named, where sync used to fail on it every time.
  - **Ask AI** through Codex no longer starts your Codex MCP servers.
- **Not tried yet:** anything on a Mac, a real phone or another computer, and the installed app (the console window was checked by running Gemini CLI as Trace does). The full list is in `docs/audit-2026-11-21.md`.

1.25.0 adds Gemini CLI as a third engine, and makes the middle Start button and tables in terminals work properly (update every computer and reload the phone app):

- **Gemini CLI channels.** **+ Channel → Gemini CLI**, on this computer, on another computer's tab and on the phone, runs Google's Gemini CLI (`agy`) in a terminal. Install it and sign in to it first; **Local engines** shows its version and whether it is signed in. Choose its model in the channel's settings, from the models your account can use (each name includes its effort, Low to XHigh), or leave it on Gemini CLI's default.
- **Its permissions mean the same as for the other agents.** **Ask** starts Gemini CLI in its Default mode for that channel, so it asks before edits and commands even when Gemini CLI itself is set to Auto (which asks nothing). **Allow edits** lets it edit files in the project without asking; **Full access** never asks.
- **Needs you, resume and history.** When Gemini CLI asks something (trust this folder, approve a command), its tile turns to **Needs you** with the question. When it ends, Trace keeps its conversation, so the next start continues it, and **Session history** lists your Gemini conversations to resume, here and on the phone. Its plan limits (the session and the week, and its other model groups on **Usage**) show in the status bar.
- **What a Gemini channel does not have:** chat, shared memory, tasks, a Round Table seat, image paste, and token usage per channel (Gemini CLI keeps no log Trace can read). Trace does not change Gemini CLI's own settings. A workspace saved by 1.19 with Gemini channels opens with them again; 1.20's hidden Gemini seat at a hierarchy table is still left out.
- **The middle Start button works with WebGL drawing on.** With **Enable terminal WebGL acceleration** on (**Settings → Preferences → Terminal**), the **Start** button and the folder button in the middle of a channel that had not started did nothing: the terminal's WebGL layer lay over them and took their clicks. The terminal's layers now stay inside the terminal.
- **Tables in terminals come out cleaner.** A table with ✅ or ❌ in its rows (Claude Code draws them often) left stray letters behind when it was redrawn: the terminal counted those characters one column wide, the CLI two. Terminals on the computer, the phone and other computers now count them as the CLIs do. Still off by one column: an emoji followed by an invisible style mark, such as ⚠️ or ✔️, so a row with one of those can still leave a stray letter.
- **Not tried yet:** Gemini CLI on a Mac, a Gemini channel from a real phone or another computer, an agy older than 1.5.12, and Gemini CLI signed out (what it reports then has not been seen, so Local engines says the sign-in is unknown). Checked on Windows with the unit tests, the desktop, design and phone smoke tests, and a real Gemini CLI channel in the built app (Ask asked, its questions turned the tile to Needs you, the conversation was kept and the next start continued it).

1.24.0 gives Trace a new look, calls every tile a channel, and changes how notices, the grid, the phone's terminal and a failed channel behave (update every computer and reload the phone app):

- **A new look ("Midnight").** Every screen and the phone app are redrawn: navy surfaces, cards and tiles with a visible edge, one form for buttons, badges, banners and empty states, and state shown as a dot and a word (Working, Idle, Needs you, Failed). Text is set in Inter, Plus Jakarta Sans and IBM Plex Mono. **Higher contrast** under **Settings → Display and keyboard** still strengthens every edge. The app icon is redrawn to match.
- **Pages regrouped, with less to read.** Settings has six sections and a row at the top to jump between them, and **Save preferences** stays in view while its fields are on screen. Long instructions are behind a closed **How this works**; sentences that say what is deleted, sent or shared stay visible. Every folder picker is **Choose folder**, and every way back to the workspace is **Back to channels**.
- **A tile is a "channel" everywhere,** in the window, on the phone and in messages from Trace: "Start channel", "Stop the channels using this Claude profile". "Session" is kept for the **Session history** page and its records, the CLI sessions counted on **Usage**, and a CLI's own session ("Allow for this session", session token limit). Messages say "folder" where they said "directory".
- **A notice appears only for a channel you cannot see.** A channel that needs you or has failed used to raise a notice even when its tile was in front of you, often on top of that tile. Now the notice appears only while the tile is off screen: on another page, on another computer's tab, behind a maximised channel, or scrolled out of view. On screen the tile says it itself, and the status bar and **Needs you** always do. **Answer**, and Alt+1 to Alt+8, now scroll the grid to the channel.
- **A notice never covers what you are typing.** Notices keep clear of a chat's message box and of the tile the keyboard is in; where there is no room they step aside until there is.
- **The grid has no empty quarter.** In the grid arrangement, a last row with fewer channels shares the full width: with three channels the third runs across the window. A workspace saved by an older version is widened once the first time it opens, if its tiles still stand as Trace arranged them. A layout you moved or resized is kept.
- **On the phone, a terminal channel opens readable.** It is drawn at the phone's size and your chosen text size at once, without **Fit to phone**. This redraws that channel's CLI at the phone's width on the computer too, also while you sit at it. The computer's size comes back when you type in that channel at the computer, leave the channel on the phone, lock the phone or switch apps, or press **Desktop size**, which the phone remembers until you press **Fit to phone**. A channel on another linked computer, reached through this one, still waits until that computer has been unused for two minutes.
- **Also on the phone:** terminal keys are at least 44 px wide, and a plan-limit check that failed is shown as an error instead of a grey line.
- **A failed channel says why in three lines.** The line under a failed channel's header no longer scrolls: it shows the error's first line and the lines of the CLI's last output most likely to be the cause, and **Show all** opens the rest. It offers a setup page only when the error names one (**Choose project**, **Apply shared rules**, **Account setup**); a plain exit code has **Retry** and **Open log**. Before, most failures offered **Account setup**.
- **Session history shows a failed run as failed.** A run that ended with an error was listed with a green "Completed"; it now shows its exit code in red, in the list and in the record.
- **Plan limits.** A check that failed is shown as an error on **Usage**; a fact, such as an account without limits, is shown as information.
- **Round Table in small tiles.** The Round Table bar takes at most two lines in a narrow tile, and the hierarchy bar folds to one line with a chevron that opens it; a message waiting to go stays in view.
- **Smaller changes.** A To do task has a labelled button to start it. **Changes** hides the Delivery card when the folder is not a Git repository, and calls unstaged files "Unstaged". **Workflow center → Recovery** no longer advises choosing a project folder for every CLI exit whose output mentions "cwd".
- **Known and left:** in the rows arrangement, a notice for a channel scrolled out of view can lie over the right end of the next tile's header until it is answered or dismissed. With three channels where the third is a chat, its lines run the full width of the window.
- **Not tried yet:** the installed app, anything on a Mac, a real phone, a real linked computer, a screen reader, and Usage with real numbers (the test data has none). Checked on Windows with the unit tests and eleven smoke tests (desktop, workbench, phone remote, screen sharing and seven more), and every screen was photographed at two window sizes and read.

1.23.0 takes memory sync off the path that could stop Trace for 1 to 3 seconds, counts the tokens of agents started by a workflow, and fixes what an audit of the whole app found (update every computer and reload the phone app):

- **Memory sync no longer holds the window.** With memory syncing to a Google Drive folder, Trace could stop responding (its window, its terminals and the phone) for 1 to 2 seconds the first time a project synced after a start, and for up to half a second each time a channel started or a session ended with a summary. Several of these close together added up to 1 to 3 seconds. Sync now runs in the background: notes whose two copies have the same size are not read, copies that differ only in line endings are compared once and remembered across restarts, and notes are copied a few at a time. A channel waits at most 1.5 seconds for other computers' notes when it starts. The stop was never caught while it happened, so this is the most likely cause, not a proven one.
- **Trace records when it stops responding.** A stop of a quarter of a second or more in Trace's main process or its window is recorded with its length, and **Settings → Running application → Application stability & crash diagnostics** lists them. For a stop in the main process the entry also names the job that was running or had just run, when Trace knows it.
- **Three shorter pauses are gone too.** Today's usage keeps its place between starts instead of reading the last 60 days of CLI logs again, a long chat no longer redraws its whole thread for each word of a reply, and a terminal that loses its graphics context goes on drawing at once.
- **Workflow agents' tokens are counted.** Agents started by a Claude Code workflow were left out of usage, today's total, cost and budget warnings. They now count, also toward a session token limit, which is reached sooner than before.
- **A price entered under a model's name is used.** A rate named "Claude Opus 5.5" now prices runs logged as `claude-opus-5-5`. Before, such a rate matched nothing.
- **Ctrl+R and Ctrl+W no longer stop every channel.** With the focus outside a terminal, Ctrl+R and Ctrl+Shift+R reloaded the window and Ctrl+W closed it, which stopped every running channel without asking.
- **Close asks before it stops a running channel.** A channel that is not running closes at once, as before.
- **A channel's hover controls have their own row** under the header, instead of being drawn across the header. While the row is shown it covers the top of the terminal.
- **Round Table.** Closing a Round Table with its channel's **Close** keeps its review findings. Images sent with feedback on a plan reach the builder. A template that holds a Round Table can be applied: it keeps the table's seats and drops its work.
- **Linked computers.** Another computer's chat thread is no longer emptied when a channel here changes, and a paste longer than 4,096 characters into its terminal arrives (it was dropped without a message).
- **Phone access off and on keeps the screen.** Turning phone access off and on again removed the address this computer's screen is opened through, until Trace restarted. It is kept now, and a computer that had lost it gets it back.
- **A computer you removed stays removed.** A computer removed under **Settings → Other computers** is now refused here if it tries to link itself again: it needs a code. Before, only Trace on the removed computer held back. Each automatic link is now shown with a banner in the window, and with a notification unless desktop notifications are off.
- **Backups.** A backup no longer fails once the usage database passes 16 MB, restoring one keeps this computer's identity, its phones and its linked computers, and a backup can be deleted.
- **Safer Git reads.** Looking at a repository no longer runs a filter program set by one of its submodules.
- **The clipboard.** Only Claude Code and Codex channels can write to your clipboard with an escape sequence (OSC 52). In a plain terminal channel, a copy that vim or tmux sends to the terminal that way, as tmux does and as vim does over SSH, no longer reaches the clipboard.
- **Also changed.** On a Mac the channel shortcut is ⌘1 to ⌘8, and Option with a digit types its character again. At a Round Table, an answer to a finding counts only with its verb in capitals (`FIXED`, `VERIFIED`), and a lower-case one is ignored; a line that starts with a keyword in capitals but cannot be read now raises a notice. Other computers see this computer's usage up to 5 minutes later. The window keeps running at full speed while minimized or covered.
- **Crash dumps.** On Windows, programs started from a channel no longer write their crashes into Trace's crash-dump folder, and old dumps are removed.
- **Still open:** shared rules are still written into `CLAUDE.md` and `AGENTS.md`, and a window that reloads or crashes still stops every channel.
- **Not tried yet:** the installed app, anything on a Mac, a real phone, and two computers over Tailscale; nobody has looked at the changed parts of the window. Checked with the unit tests and eleven smoke tests on Windows (desktop, workbench, phone remote, PTY, memory server and six more), and the memory sync's reading was timed against real Drive folders.

1.22.0 lets work go on at a hierarchy Round Table after its final review, and keeps tasks from Tasks apart from what you type (update every computer and reload the phone app):

- **A follow-up after the final review goes back to the planner.** Once a hierarchy table has reached its final review, what you write goes to the planner, who plans again from where the work stands; Codex challenges that plan and you approve it before the builder starts. A message waiting when the planner approves starts as the next task.
- **Tasks from Tasks wait their turn.** A task sent from Tasks while the table works is never merged with what you type and never joins the current task: it waits, listed on the bar, and starts once the task before it is approved, one per approval.
- **Waiting tasks can be dropped.** Each waiting task has its own **Drop it**, which puts it back in **To do**; so does closing the table, for every task still waiting. A task renamed while its table works is still matched, and still marked finished on approval.
- **A plan you sent back is not lost.** A revision you asked for survives **Stop** and a restart, and an empty answer from the planner loses neither the plan before it nor what you asked.
- **The bar says where a waiting message will go:** with the next step, or to the planner.
- **The hierarchy reviewer runs `gpt-6.1-sol`.** A reviewer saved on `gpt-6-astra`, or with no model, starts on `gpt-6.1-sol`; another model chosen under **Models** stays.
- **GPU crashes leave more behind.** With a GPU process crash, Trace now also records each window's state. The black window seen on 15 November was not reproduced (a new check crashed the GPU process 16 times and the window painted 15 times; the one failure is unexplained), so its cause is not known.
- **The desktop and PTY smoke tests run on a Windows development computer again.**
- **Not tried yet:** a real task at a hierarchy table in the installed app, **Drop it** from a phone, and anything on a Mac. Checked with the unit tests and the desktop, PTY, phone remote and GPU-crash smoke tests on Windows.

1.21.3 stops Trace freezing for a few seconds every 30 seconds, and the phone app says which computer it can't reach (update every computer and reload the phone app):

- **No more freeze every 30 seconds.** With memory syncing to a Google Drive folder, Trace could stop responding for 2 to 5 seconds every 30 seconds: its window, its terminals and the phone. One note whose two copies had the same content but different bytes (other line endings) made every sync read every note of that project from Drive. Trace now reads only the notes that differ, remembers the ones it has compared, and lists the Drive folder in the background.
- **Still one pause after starting.** While such a note exists, the first sync after Trace starts compares that project once, which can take a few seconds.
- **The phone app says which computer it is waiting for.** The app on your phone's home screen belongs to the computer it was added from, and opens from a saved copy even when that computer is off. It used to say only "reconnecting…". It now names that computer and its address, and says whether the computer can't be reached or is on with Trace closed. To use another computer, open that computer's phone address in the browser and add the app again from there.
- **Not tried yet:** the installed app on Windows or a Mac, and a real phone. Checked with the unit tests, the phone remote smoke test, the sync against a real Drive folder, and the phone message in a desktop browser. The desktop smoke test fails on the development computer at its Skills & plugins step, with and without these changes.

1.21.2 stops a console window from flashing up every few minutes on Windows (update every computer; the phone app needs no reload):

- **No more stray console windows.** Trace checks each Claude account's plan limits every few minutes by running Claude Code's `/usage`. Each check also started every MCP server from the person's Claude Code plugins (through `npx` and `uvx`), and on Windows a Python server started by `uvx` opened a visible console window. The check now starts no MCP servers (`--strict-mcp-config`); it never needed them.
- **Lighter checks everywhere.** The same change means a plan-limits check no longer starts those servers on a Mac either.

1.21.1 makes updating a Mac from another computer work again (update every computer; the phone app needs no reload):

- **A Mac on 1.21.0 can be updated again.** On 1.21.0, updating a Mac from another computer stopped with "the feed lists no checksum": it looked only for a Mac update zip, which unsigned releases did not publish. Every release now publishes the zips with their checksums. A Mac on 1.21.0 gets 1.21.1 by updating from another computer as before, or by installing the disk image from the downloads page by hand.
- **Checked before it installs.** From 1.21.1, a Mac updated from another computer installs the release's disk image, after checking it against its published checksum.
- **Not tried yet:** the update on a real Mac.

1.21.0 removes Gemini, has Codex challenge the plan, and makes stopping and restarting a Round Table dependable (update every computer and reload the phone app):

- **Gemini channels and the Gemini seat are removed.** + Channel no longer offers Gemini (on the computer, another computer's tab or the phone), Local engines no longer looks for Gemini CLI (`agy`), and the hierarchy Round Table seats three agents again.
- **Saved Gemini channels are dropped on load.** A workspace or project template saved by 1.19 or 1.20 still opens: its Gemini channels and a hierarchy table's hidden Gemini seat are removed, and a notice says so. A table saved at Gemini's review or comparison comes back stopped at Codex's review.
- **Codex challenges the plan.** At a hierarchy table, once per task, the Codex reviewer challenges the planner's plan before you see it (`CHALLENGE` lines or `NO CHALLENGES`), and the planner answers each and writes the plan again. This works in any folder, Git or not. **Continue without the challenge** shows you the plan when the challenge stopped.
- **Stop and restart a Round Table without it going wrong.** An agent still busy with a turn from before a reopen is stopped, and that old turn no longer ends the new step. A message you send between two steps, or just before **Stop**, is kept and goes with the next step instead of starting a new task or being dropped. A table seated again after a restart no longer asks for a "joining" summary. A table that will not open again says why, and a builder restarted after the workspace folder changed starts in its table's folder.
- **Tasks finish the right task.** With two tasks on one channel, a `TASK COMPLETE` goes to the task the agent was answering: never to a newer task waiting at a Round Table or typed while the agent was busy. A hierarchy verdict moves only the task its plan was for. A quick `TASK BLOCKED:` from a chat now shows in Needs you, and a task can no longer be sent into a terminal that is waiting for an approval.
- **Review findings are read more carefully.** Only `FINDING` and `CHALLENGE` in capitals count, so a sentence like "Finding: high quality work" is no longer a finding. A full findings record makes room by dropping verified findings, or stops and says so, instead of passing a review as clean.
- **Updates are safer.** A Mac updated from another computer installs only a newer version, and only after checking the download against the published checksum. Signed Windows builds name their publisher, so installed copies check who signed each update. The release workflows use pinned versions of GitHub's actions.
- **Phones and linked computers.** The phone can open another computer's screen directly when its own computer is off, a linked computer's Round Table shows as one on the phone, and a linked computer with long chats no longer reconnects every two seconds.
- **Quieter, steadier desktop.** One old log Windows will not delete no longer turns local storage off, a failing desktop notification can no longer leave a stopped channel showing as running, Drive memory sync reads nothing when both sides already match, verification checks can start Electron apps, a channel's token count includes a hierarchy table's planner, and chat channels no longer keep a hidden terminal.
- **Memory and rules.** A project with 5,000 notes moves its oldest handoff to an archive folder instead of refusing new notes (open items and decisions are never moved). Clearing shared rules gives `CLAUDE.md` and `AGENTS.md` back as they were, and removes one Trace created.
- **Not tried yet:** a real task at a hierarchy table in the installed app, the Mac update from another computer on a real Mac, and a phone. Checked with the unit tests and the desktop and remote smoke tests on Windows.

1.20.0 seats Gemini at the hierarchy Round Table and stops Full access from asking there (update every computer and reload the phone app):

- **Gemini joins the hierarchy Round Table.** When Gemini CLI (`agy`) is installed, a hierarchy table seats it as a fourth, hidden, read-only agent. Once per task it challenges the planner's plan before you see it (the planner answers each challenge and rewrites the plan; the bar lists them at Approve), reviews the build before Codex without seeing Codex's findings, then compares the two reviews (agree, dispute, or duplicate). Codex alone checks the fixes, and the planner still gives the final review. It always runs Gemini 4 Argon (High) and stops if agy does not confirm it. Without agy, or with no room for a fourth agent, the table opens with three and says why.
- **Gemini changing files stops the table.** Gemini CLI writes files without asking even in plan mode (seen with agy 1.5.6), so Trace compares the project's files before and after each Gemini step and stops the table if they changed. **Continue** runs the step again; **Continue without Gemini** passes it over.
- **Full access no longer asks at a Round Table.** The planner (Fable), the reviewers and Gemini ran in a read-only mode that asked before every command, even at Full access. At Full access their commands now run without asking; their file edits are still declined.
- **The table's Permissions control sets the planner too.** It changed only the builder and Codex, so the planner kept asking at Full access, or went on running commands unasked after a switch back to Ask.
- **Not tried yet:** a whole task at a table with a real Gemini seat in the app, a phone or another computer following such a table, and a Mac. Computers on 1.19.0 following this computer's table show Gemini's steps without their names and do not show Gemini's messages. Going back to 1.19.0 on a computer whose saved workspace holds a Gemini seat: 1.19.0 cannot read that workspace ("Saved workspace settings could not be read"; the data is kept, and it saves nothing for that launch).

1.19.0 adds Gemini CLI channels and puts + Channel in a new order (update every computer and reload the phone app):

- **Gemini CLI channels.** **+ Channel → Gemini**, on the computer, on another computer's tab and on the phone, adds a channel that runs Google's Gemini CLI (`agy`) in a terminal. It always uses Gemini 4 Argon (High), the highest model on your subscription, and its **Permissions** setting works as for the other agents. Install agy and sign in to it first; Local engines shows whether Trace found it. A Gemini channel is the CLI in a terminal: it has no chat, usage tracking, shared memory, tasks or Round Table seat, and phones and other computers list it as a terminal. Update every computer: one with an older Trace cannot add a Gemini channel.
- **+ Channel in a new order.** It now lists Terminal, Claude Code, Codex and Gemini, then Round Table and Round Table (hierarchy), on the computer, on another computer's tab and on the phone (without the Round Tables there). Codex CLI and Gemini CLI are called Codex and Gemini in the menu.
- **Not tried yet:** a Gemini channel from a real phone, and a Gemini channel on a Mac. It was tried on Windows.

1.18.0 makes screen sharing steadier, lets you see and control a Windows computer from the phone, and tightens the hierarchy Round Table and shared memory (update every computer and reload the phone app):

- **No more Claude chat and Codex chat in + Channel.** On the computer, + Channel offers Claude Code, Codex CLI, a terminal and the two Round Tables; on the phone, Claude Code, Codex CLI and a terminal. Chats you already have keep working, and a Round Table still leads with a Claude chat.
- **Your handoffs come before automatic summaries.** At launch, notes someone wrote (a handoff, a review record) are listed first, and at most two of Trace's automatic session summaries follow in the space left. Before, summaries counted the same as handoffs and could push them out.
- **Fewer empty summaries.** A session that changed no files, made no commits and ended on a short message (under 200 characters, such as "AGREE") no longer writes a summary. The hidden agents at a Round Table (a discussion table's partner, a hierarchy table's planner and reviewer) write none of their own; the channel you see still writes one.
- **A review must end with findings or NO FINDINGS.** At a hierarchy table, a Codex reply with neither (empty, or a question) used to count as a clean review and go straight to the final review. Now the table stops at the review and says so; **Continue** runs the review again. A second-round reply that only verifies fixes (`VERIFIED F1`) still moves on.
- **The planner writes its plan in the chat.** Its brief now says Trace runs it in Claude's plan mode, so it writes the whole plan in its reply instead of a plan file, and does not try to leave plan mode (Trace declines that).
- **The hierarchy reviewer has a model of its own.** Codex at a hierarchy table now runs `gpt-6-astra` by default instead of whatever Codex's own settings say, and **Models** on the bar can change it, as for the planner and builder.
- **A step that fails inside Trace says why.** The table stops with "Trace could not finish this step (…). Continue tries it again." instead of stopping without a reason.
- **Screen sharing recovers by itself.** A linked computer's screen that drops connects again on its own (**Reconnecting…**), up to three times, before it shows **Disconnected** and waits for **Reconnect**.
- **A shared Windows screen no longer freezes without a word.** When its capture failed or stopped, the last picture stayed up and nothing more was sent; now the session ends and the viewer reconnects. Plugging in or removing a display, or changing resolution or scaling, does the same, so the picture and clicks match the new layout.
- **The first clicks and keys on a shared Windows screen go through at once.** The helper that presses them starts when you connect, not on your first click.
- **Copied text keeps every character.** Between Trace's viewer and a shared Windows screen, curly quotes, long dashes and emoji no longer turn into "?".
- **No more strip that never updates.** When the picture of a shared Windows screen was not a multiple of 64 pixels wide (common with two displays of different sizes), changes reaching its right-hand edge were never sent.
- **Less lag on a slow link.** A shared Windows screen keeps at most two pictures on their way to the viewer, so a slow connection shows fewer, newer pictures instead of falling further and further behind.
- **Sharper text.** Once the shared screen has been still for a moment, the parts sent quickly while it changed are sent again at high quality.
- **One display at a time.** With several displays, **Display** on the screen's bar shows one of them on its own at full size, or all of them again.
- **Viewing a Mac while Trace is open on it now works.** Trace on that Mac answered the screen request as a refusal ("…refused to share its screen"), so Screen Sharing was never tried.
- **A phone dropping its connection while its screen opened could crash Trace.** It is now handled.
- **A Mac's sign-in form stays up.** When a screen reconnected by itself and the Mac then closed the connection while you were typing its password, Trace tried again and the form disappeared. It now stops, says the Mac closed the connection while waiting for the sign-in, and waits for **Reconnect**.
- **When Windows does not say which display a capture is,** the shared screen now shows the main display at its full resolution, and clicks land on it rather than being spread across every display.
- **Long pastes are shortened instead of ending the session.** Trace's screen service takes up to 1 MB of text at a time; the viewer pastes the first part and says so.
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
