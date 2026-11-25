/**
 * Safe actions (1.39.0): commands a Claude Code channel at Allow edits may run without asking, as Claude Code permission
 * rules passed in its --settings (`Bash(prefix:*)` matches a command starting with prefix). They read the repository or
 * run the project's own checks and build, which Trace's automatic checks run anyway; edits were already allowed at this
 * level, and anything else (installing, deleting, pushing, the network) still asks. Not at Ask, where the person chose
 * to be asked; Full access needs none. Codex at Allow edits already runs commands in the project without asking.
 */
export const SAFE_COMMANDS: readonly string[] = [
  'git status', 'git diff', 'git log', 'git show', 'pwd', 'ls',
  'npm test', 'npm run test', 'npm run typecheck', 'npm run type-check', 'npm run lint', 'npm run build',
  'pnpm test', 'pnpm run test', 'pnpm run typecheck', 'pnpm run lint', 'pnpm run build',
  'yarn test', 'yarn typecheck', 'yarn lint', 'yarn build',
  'npx tsc --noEmit', 'npx vitest run', 'npx jest',
  'cargo test', 'cargo check', 'cargo build', 'go test', 'go vet', 'go build', 'pytest', 'python -m pytest', 'dotnet test', 'dotnet build',
];
/**
 * Gemini's (agy) rules match a command exactly: `command(git status)` lets `git status` run, not `git status --short`
 * (checked with agy 1.5.15, which also ignores a word prefix or `*`). So the everyday forms are listed as they are typed.
 */
export const GEMINI_SAFE_COMMANDS: readonly string[] = [
  'git status', 'git status --short', 'git diff', 'git diff --stat', 'git log --oneline', 'pwd', 'ls',
  'npm test', 'npm run test', 'npm run typecheck', 'npm run type-check', 'npm run lint', 'npm run build',
  'pnpm test', 'pnpm run typecheck', 'pnpm run lint', 'pnpm run build', 'yarn test', 'yarn typecheck', 'yarn lint', 'yarn build',
  'npx tsc --noEmit', 'npx vitest run', 'cargo test', 'cargo check', 'cargo build', 'go test ./...', 'go vet ./...', 'go build ./...', 'pytest', 'python -m pytest', 'dotnet test', 'dotnet build',
];
/**
 * Gemini's session settings at Allow edits: the safe commands (`safe`, unless the person turned them off) and `allow`
 * (Trace's own tools) allowed, and the person's own saved rules kept (`own`, the `permissions` of agy's settings.json):
 * agy 1.5.15 used the session's allow list instead of the saved one, so the saved allow, deny and ask lists are repeated.
 */
export function geminiSafeSettings(own: unknown, allow: readonly string[] = [], safe = true): string {
  const saved = (name: string) => { const list = own && typeof own === 'object' ? (own as Record<string, unknown>)[name] : undefined; return Array.isArray(list) ? list.filter((rule): rule is string => typeof rule === 'string') : []; };
  const deny = saved('deny'); const ask = saved('ask');
  return JSON.stringify({ permissions: { allow: [...new Set([...saved('allow'), ...(safe ? GEMINI_SAFE_COMMANDS.map((command) => `command(${command})`) : []), ...allow])], ...(deny.length ? { deny } : {}), ...(ask.length ? { ask } : {}) } });
}
/**
 * Trace's channel and task tools that only look (1.33.2 for Codex): every agent runs them without asking, as reading a
 * file. Sending a message, adding or updating a task still asks.
 */
export const LOOK_ONLY_TOOLS: readonly string[] = ['list_channels', 'read_channel', 'wait_for_channel', 'list_tasks'];
/** Claude Code's permission rules for them (its MCP tools are named mcp__<server>__<tool>; Trace's server is trace-channels). */
export const claudeLookOnlyRules = () => LOOK_ONLY_TOOLS.map((tool) => `mcp__trace-channels__${tool}`);
/** The Claude Code permission rules for those commands. */
export const safeActionRules = () => SAFE_COMMANDS.map((command) => `Bash(${command}:*)`);
