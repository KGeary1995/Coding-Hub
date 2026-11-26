# Several projects open at once

Status: **draft for the owner to review** (2026-11-25). Nothing here is built.

## Problem

Trace has one project per workspace, and one workspace per computer.

**How the project is modelled today:**
- `Workspace.rootDirectory` and `SavedWorkspace.rootDirectory` (`shared/types.ts`) hold one folder.
- Storage keeps one workspace row: `CREATE TABLE workspace (id INTEGER PRIMARY KEY CHECK(id=1), ...)` in `WorkspaceStorage` (`electron/services/storage/workspace-storage.ts`).
- Trace runs one window and one instance (`new BrowserWindow`, `app.requestSingleInstanceLock()` in `electron/main.ts`).
- The renderer keeps the folder in `useWorkspaceStore` (`rootDirectory`, `setRootDirectory` in `src/state/workspace-store.ts`). Opening a project replaces it (`openProjectFolder` in `src/components/shell/Topbar.tsx`; `open()` in `src/components/ProjectsPanel.tsx`).

**What already works per channel (important):**
- Each channel has a `binding` (`WorkspaceBinding` in `shared/types.ts`): `{ mode: 'workspace' }` uses the root, `{ mode: 'independent', cwd }` uses its own folder. The tile's settings offer **Independent repository** (`SessionTile.tsx`).
- A channel's folder is resolved the same way in many places: `runningCwd ?? (independent ? binding.cwd : rootDirectory)`. Examples: `channelDirectory` (`src/state/channel-names.ts`), `use-native-host.ts`, `auto-handoff.ts`, `round-table.ts`, `main.ts` (`channelFolder` and others).
- Shared memory is already per folder: `AutoMemory` uses `chosenKey ?? projectMemoryKey(cwd)` (`electron/services/hub/auto-memory.ts`). The key comes from the Git origin (`projectMemoryKey`), so two channels in different repos already write to different memory.
- Tasks carry their own `directory` (`TasksPanel.tsx`, `electron/services/workbench/tasks.ts`); `tasks.json` is one global list.
- Runs record their own `cwd` (`runs` table in `workspace-storage.ts`).
- Changes can already pick a channel's folder (`choices` in `src/components/RepositoryPanel.tsx`).

So several projects can run today, but only as "one root plus independent channels". What still assumes one project:

| Where | What it assumes |
|---|---|
| `Topbar.tsx`, `StatusBar.tsx` | Show one project name from `rootDirectory` |
| `WorkspaceExplorer.tsx` | File tree opens only `rootDirectory` |
| `RepositoryPanel.tsx` | Default choice is "Workspace root" |
| `TasksPanel.tsx`, `ScheduledJobsCard.tsx`, `VerificationPanel.tsx`, `WorkflowCenter.tsx` | New items default to `rootDirectory` |
| `CommandMenu.tsx` | File search (`flow-search`) uses `rootDirectory` |
| `HubPanels.tsx` (MCP, memory panels) | Start from `rootDirectory`; the memory panel defaults its project to `'coding-hub'` |
| `chat/TableSetup.tsx` | `lead?.runningCwd ?? rootDirectory`: ignores an idle lead's independent folder |
| `main.ts` plugin context and `addTask` | Use `storage.load().rootDirectory` as "the project" |
| `workflows.ts` (templates) | Applying a template sets `workspace.rootDirectory = cwd` |
| `MAX_CHANNELS = 8` (`shared/schemas.ts`) | One limit across everything |

## Goals and non-goals

Goals:
- Open two or more projects and run channels in each at the same time.
- See at a glance which project each channel belongs to.
- Changes, Files, Tasks and search follow the project you are looking at.
- Keep saved workspaces from older versions loading unchanged.

Non-goals:
- Several Trace windows. One window stays.
- Raising the 8-channel limit.
- Changing memory keys. They already follow each channel's folder.

## Options

### A. Make the existing model visible (smallest)
Keep one `rootDirectory`. Treat independent channels as first-class: show each tile's project name, add a "recent projects" list to the folder picker, and let views follow the focused channel's folder.
- For: no schema or storage change. Small steps.
- Against: "the project" in the top bar stays one folder. Two projects are not equal.

