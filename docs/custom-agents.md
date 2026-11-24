# Custom agents: adding a CLI without a Trace release

Status: phase 1 built for 1.40.0 (branch `feat/custom-agents`); see [Phase 1 as built](#phase-1-as-built) for where it differs from this design and what is left. The person asked on 2026-11-24: "I'd rather it be a simple process where I add the CLI and everything follows", instead of a Trace release per CLI.

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
- **Not in phase 1:** a chat view, Round Table seats, and usage or cost. Phase 2 adds Round Table seats and leads for agents that speak ACP (`acp.args`), through the generic part of `gemini-stream.ts`.

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
  "env": { "AIDER_CHECK_UPDATE": "false" }
}
```

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
- **First request.** `firstRequest` is accepted but not used. Start in order and scheduled jobs type the first request into the terminal once the agent is ready (`sendWhenReady`), as for Gemini.
- **Resume.** `resume.listArgs` is accepted but not used. The person types the conversation ID in the channel's settings.
- **Drafting.**
  - The prompt goes to `claude -p --output-format text` on stdin, with up to 40,000 characters of help.
  - `--tools ""`, `--no-session-persistence` and `--strict-mcp-config` are added when that Claude Code advertises them.
  - The answer may be at most 256 KB. The draft's `program.command` is always the one the person typed.
- **Not in backups.** Definitions are not in backups, like scheduled jobs.
- **Images.** Pasting an image into a custom channel is refused, as for Gemini.
- **Linked computers.** Another computer's **+ Channel** (its tab here) does not offer its custom agents yet; the phone does.

**Not built in phase 1 (left for phase 2)**

- **From a list.** Shared definitions on GitHub with the topic `trace-agent`. TODO: reuse `electron/services/plugins/github.ts` (its browse and fetch) to list and fetch `trace-agent.json` from such repositories, and show each through the same form and confirmation. It was left out so that the plugin fetch could be reused cleanly rather than copied.
- **Sync between computers.** Definitions are not in device sync yet. The confirmation by hash already keeps a synced definition **Off** until the person turns it on, so adding `agents/` to device sync is the remaining part.
- Usage and cost, chat view, Round Table seats (ACP), `resume.listArgs`, `firstRequest`, the linked computers' + Channel, and a model list or permission note for custom agents on the phone's channel settings (it shows the definition's `choices` only).
