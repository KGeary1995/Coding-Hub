# Trace plugins: design for review

Status: **reviewed by the owner** (2026-11-24); the answers to section 10 are in. Nothing here is built yet. Modelled on herdr's plugins
(herdr.dev/docs/plugins), with Trace's rules: the window is untrusted, every native call goes through the main process, and
nothing runs that the person has not seen first.

The owner chose all four parts for the first version: actions and event hooks, plugin tiles, installing from GitHub, and
a list to browse.

## 1. What a plugin is

A folder with a `trace-plugin.json` manifest and the programs it names, in any language (a PowerShell or shell script,
Node, Python, a compiled binary). Trace runs those programs **as you, without a shell and without a sandbox**, exactly as
herdr does. A plugin can do anything you can do on this computer, so it is installed only after you have seen what it
runs (section 6), and again whenever an update changes it.

Plugins live in `~/.coding-hub/plugins/<plugin id>/<commit>/`, one folder per installed version. Each plugin also gets
`~/.coding-hub/plugins/<plugin id>/data/` for its own settings and state, kept across updates. Installed plugins and
whether each is on are recorded in `~/.coding-hub/plugins/installed.json`, per computer (not synced).

## 2. The manifest

```json
{
  "id": "example.notify-phone",
  "name": "Notify my phone",
  "version": "0.1.0",
  "minTrace": "1.35.0",
  "description": "Sends a Telegram message when a channel needs you.",
  "platforms": ["windows", "mac", "linux"],
  "permissions": ["channels.read", "notify"],
  "build": [{ "command": ["npm", "ci"] }],
  "actions": [{ "id": "send-test", "title": "Send a test message", "context": "workspace", "command": ["node", "send.js", "--test"] }],
  "events": [{ "on": "channel.needs-you", "command": ["node", "send.js"] }],
  "tiles": [{ "id": "board", "title": "Task board", "command": ["node", "board.js"] }]
}
```

- `id`, `name`, `version` and `minTrace` are required. Trace refuses a plugin that needs a newer Trace.
- Every `command` is an argument list. Its first item is a program found on PATH (`node`, `python`, `pwsh`) or a path
  inside the plugin's folder. It never runs through a shell, so nothing in it is expanded.
- `platforms` may be set on the plugin and on each item. An item for another system is left out.
- A manifest Trace cannot read in full is refused whole, with the reason. Trace never runs part of one.

## 3. What a plugin can do

### Actions
Each action is an entry in the command menu: **Plugin name: Action title**. Its `context` says where it applies:
- `workspace`: always listed.
- `channel`: listed for the channel the command menu was opened on.
- `repository`: listed when Changes shows a Git repository.

The program gets what it is about in environment variables: `TRACE_PROJECT`, `TRACE_CHANNEL`, `TRACE_CHANNEL_NAME`,
`TRACE_FOLDER`, `TRACE_BRANCH`. Its output goes to the plugin's log (section 7), and a failure is shown as a notice.

