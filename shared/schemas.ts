import { z } from 'zod';

const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
const model = z.string().max(160).refine((value) => value === '' || /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(value), 'Use a model identifier, or leave blank for the CLI default.');
const tokens = z.number().int().min(0).max(1_000_000).nullable();
export const engineConfigSchema = z.discriminatedUnion('engine', [
  z.object({ engine: z.literal('claude'), resumeId: z.uuid().optional(), accountProfileId: z.uuid().optional(), model, thinking: z.object({ budget_tokens: tokens }).strict(), tokenLimits: z.object({ maxOutputTokens: tokens, maxSessionTokens: tokens }).strict() }).strict(),
  z.object({ engine: z.literal('codex'), resumeId: z.uuid().optional(), model, reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).nullable() }).strict(),
]);
export const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) };
export const runReferenceSchema = z.object({ sessionId: identifier, runId: z.string().uuid() }).strict();
export const startSessionSchema = z.object({ sessionId: identifier, cwd: z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Invalid directory path.'), config: engineConfigSchema, ...dimensions }).strict();
export const writeSessionSchema = runReferenceSchema.extend({ data: z.string().max(64 * 1024) }).strict();
export const resizeSessionSchema = runReferenceSchema.extend(dimensions).strict();

const directory = z.string().max(4096).refine((value) => !value.includes('\0'), 'Invalid directory path.');
export const savedWorkspaceSchema = z.object({
  version: z.literal(1),
  rootDirectory: directory.nullable(),
  sessions: z.array(z.object({
    id: identifier, title: z.string().min(1).max(160), config: engineConfigSchema,
    binding: z.discriminatedUnion('mode', [z.object({ mode: z.literal('workspace') }).strict(), z.object({ mode: z.literal('independent'), cwd: directory }).strict()]),
    budget: z.object({ tokens: z.number().int().min(1).max(100000000).nullable(), costUSD: z.number().positive().max(100000).nullable(), contextPercent: z.number().int().min(1).max(100) }).strict().optional(),
    preparedRequest: z.object({ prompt: z.string().min(1).max(4000), label: z.string().min(1).max(100) }).strict().optional(),
    createdAt: z.string().datetime(),
  }).strict()).min(2).max(4),
  tiles: z.array(z.object({
    sessionId: identifier, x: z.number().int().min(0).max(11), y: z.number().int().min(0).max(1000),
    w: z.number().int().min(3).max(12), h: z.number().int().min(10).max(1000),
    minW: z.number().int().min(3).max(12), minH: z.number().int().min(10).max(1000),
  }).strict()).min(2).max(4),
  layoutMode: z.enum(['columns', 'rows', 'grid']), focusedSessionId: identifier.nullable(),
}).strict().superRefine((workspace, context) => {
  const ids = new Set(workspace.sessions.map((session) => session.id));
  const tileIds = new Set(workspace.tiles.map((tile) => tile.sessionId));
  if (ids.size !== workspace.sessions.length || tileIds.size !== workspace.tiles.length || ids.size !== tileIds.size || [...tileIds].some((id) => !ids.has(id))) context.addIssue({ code: 'custom', message: 'Each session must have exactly one grid tile.' });
  if (workspace.focusedSessionId && !ids.has(workspace.focusedSessionId)) context.addIssue({ code: 'custom', message: 'The focused session does not exist.' });
  for (const tile of workspace.tiles) if (tile.x + tile.w > 12 || tile.w < tile.minW || tile.h < tile.minH) context.addIssue({ code: 'custom', message: 'Invalid grid dimensions.' });
  workspace.tiles.forEach((tile, index) => {
    if (workspace.tiles.slice(index + 1).some((other) => tile.x < other.x + other.w && tile.x + tile.w > other.x && tile.y < other.y + other.h && tile.y + tile.h > other.y)) context.addIssue({ code: 'custom', message: 'Grid tiles must not overlap.' });
  });
});
export const readRunLogSchema = z.object({ runId: z.string().uuid() }).strict();
export const finishWorkspaceFlushSchema = z.object({ requestId: z.string().uuid(), workspace: savedWorkspaceSchema.optional() }).strict();

export const openRepositorySchema = z.object({ directory: directory.min(1) }).strict();
export const repositoryReferenceSchema = z.object({ repositoryId: z.string().uuid() }).strict();
export const repositoryPathSchema = repositoryReferenceSchema.extend({ path: directory }).strict();
export const gitDiffSchema = repositoryPathSchema.extend({ path: directory.min(1), area: z.enum(['working', 'staged', 'untracked']) }).strict();
