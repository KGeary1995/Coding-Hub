# Custom agents: adding a CLI without a Trace release

Status: phase 1 built for 1.40.0 (branch `feat/custom-agents`); see [Phase 1 as built](#phase-1-as-built) for where it differs from this design and what is left. Phase 2 (1.41.0) is described in the three **Phase 2 as built** sections at the end. The person asked on 2026-11-24: "I'd rather it be a simple process where I add the CLI and everything follows", instead of a Trace release per CLI.

## Idea

Claude Code, Codex and Gemini are written into Trace's code. Around 240 engine branches in about 80 files cover how each is launched, its models and permission levels, how Trace knows it waits or finished, memory, usage, Round Tables, the phone and colours. A **custom agent** is instead a small JSON *agent definition*. Trace reads it at run time, and every feature that does not need a CLI's private formats then works for that agent too.

The built-in three stay as they are. They are deeper than a definition can describe: Claude's hooks, Codex's notifications, chat streams and usage files.

## What a defined agent gets (phase 1)

- An entry in **+ Channel** (desktop and phone), with its name, colour and initials, and its own settings: a model drop-down when the definition lists models, and the three permission levels when it maps them.
- A terminal channel running its program in the channel's folder.
- **Needs you** and **Done**, desktop alerts, and the phone's alerts, from the status signals the definition names (below).
- Automatic checks, Undo last turn, Start in order (first request), Scheduled jobs, Tasks (outcome read from its screen, as for a Gemini terminal), app preview, VS Code, Search (recorded terminal output), Session history runs, and the getting-started guide's agent step. These features all run on turn ends, the screen, Git or the PTY, none of them on a CLI's private files.
- **Shared memory and the channel/task tools**, when the definition says how the CLI takes MCP servers (a flag with a config file in Claude's or Codex's format) and, optionally, extra instructions (a flag or an environment variable). Otherwise none, and the channel's settings say so.
- **Resume**, when the definition gives the resume arguments. The conversation ID is the one the person enters, or one the definition's `resume.listArgs` prints.
- **Not in phase 1:** a chat view, Round Table seats, and usage or cost. Phase 2 adds a chat channel and Round Table seats (and leads) for agents that speak ACP (`acp`), through `acp-stream.ts`, the generic part of what was `gemini-stream.ts`. Usage and cost are still not counted.

## Definition format (`schema: 1`)

```json
{
  "schema": 1,
  "id": "aider",
  "name": "Aider",
  "color": "#7c9cff",
  "program": { "command": "aider", "args": ["--no-auto-commits"] },
  "version": { "args": ["--version"] },
  "models": { "choices": ["sonnet", "gpt-4.1"], "listArgs": null, "arg": ["--model", "{model}"] },
  "permissions": { "ask": [], "edits": ["--yes-always"], "full": ["--yes-always"] },
  "resume": { "args": ["--restore-chat-history"] },
  "firstRequest": { "args": ["--message", "{prompt}"] },
  "status": {
    "osc": true,
    "waiting": ["\\(Y\\)es/\\(N\\)o", "Allow .* \\?"],
    "turnEnd": ["^> $"],
    "quietSeconds": 4
  },
  "mcp": { "format": "claude-json", "args": ["--mcp-config", "{file}"] },
  "instructions": { "args": ["--append-system-prompt", "{text}"] },
  "env": { "AIDER_CHECK_UPDATE": "false" },
  "acp": { "args": ["acp"], "modes": { "ask": "plan", "edits": "accept-edits", "full": "auto" } }
}
```

(Aider has no ACP server; `acp` is shown here for the format. Leave it out for an agent whose help shows none.)

Field rules (validated with zod in `shared/agent-definition.ts`; unknown fields are refused):

- `id`: `^[a-z][a-z0-9-]{1,30}$`. It must not be a built-in engine name (`claude`, `codex`, `gemini`, `shell`). `name`: 1–40 characters. `color`: `#rrggbb`, optional; without one Trace picks from its palette.
- `program.command`: a program name looked up on PATH, or an absolute path. It never runs through a shell. On Windows, `.cmd` and `.bat` are refused, as for Gemini's `agy.cmd`, because Trace runs no batch files; native `.exe` programs and Node `.js` entry points (run with Node) are accepted.
- **Arguments** are arrays of strings. The placeholders `{model}`, `{prompt}`, `{id}`, `{file}` and `{text}` are replaced whole, only inside an argument and only with validated values. A model comes from `choices` or the list, or is a typed name matching `^[\w.:/@+-]{1,120}$`. A prompt is at most 4000 characters, as `preparedRequest` allows. Nothing is ever split into further arguments.
- `status`:
  - `osc`: OSC 9, OSC 777 and OSC 99 notifications mean the turn ended, or that the agent is waiting when their text matches a `waiting` pattern.
  - `waiting`: regexes over the visible screen. A match means the agent waits for the person, and its line becomes the message.
  - `turnEnd`: regexes over the last non-empty screen line. A match after output means the turn ended.
  - `quietSeconds` (2–60): no output for that long after output also means the turn ended. 0 turns this off.
  - All regexes are compiled once, limited to 200 characters, and tried only on the screen's lines.
- `mcp.format`:
  - `claude-json` writes `{"mcpServers":{…}}` to a per-run file passed through `{file}`.
  - `codex-toml` passes `--config mcp_servers.<name>.*` arguments the way Codex's launch does.
  - `none` (the default) means no MCP.
- `instructions`: `args` with `{text}`, or `env` naming a variable. It carries the memory context, the same text Claude gets through `--append-system-prompt`.
- `acp` (phase 2, optional): `args` start the program as an Agent Client Protocol server, with no placeholder (empty when the program is the server itself). `modes` names the session mode (`session/set_mode`) for `ask`, `edits` and `full`; each is optional and is a mode id the agent lists (`^[A-Za-z0-9][\w.:/-]{0,79}$`, so never a flag). A definition without `acp` is still `schema: 1` and valid.

## Where definitions live

- `~/.coding-hub/agents/<id>.json`, one file per agent. It is read and written with `readConfig`/`updateConfig`, which keep a backup and replace the file atomically.
- Definitions are synced between computers with the other settings (device-sync), but a synced definition is **not active** until the person confirms it on that computer. It names a program to run.
- **Security:** saving a definition, or activating a synced one, shows a native dialog. The dialog names the exact program, every argument, the environment and the permission arguments, as for event hooks and plugins. The renderer only sends the definition. The host validates it, resolves the program, and builds every launch itself.

## Adding one (the person's flow)

Agent setup → **Agents**. Built-in agents are listed read-only, and custom ones with Edit and Remove. **Add an agent** offers three ways:

1. **From a list:** shared definitions on GitHub with the topic `trace-agent`, fetched as plugins are (1.37). Each needs the same preview and confirmation.
2. **Draft it for me:** the person names the program. After a confirmation, Trace runs `<program> --help` (and `--version`) itself, with a 10 s limit and 64 KB of output at most. It asks Claude Code in print mode (`claude -p`, the person's own CLI and sign-in; Trace has no model API of its own) to fill in a definition, using this document's format section and the help text. Trace validates the draft and shows it as a form, not raw JSON. When Claude Code is missing, the person starts from a blank form.
3. **Write or paste one:** a form with the same fields, and a JSON tab.

Before saving, **Test start** runs the version arguments and shows what came back.

## Code map (phase 1)

- `shared/agent-definition.ts`: the zod schema, types, placeholder filling, and the `customAgentConfig` type.
- `shared/types.ts`: a new channel engine `'custom'` with `CustomChannelConfig { engine: 'custom'; agentId: string; model: string; permissions?: PermissionLevel; resumeId?: string }`. `isAgentConfig` includes it, and `isChatEngineConfig` does not.
- `shared/schemas.ts`: `channelConfigSchema` accepts it.
- `electron/services/agents/agents.ts`: the store (list, save, remove, activate), the program lookup, the version test and the `--help` capture.
- `electron/services/agents/launch.ts`: a definition plus a config becomes the launch: program, arguments, environment, MCP file and instructions.
- `electron/services/agents/status.ts`: the status reader for a custom run. It reuses `OscNotifications`, a headless screen like `ScreenReader`, and quiet time. It feeds `notifyAttention`/`notifyResolved` in `pty-manager.ts`, as the Gemini reader does.
- `electron/main.ts`:
  - `prepareLaunch` branches for `custom`.
  - It handles the workbench actions `agent-list`, `agent-save`, `agent-remove`, `agent-test` and `agent-draft`.
  - `channelList`, `checkEvent`, the snapshots and the preview treat custom agents as agents.
- Renderer:
  - `src/components/AgentsPanel.tsx` (the Agents page) and `AgentDefinitionForm.tsx`.
  - + Channel in `Topbar.tsx`, `EngineControls` for custom agents, the tile avatar and colour, and the channel-name defaults.
- Phone: + Channel and the avatar of a custom agent.
- Tests:
  - Schema refusals: a shell in the program, `.cmd`, an unknown placeholder, an id clash, regex limits.
  - Placeholder filling never splits an argument.
  - The status reader: OSC, waiting and turn-end patterns, quiet time.
  - `prepareLaunch` with MCP files.
  - The store's backup and confirmation.
  - A smoke step that adds a fixture agent (`scripts/fixture-cli`) and runs a turn in a channel.

## Phase 1 as built

Everything above is built, with these differences. Each was chosen to keep the program a definition names under the person's control, or to keep older Traces on the person's other computers working.

**Differences from the design**

- **Program lookup.** Like `.js`, the `.cjs` and `.mjs` entry points run with Node. On Windows a bare name is looked up as `.exe` and `.com`. When only an npm or pnpm `.cmd` shim is on PATH, Trace reads the shim's text (never runs it) and starts the `.js` or `.exe` it names, if that file is inside the shim's own folder. Most Node CLIs install only as such a shim (`findProgram`, `shimTarget`).
- **Shells and scripts.** The program may not be a shell or a launcher (`cmd`, PowerShell, `bash`, `sh`, `env`, `sudo`, `start`, `open`, `osascript` and similar), a `.cmd`, `.bat`, `.ps1`, `.vbs` or `.lnk` file, or a name with spaces or shell syntax.
- **Placeholders are per field.** `{model}` works only in `models.arg`, `{id}` in `resume.args`, `{prompt}` in `firstRequest.args`, `{file}` in `mcp.args` and `{text}` in `instructions.args`. Each of those fields must contain its placeholder. Braces that are not a placeholder (JSON in an argument) are left alone.
- **Models and conversation IDs** must start with a letter or digit, so neither can be read as a flag (`AGENT_MODEL`, `AGENT_RESUME_ID`).
- **Environment.** `env` may not set `PATH`, `ELECTRON_RUN_AS_NODE` or any `CODING_HUB_*` variable. At most 20 variables are allowed.
- **Confirmation.** A definition is on when its hash is in `agents-confirmed.json`. Saving or **Turn on** puts it there after the native dialog. A definition changed by hand, or copied in from elsewhere, is **Off** until confirmed. **Test start** also asks before it runs a definition that is not saved and confirmed.
- **Status signals.**
  - `waiting` patterns are tried on the bottom six lines of the screen that have text, not the whole screen, so a question answered earlier and still visible higher up does not keep the channel at Needs you.
  - `turnEnd` is tried on the line the cursor is on, up to the cursor (so `^> $` matches its trailing space), and on the last line with text.
  - A turn can end only after Enter was pressed in the channel and the agent printed something more than 250 ms later. The program's start screen is therefore never read as a finished turn.
- **Shared memory.** The memory server starts from its environment, as agy's plugin starts it, without naming an engine. The agent therefore says which author it writes as: notes keep the four authors older Traces accept (an unknown author would be dropped on the person's other computers). A custom run writes no automatic session summary. The extra instructions (the notes as context) are passed only when the definition takes MCP servers and automatic memory is on.
- **First request.** `firstRequest` was accepted but not used in phase 1: Start in order and scheduled jobs typed the first request into the terminal once the agent was ready (`sendWhenReady`), as for Gemini. Phase 2 uses it (below).
- **Resume.** `resume.listArgs` was accepted but not used in phase 1: the person typed the conversation ID in the channel's settings. Phase 2 lists them (below).
- **Drafting.**
  - The prompt goes to `claude -p --output-format text` on stdin, with up to 40,000 characters of help.
  - `--tools ""`, `--no-session-persistence` and `--strict-mcp-config` are added when that Claude Code advertises them.
  - The answer may be at most 256 KB. The draft's `program.command` is always the one the person typed.
- **Not in backups.** Definitions are not in backups, like scheduled jobs.
- **Images.** Pasting an image into a custom channel is refused, as for Gemini.
- **Linked computers.** Another computer's **+ Channel** (its tab here) did not offer its custom agents in phase 1; the phone did. Phase 2 adds them (below).

**Not built in phase 1 (left for phase 2; see Phase 2 as built for the chat and Round Table part)**

- **From a list.** Shared definitions on GitHub with the topic `trace-agent`. TODO: reuse `electron/services/plugins/github.ts` (its browse and fetch) to list and fetch `trace-agent.json` from such repositories, and show each through the same form and confirmation. It was left out so that the plugin fetch could be reused cleanly rather than copied.
- **Sync between computers.** Definitions are not in device sync yet. The confirmation by hash already keeps a synced definition **Off** until the person turns it on, so adding `agents/` to device sync is the remaining part.
- Usage and cost. Everything else in this list is built in phase 2: see the three **Phase 2 as built** sections below.

## Phase 2 as built: chat and Round Table seats (ACP)

Many agents speak the [Agent Client Protocol](https://agentclientprotocol.com): JSON-RPC over the program's stdin and stdout, one message per line (`initialize`, `session/new`, `session/load`, `session/set_mode`, `session/set_model`, `session/prompt` with `session/update` notifications, `session/request_permission`, `session/cancel`). Gemini CLI (`agy acp`) does, and Trace drove it through `gemini-stream.ts` since 1.28. A definition with `acp` gets the same: a chat channel, and any seat at a Round Table.

**What the person sees**

- **+ Channel** lists **<Name> chat** after the agent's terminal entry for every turned-on agent whose definition has `acp`, on the desktop and the phone. The phone's request (`/api/channel-add` with `engine: custom`, `agent`, `chat: true`) is refused when that agent has no `acp` (the look's `chat` flag, `AgentLook.chat`).
- The chat is the same view as Claude Code's, Codex's and Gemini's: replies stream in, tool calls are cards, approvals are buttons, and the channel shows **Needs you** while one waits. The tile says **<Name> chat**; the phone shows the conversation too (it does not open a Round Table from there, as for Gemini).
- **Round Tables:** the setup panel's agent list adds every turned-on agent with `acp`, by name (`custom:<id>` in the select). Such a seat can review, plan, challenge, give the final review, drive a discussion, lead, and build at a hierarchy, as Gemini can since 1.39. It goes by its agent's name ("Fixture ACP", "Fixture ACP 2"). A preset keeps the seat's agent id (`TablePresetSeat.agent`; `tablePresetSchema` requires it for `engine: custom` and refuses it otherwise). A chat started on a custom agent leads with that agent.
- **Settings** of a custom chat: the permission level always (Trace keeps it over ACP, whether or not the definition maps terminal flags), the model drop-down when the definition lists models, and the session to continue, which Trace fills in itself.
- **Agents page:** the form has a **Chat and Round Tables** section (ACP arguments and the three mode ids). The save dialog names them (`Chat (ACP): …; modes …`). **Draft it for me** fills `acp` when the help shows an ACP subcommand or flag (`DRAFT_FORMAT`).

**How it runs**

- `electron/services/chat/acp-stream.ts` (`AcpStream`) is the protocol client; `GeminiStream` is now `AcpStream` with agy's settings (`agy: true`, modes `GEMINI_MODE`), and behaves exactly as before: its tests (`gemini-stream.test.ts`, `round-table-gemini.test.ts`) are unchanged.
- `buildAcpLaunch` (`agents/launch.ts`): the program with `acp.args` only (not `program.args`, the permission, model, resume or MCP arguments, which are its terminal's), the definition's `env`, and extra instructions only through an `instructions.env` variable (ACP has no system prompt). Trace's MCP servers (shared memory and, when on, the channel tools) go in `session/new`'s `mcpServers`, since every ACP agent must take stdio servers, whatever the definition's `mcp` says.
- **Level and modes.** The mode asked for is `acp.modes[level]`; a read-only seat (a reviewer, or the driver while the table discusses) asks for `acp.modes.ask`. A level with no mode runs in the mode the session started in (`modes.currentModeId`), so a seat is never left in a freer mode an earlier level set. Trace also answers the agent's requests by level: at **Ask** a file change (kinds edit, delete, move) is declined and said in the thread, as for Gemini since 1.40.1, so Ask is read-only; at **Allow edits** Trace allows file changes itself (`allowEdits`) and asks the person about everything else; at **Full access** it allows everything. A read-only seat's requests go to the table, which declines its edits. What the agent does without asking at all is its own mode's to say: a definition should give `modes.ask` a read-only mode where the agent has one.
- **Confirmation.** For a custom agent the answer to `session/set_mode` or `session/set_model` confirms it (the protocol as written); agy's own reports are still what GeminiStream waits for. A model the agent does not offer (`availableModels`) is refused before it starts. The `ready` event names the session, which the window keeps as the chat's `resumeId` (`keepAcpSession` in `use-native-host.ts`, only an id `AGENT_RESUME_ID` accepts); a restart then loads it with `session/load`, and its earlier messages are shown again. An agent whose `initialize` does not offer `loadSession` starts a new session, and the thread says so.
- **Images** are sent only to an agent whose `initialize` offers `promptCapabilities.image`; otherwise the text goes alone, and the thread says so.
- `pty-manager.ts`: a custom config with `chat: true` is a chat run (`isChatRun` now covers every agent config), spawned with plain pipes like the other chats, with no screen reader. The table host's `run()` gives a custom seat's `agentName`, which `RoundTableState.seats[].agentName` carries to the window and phone (`defaultSeatName`). `SeatEngine` includes `custom`, so the zod enums for `driver` and preset seats do too.
- **Checks:** `acp-stream.test.ts` (against `scripts/fixtures/acp-agent.cjs`, a stand-in ACP server run as a real process), `round-table-custom.test.ts` (a custom seat reviewing, driving, and building at a hierarchy), the launch, schema, store, table-seat, pty-manager and remote-server tests, and a productivity-smoke step that saves the fixture agent, chats with it from + Channel and runs a Round Table of two of its chats to agreement.
- **With a real CLI:** on 2026-11-24 the generic path (not GeminiStream) drove agy 1.5.16 defined as a custom agent (`{"program":{"command":"agy"},"acp":{"args":["acp"],"modes":{"ask":"plan","edits":"accept-edits","full":"auto"}}}`): at Ask (plan mode) it answered and wrote only its own plan under `~/.gemini`, not the project; at Allow edits with `gemini-4-neon-low` set by `session/set_model` it created the file asked for. No other ACP agent (Goose, OpenCode, Claude Code's ACP adapter) was tried.

**Not built in phase 2**

- Usage and cost for custom agents (ACP's `usage_update` is not read).
- Linked computers: another computer's tab offers its custom agents' terminals, but does not show or add a custom chat as a chat yet (its channel list does not know engine `custom`).
- Tasks from Tasks and scheduled jobs still open a custom agent as a terminal; a custom chat takes a task sent to it, read from its thread like other chats.

## Phase 2 as built: from a list and sync between computers

**From a list** and **sync between computers**.

**From a list**

- Agents → **Add an agent** → **From a list**. **Show shared agents** lists GitHub repositories with the topic `trace-agent` (GitHub's public search, kept for an hour). As for plugins, the list says nobody reviews it. The person can also type or paste `owner/repo` (or `owner/repo/folder`, or a `https://github.com/…` address) and choose **Get it**.
- The repository is fetched with the computer's own Git, as plugins are: `parseSource`, `fetchRepo` and the topic search in `electron/services/plugins/github.ts` are shared. `browse` takes the topic, and `topicList` keeps a topic's list for an hour for both plugins and agents. A private repository works when Git is signed in to GitHub on this computer.
- `electron/services/agents/from-github.ts` reads `trace-agent.json` from the copy. It must be a plain file under 64 KB, not a link and not reached through one, and a JSON object. The copy is deleted afterwards. The host checks it against the schema and returns it with its problems (`AgentFetched`: the definition, the problems, and the repository and commit). The window opens it in the usual form with a note naming the repository and commit, and asks the person to check the program and arguments.
- Nothing is saved or run on fetch. Saving goes through `agent-save` and its native dialog, and Test start asks first, as for any unconfirmed definition.
- Workbench actions: `agent-browse` and `agent-fetch { repo }`.

**Sync between computers**

- `AI-Coding-Hub-Sync/agents/<id>.json` in the Drive folder, one document per agent: `{ version: 1, machine, updatedAt, value }`. `value` is the definition, or `null` where a computer removed it. A removal is written as `null`, not by deleting the file, so a missing file (a folder still downloading, or moved) is never read as a removal; this computer's copy is shared again instead.
- `DeviceSync.syncAgents` merges each agent against the hash last synced (`device-sync.json` → `agents.base`):
  - A change on one side is taken.
  - When both sides changed, a change wins over a removal. Otherwise the newer one wins: the shared file's `updatedAt` against this computer's file time. The replaced definition stays in `config-backups/`.
  - A shared file that cannot be read, or a local file that is not a valid definition, is left alone on both sides, and Settings → Sync between computers says how many could not be read.
- A definition from another computer is written with `CustomAgents.receive` (`updateConfig`, so backup and atomic replace) and is **not** confirmed. It is therefore Off here, and `launchable` refuses it, until the person turns it on and sees the same native dialog. `agents-confirmed.json` never syncs.
- `agents-received.json` (local only) notes which computer each definition came from. While such a definition is Off, the Agents page shows "Added from your other computer (name). Check it, then turn it on." (or "Changed on…" when it replaced one), with **Turn on**.
- An agent turned on here that another computer changes goes Off here until it is confirmed again, as for a definition changed by hand. If the person had confirmed exactly that definition before, it stays on.
- A computer that already has 20 agents does not take a new one. It is tried again at the next sync.

## Phase 2 as built: the smaller gaps

Gaps closed after 1.40.0.

- **Conversations to continue (`resume.listArgs`).** A custom channel's settings show **List its conversations** when the definition gives `resume.listArgs` and the agent is on. Only when pressed, the host runs those arguments (`agent-conversations`, `CustomAgents.conversations`): the confirmed definition's own program, without a shell, in the channel's folder (an absolute folder that exists, else Trace's probe folder), with the definition's environment, 10 seconds and 64 KB at most, as Test start and the `--help` run. What it prints is read defensively (`conversationsFrom`): colour sequences removed, one conversation per line, the line's first word the ID (a trailing `:` or `,` dropped) and the rest its label; only IDs that match `AGENT_RESUME_ID`, no word in capitals only (a header such as `ID`), no repeats, 50 at most. They show as a pick list above the ID box; typing an ID stays for one the list does not show. A program that exits with an error, or takes longer, says so, and the box is still there.
- **First request (`firstRequest.args`).** Start in order passes a custom channel's first request with the start (`StartSessionRequest.firstRequest`, at most 4000 characters, no NUL; `promptFits`). The host gives it to the program only when the definition has `firstRequest.args` and, where `{prompt}` is a whole argument, the prompt does not start with `-` (it could read as a flag; `firstRequestFits`). The prompt fills `{prompt}` whole, through `fillArgs`, never split, after the instructions and before the MCP arguments (a list flag such as `--mcp-config` would take what followed it). The run is then marked `prompted`: its status reader counts the first turn as under way without an Enter (`CustomStatusReader.begin`), and the window does not type it. Otherwise it is typed once the agent is ready, as before. A scheduled job for an agent whose definition (as the window last listed it) has `firstRequest` marks the task sent (`task-send`) before the start, so its prompt can go in; if the channel does not start, the task goes back to To do; if the host did not take it, that same prompt is typed.
- **Linked computers.** Another computer's tab lists that computer's turned-on agents under **+ Channel** (`linked-agents`, read from its `/api/me` as its phones read them; names and colours only, checked again here; none from an older Trace there). Choosing one asks that computer to add the channel (`linked-add` with `engine: 'custom'` and `agent`), which refuses an agent not turned on there.
- **Channel settings.** On the computer and the phone, a custom channel shows the permission levels only when its definition maps them; otherwise the note "This agent has no permission levels in Trace." The phone shows the model list only when the definition takes a model (`models.arg`), from its `choices` plus what its `models.listArgs` printed when the computer last asked (the phone never runs it). `RemoteChannelSettings.agent` carries the agent's name and these two facts.
- **Usage.** CLIs report usage in no common form, so none is read. The Usage page says so under **By engine** when custom agents exist, instead of showing zeros; the channel's settings already said its tokens are not counted.