### Event hooks
The same runner as 1.33.1's event hooks (no shell, stopped after 30 seconds, at most once per channel every 10 seconds).
It covers more events:
- `channel.needs-you`, `channel.turn-ended`, `channel.failed`
- `channel.started`, `channel.stopped`
- `task.ready-for-review`
- `worktree.created`
- `trace.started` (herdr's startup hooks)

The environment variables are those of 1.33.1's hooks, plus the project and branch. The hooks you add in Settings stay
as they are, beside plugins.

### Plugin tiles
A plugin tile is a channel whose terminal runs the plugin's program instead of a shell or an agent. Examples are a task
board, a log viewer, or a TUI such as lazygit wrapped by a plugin.
- **+ Channel → Plugin tile** lists the tiles of the plugins that are on.
- A plugin tile counts toward the eight channels, moves and resizes like any tile, shows on the phone as a terminal, and
  is started and stopped like a shell channel. Its output is not recorded, as with a shell.
- The window only names the plugin and the tile. The main process looks up the command in the installed manifest, so
  the window can never make Trace run a command of its own choosing (rule 1 in AGENTS.md).
- A saved workspace keeps a plugin tile. If its plugin is gone or off, the tile says so instead of starting.

### Talking back to Trace (the plugin API)
herdr's whole command line is its plugin API. Trace gets the equivalent as a small local API, the same kind as 1.33.0's
channel tools:
- Every plugin program starts with `TRACE_API_URL`, a loopback address with a secret that names the plugin.
- It also gets `TRACE_CLI`, a small `trace` command-line helper that calls that address, so a plugin can stay a
  three-line shell script.

What it may call depends on the `permissions` its manifest declares, shown at install:

| Permission | Allows |
|---|---|
| `channels.read` | list channels and their state, read a channel's last replies |
| `channels.send` | send a channel a message (marked as from the plugin; refused while it waits for your approval) |
| `channels.control` | start, stop and add channels |
| `tasks` | read the task board, add a task |
| `notify` | show a notice in Trace (and a desktop alert) |

A call outside the declared permissions is refused. Turning a plugin off stops its programs and makes its address stop
working at once.

## 4. Not in the first version

- Plugin panes drawn over the grid (herdr's overlay and popup), and pages a plugin draws itself in the window (HTML). A
  plugin's way into the window is a tile.
- Link handlers (opening a kind of link with a plugin).
- Plugins on the phone, apart from their tiles.
- Sandboxing. Like herdr, a plugin runs as you; the safeguards are the preview, the declared permissions for the API,
  and turning it off.

## 5. Where it shows

The existing **Skills & plugins** page (Agent setup menu), which lists the CLIs' own skills and plugins, gets a **Trace plugins** section with three parts (the owner's choice):
- **Installed.** Each plugin with its version, an on/off switch, Update, Uninstall, its last runs and its log.
- **Install from GitHub.** A field for `owner/repo` or `owner/repo/folder`, with an optional branch, tag or commit.
- **Browse.** The list in section 8.

**Link a folder** installs a plugin from a folder on this computer, for someone writing one. It is read in place, and
changes take effect on the next run.

## 6. Installing and updating

1. **Fetch.** Trace clones the repository with the computer's own `git` (a shallow clone of the chosen branch, tag or
   commit) into a temporary folder. Private repositories work too (the owner's choice): Git uses the sign-in the computer
   already has (Git Credential Manager, or `gh auth setup-git`), and Trace never sees or stores a token.
2. **Preview, before anything runs:**
   - the manifest, and the exact commit;
   - every command the plugin may run (build steps, actions, hooks, tiles), each as a full argument list;
   - its permissions, in plain words;
   - the files in its folder, with links to open them in Files.
   The preview says, in a sentence, that the plugin runs as you and is not reviewed by anyone.
3. **Install,** only after **Install** in that preview. Trace runs the build steps (shown live, stopped after 10
   minutes), then moves the folder to `plugins/<id>/<commit>/` and turns the plugin on.
4. **Update** fetches the same branch or tag again. If the commit has changed, the preview shows what changed: commands
   added or removed, new permissions, and the commit range on GitHub. Nothing changes until you confirm.
   - Running programs keep the version they started with; the next run uses the new one, as in herdr.
   - Trace checks for updates once a day and says so on the Plugins page. It never updates a plugin without you.
5. **Uninstall** stops the plugin's programs and removes its versions. Its `data/` folder is kept, unless you also tick
   **Remove its data**.

All of this runs in the main process. The window only asks, and every step that runs code is confirmed in a system
dialog, as verification profiles and event hooks are now.

## 7. Logs and failures

Each run of an action, hook or build is recorded with:
- when it ran, and what started it;
- its exit code;
- the last 64 KB of its output.

The plugin's page keeps its last 50 runs. A plugin that fails three times in a row, or cannot start, shows a warning on
the Plugins page and in Needs you. Nothing is retried on its own.

## 8. The list to browse

Repositories on GitHub tagged with the topic **`trace-plugin`** that hold a readable `trace-plugin.json`, found with
GitHub's public search:
- Trace calls it without signing in, so at most ten searches a minute. The list is kept for an hour.
- Each repository shows its name, owner, description, stars and last push, with each plugin in it.
- **Install** goes through the same preview (section 6).

A banner says the list is not reviewed: being listed means only that a repository tagged itself. To be listed, a
plugin's author adds the topic. Trace keeps no list of its own.

## 9. Order of work

| Release | Contents |
|---|---|
| 1.35.0 | Manifest and its checks; Link a folder; actions; the wider event hooks; the plugin API and `trace` helper (channels, tasks, notify); the Plugins page (Installed). |
| 1.36.0 | Plugin tiles (+ Channel lists each tile; saved in the workspace; on the phone as terminals). Built as a Terminal channel whose config names `plugin: { id, tile }`; `Plugins.tile()` resolves the command. |
| 1.37.0 | Install and update from GitHub with the preview; Uninstall; the daily update check; Browse. `electron/services/plugins/github.ts` (git with no shell or terminal prompt; input checked first), `Plugins.fetchPreview/install/checkUpdates`. Versions are kept in `plugins/<id>/<commit>/`, with the one before kept for programs still running it (herdr's install lease). Its `.git` is removed when Windows allows it. |

Each release gets unit tests (the manifest checks, permissions, the install steps against a local Git repository) and
a smoke test with a sample plugin in `scripts/fixtures/plugins/` that uses every part it delivers. Then comes the
background runner (planned separately).

## 10. The owner's answers (2026-11-24)

1. **Permissions:** `channels.control` (start, stop and add channels) is in the first version.
2. **Where:** in the existing Skills & plugins page.
3. **Topic:** `trace-plugin`.
4. **Private repositories:** yes, through the sign-in Git already has on the computer.