### B. A list of projects in one workspace (recommended)
Add `projects: { id, directory }[]` and `activeProjectId` to the saved workspace. A channel binds to a project: `{ mode: 'project', projectId }`. The top bar's project button becomes a switcher. Views use the active project. The grid can filter by project, or show all.
- For: one storage row still; one window; matches how people talk about projects.
- For: `independent` bindings migrate cleanly to projects.
- Against: touches every place in the table above. Needs a saved-workspace migration (`shared/workspace-migration.ts`, `savedWorkspaceSchema` in `shared/schemas.ts`).

### C. One workspace per project, switched like tabs
Several saved workspaces, each with its own tiles and root. Channels in hidden workspaces keep running.
- For: each project keeps its own layout.
- Against: storage change (`CHECK(id=1)`), workspace flush and resume (`saveResume`, `loadWorkspace` in `main.ts`) become per workspace. The 8 channels are still shared, so hidden tabs eat the limit without being seen. Much larger.

## Recommendation

Do A first, then B. A fixes the places that ignore independent folders. Those fixes are needed in B anyway. B then makes projects a named list without a second storage design. Leave C unless per-project layouts turn out to matter.

## Step-by-step plan

1. **One folder resolver.** Replace the repeated `runningCwd ?? (independent ? cwd : rootDirectory)` with `channelDirectory` from `channel-names.ts` everywhere in `src/`. Fix `TableSetup.tsx` to use it.
   - Tests: `channel-names.test.ts` cases; a `TableSetup` test with an idle independent lead.
2. **Project name on each tile and status chip.** Show the folder's base name when it differs from the root.
   - Tests: component tests for `SessionTile` and `StatusBar`.
3. **Views follow the focused channel.** Changes, Files and the command menu search default to the focused channel's folder, with "Workspace root" still listed.
   - Tests: `RepositoryPanel` and `WorkspaceExplorer` tests with two folders.
4. **Recent projects.** A capped list (say 10) of folders opened, kept in the saved workspace or preferences (to decide). Shown in the top bar menu and in **+ Channel**.
   - Tests: store tests for add, dedupe, cap; schema test.
5. **Projects list (option B).** Add `projects` and `activeProjectId` to `SavedWorkspace`. Migrate: the root becomes project 1; each distinct independent folder becomes a project. Keep reading `rootDirectory` for older saves.
   - Tests: `workspace-migration` tests with the 1.20 fixture (`shared/workspace-120.fixture.ts`) and a save with independent channels; round-trip tests.
6. **Switcher and filter.** The top bar button lists projects; the grid can show one project or all.
   - Tests: store tests for filter and switch; a desktop smoke step that opens two projects.
7. **Host uses the channel's project.** Plugin context (`main.ts`), plugin `addTask`, templates (`workflows.ts`) take a project instead of `rootDirectory`.
   - Tests: `main`-level tests where they exist; `workflows` tests.
8. **Docs.** Update `docs/reference.md` (Workspace section) and `docs/architecture.md` (`storage.db` row).

## Risks

- **Older Traces reading a newer save.** Device sync carries project templates between computers (`device-sync.ts`), and a template holds a whole saved workspace (`templateSchema` in `workflows.ts` uses `savedWorkspaceSchema`). A template saved with `projects` could fail the schema on a computer running an older Trace. New fields must be optional, or templates must strip them.
- **Linked computers and the phone.** The phone shows a folder only for history items (`RemoteHistoryItem.folder`, `shared/remote.ts`), not for live channels as far as I found. The phone may show channels from two repos with no label.
- **Memory panel default.** `HubPanels.tsx` defaults to `'coding-hub'`. With several projects that default is more misleading.
- **Channel limit.** Eight channels across projects can feel small. That is a product choice, not a code limit to lift here.

## Open questions for the owner

1. Is "one window, a project switcher, one channel limit" the shape you want, or do you want per-project layouts (option C)?
2. Should the grid show all projects' channels at once, or only the active project's?
3. Should recent projects sync between computers? Folders differ per computer.
4. What should "the project" mean for plugins (`project` in plugin events) when several are open: the channel's folder, or the active one?
5. Should Tasks be filtered by the active project by default?

Things I could not determine:
- Whether the phone's live channel list shows a folder anywhere; I searched `phone/main.ts`, `phone/screens.tsx` and `phone/api.ts` for `folder`, `cwd` and `rootDirectory` and found only history items.
- Whether backups restored on another computer (`backups.ts` converts `rootDirectory` and similar keys) need changes for a `projects` list; I read only that one line.
