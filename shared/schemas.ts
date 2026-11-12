import { z } from 'zod';

const identifier = z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/);
// Brackets allow Claude Code context suffixes such as `sonnet[1m]`; the leading character still prevents flags.
export const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/[\]-]*$/;
export const MAX_MODEL_LENGTH = 160;
/** Channels (CLI sessions) a workspace can hold; each one runs its own CLI process. */
export const MAX_CHANNELS = 8;
export const MAX_TOKEN_SETTING = 1_000_000;
/** Returns the model text to store, or null when it would make the saved workspace invalid. */
export function modelValue(value: string): string | null {
  const model = value.trim();
  return model === '' || (model.length <= MAX_MODEL_LENGTH && MODEL_PATTERN.test(model)) ? model : null;
}
const model = z.string().max(MAX_MODEL_LENGTH).refine((value) => value === '' || MODEL_PATTERN.test(value), 'Use a model identifier, or leave blank for the CLI default.');
const tokens = z.number().int().min(0).max(MAX_TOKEN_SETTING).nullable();
export const permissionLevelSchema = z.enum(['ask', 'edits', 'full']);
/** A channel with no permission setting: agents edit files without asking (the person's choice in 1.16.3). */
export const DEFAULT_PERMISSIONS = 'edits' as const;
export const permissionLevel = (config: { permissions?: 'ask' | 'edits' | 'full' }) => config.permissions ?? DEFAULT_PERMISSIONS;
const permissions = permissionLevelSchema.optional();
const chatImage = z.object({ mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']), data: z.string().min(1).max(14 * 1024 * 1024).regex(/^[A-Za-z0-9+/=]+$/) }).strict();
/**
 * A Round Table finding as saved with its table and passed back when the table opens again (shared/findings.ts). The
 * fields Trace 1.20's Gemini seat wrote (source, gemini, geminiNote, duplicateOf) are still read, never written.
 */
export const findingSchema = z.object({ id: z.string().regex(/^F\d{1,3}$/), severity: z.enum(['high', 'medium', 'low']), evidence: z.string().max(500), text: z.string().min(1).max(500), status: z.enum(['open', 'fixed', 'declined', 'verified']), response: z.string().max(500), check: z.string().max(500), reviewedAt: z.string().max(64).nullable(), changedAt: z.string().max(64).nullable(), filesChanged: z.boolean().optional(), round: z.number().int().min(0).max(5), at: z.iso.datetime(), source: z.literal('gemini').optional(), gemini: z.enum(['agree', 'dispute']).optional(), geminiNote: z.string().max(500).optional(), duplicateOf: z.string().regex(/^F\d{1,3}$/).optional() }).strict();
/** What a table keeps across restarts: its findings, and the text of a message that was waiting for the agents (images are not kept). */
const chainSteps = ['idle', 'planning', 'challenging', 'plan-responding', 'plan-review', 'implementing', 'reviewing', 'fixing', 'final', 'final-fixing', 'done', 'needs-you', 'stopped'] as const;
const chainStep = z.enum(chainSteps);
/** Steps only Trace 1.20 saved (its Gemini seat's review and comparison): read on load, then made 'reviewing'. */
export const LEGACY_CHAIN_STEPS = ['second-reviewing', 'comparing'] as const;
const legacyChainStep = z.enum([...chainSteps, ...LEGACY_CHAIN_STEPS]);
const planChallenge = z.object({ id: z.string().regex(/^C\d{1,3}$/), severity: z.enum(['high', 'medium', 'low']), text: z.string().min(1).max(500), answer: z.enum(['accepted', 'rejected']).optional(), reason: z.string().max(500).optional() }).strict();
/** A hierarchy table's work, saved with it (shared/chat.ts SavedChain). */
const chainFields = { task: z.string().max(200_000), plan: z.string().max(200_000), report: z.string().max(200_000), reviewRound: z.number().int().min(0).max(10), finalRound: z.number().int().min(0).max(10), verdict: z.enum(['approved', 'changes']).nullable(), note: z.string().max(20_000), challenges: z.array(planChallenge).max(50).optional(), challenged: z.literal(true).optional() };
export const savedChainSchema = z.object({ step: chainStep, stoppedAt: chainStep.optional(), blocked: z.enum(['planner', 'builder', 'reviewer']).optional(), ...chainFields }).strict();
/** A chain as Trace 1.20 saved it, with its Gemini seat's steps and flags (loading only; migrateWorkspace drops them). */
const legacyChainSchema = z.object({ step: legacyChainStep, stoppedAt: legacyChainStep.optional(), blocked: z.enum(['planner', 'builder', 'reviewer', 'challenger']).optional(), ...chainFields, geminiReviewed: z.literal(true).optional(), compared: z.literal(true).optional(), firstFinding: z.number().int().min(0).max(50).optional() }).strict();
const tableRecord = { findings: z.array(findingSchema).max(50).optional(), waiting: z.string().max(200_000).optional(), waitingImages: z.array(chatImage).max(10).refine((images) => images.reduce((sum, image) => sum + image.data.length, 0) <= 6_000_000, 'Too much image data to keep.').optional() };
/** A shared memory project key, as memory folders are named (memory.ts projectSchema). */
export const memoryKeySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const memoryKey = memoryKeySchema.optional();
export const engineConfigSchema = z.discriminatedUnion('engine', [
  z.object({ engine: z.literal('claude'), chat: z.boolean().optional(), resumeId: z.uuid().optional(), accountProfileId: z.uuid().optional(), permissions, chrome: z.boolean().optional(), memoryKey, model, thinking: z.object({ budget_tokens: tokens }).strict(), tokenLimits: z.object({ maxOutputTokens: tokens, maxSessionTokens: tokens }).strict() }).strict(),
  z.object({ engine: z.literal('codex'), chat: z.boolean().optional(), resumeId: z.uuid().optional(), permissions, memoryKey, model, reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).nullable() }).strict(),
]);
const shellConfigSchema = z.object({ engine: z.literal('shell') }).strict();
/** Every channel type: the agents, and a plain terminal, which takes no settings. */
export const channelConfigSchema = z.discriminatedUnion('engine', [...engineConfigSchema.options, shellConfigSchema]);
/**
 * A Gemini CLI channel or hidden Gemini seat (`chat`) as Trace 1.19 and 1.20 saved it. Loading only: migrateWorkspace
 * removes it, and nothing can start one.
 */
const legacyGeminiConfigSchema = z.object({ engine: z.literal('gemini'), model: z.string().max(MAX_MODEL_LENGTH), permissions, chat: z.boolean().optional() }).strict();
const legacyChannelConfigSchema = z.discriminatedUnion('engine', [...engineConfigSchema.options, legacyGeminiConfigSchema, shellConfigSchema]);
export const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) };
export const runReferenceSchema = z.object({ sessionId: identifier, runId: z.string().uuid() }).strict();
export const startSessionSchema = z.object({ sessionId: identifier, cwd: z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Invalid directory path.'), config: channelConfigSchema, ...dimensions }).strict();
export const writeSessionSchema = runReferenceSchema.extend({ data: z.string().max(64 * 1024) }).strict();
export const resizeSessionSchema = runReferenceSchema.extend(dimensions).strict();
export const ackSessionSchema = runReferenceSchema.extend({ bytes: z.number().int().min(0).max(64 * 1024 * 1024) }).strict();

const directory = z.string().max(4096).refine((value) => !value.includes('\0'), 'Invalid directory path.');
const binding = z.discriminatedUnion('mode', [z.object({ mode: z.literal('workspace') }).strict(), z.object({ mode: z.literal('independent'), cwd: directory }).strict()]);
const sessionFields = {
  id: identifier, title: z.string().min(1).max(160), binding,
  budget: z.object({ tokens: z.number().int().min(1).max(100000000).nullable(), costUSD: z.number().positive().max(100000).nullable(), contextPercent: z.number().int().min(1).max(100) }).strict().optional(),
  preparedRequest: z.object({ prompt: z.string().min(1).max(4000), label: z.string().min(1).max(100) }).strict().optional(),
  createdAt: z.string().datetime(),
};
const tableFields = { partner: identifier, driver: z.enum(['claude', 'codex']), rounds: z.number().int().min(0).max(5), ...tableRecord, kind: z.literal('hierarchy').optional(), planner: identifier.optional() };
const tileSchema = z.object({
  sessionId: identifier, x: z.number().int().min(0).max(11), y: z.number().int().min(0).max(1000),
  w: z.number().int().min(3).max(12), h: z.number().int().min(10).max(1000),
  minW: z.number().int().min(3).max(12), minH: z.number().int().min(10).max(1000),
}).strict();
const workspaceShape = { version: z.literal(1), rootDirectory: directory.nullable(), tiles: z.array(tileSchema).min(1).max(MAX_CHANNELS), layoutMode: z.enum(['columns', 'rows', 'grid']), focusedSessionId: identifier.nullable() };
/** Each channel has one tile (a Round Table's hidden seats have none), the focused one exists, and tiles fit and do not overlap. */
function checkLayout(workspace: { sessions: { id: string; roundTable?: { partner: string; planner?: string; challenger?: string } }[]; tiles: z.infer<typeof tileSchema>[]; focusedSessionId: string | null }, context: z.RefinementCtx) {
  const ids = new Set(workspace.sessions.map((session) => session.id));
  const tileIds = new Set(workspace.tiles.map((tile) => tile.sessionId));
  /** A Round Table's partner runs inside its lead's tile, so it has none (1.16.0 and 1.16.1 saved one; hydrate drops it). */
  const seated = new Set(workspace.sessions.flatMap((session) => session.roundTable ? [session.roundTable.partner, session.roundTable.planner, session.roundTable.challenger].filter((id): id is string => Boolean(id) && id !== session.id && ids.has(id!)) : []));
  if (ids.size !== workspace.sessions.length || tileIds.size !== workspace.tiles.length || [...tileIds].some((id) => !ids.has(id)) || [...ids].some((id) => !seated.has(id) && !tileIds.has(id))) context.addIssue({ code: 'custom', message: 'Each channel must have exactly one grid tile.' });
  if (workspace.focusedSessionId && !ids.has(workspace.focusedSessionId)) context.addIssue({ code: 'custom', message: 'The focused session does not exist.' });
  for (const tile of workspace.tiles) if (tile.x + tile.w > 12 || tile.w < tile.minW || tile.h < tile.minH) context.addIssue({ code: 'custom', message: 'Invalid grid dimensions.' });
  workspace.tiles.forEach((tile, index) => {
    if (workspace.tiles.slice(index + 1).some((other) => tile.x < other.x + other.w && tile.x + tile.w > other.x && tile.y < other.y + other.h && tile.y + tile.h > other.y)) context.addIssue({ code: 'custom', message: 'Grid tiles must not overlap.' });
  });
}
export const savedWorkspaceSchema = z.object({
  ...workspaceShape,
  sessions: z.array(z.object({ ...sessionFields, config: channelConfigSchema, roundTable: z.object({ ...tableFields, chain: savedChainSchema.optional() }).strict().optional() }).strict()).min(1).max(MAX_CHANNELS),
}).strict().superRefine(checkLayout);
/**
 * A workspace as any Trace since 1.16 saved it, for loading only: 1.19 and 1.20 could save Gemini channels, a hierarchy
 * table's Gemini seat (`challenger`) and its chain steps. migrateWorkspace (shared/workspace-migration.ts) turns it into
 * a SavedWorkspace; nothing is saved in this shape.
 */
export const legacyWorkspaceSchema = z.object({
  ...workspaceShape,
  sessions: z.array(z.object({ ...sessionFields, config: legacyChannelConfigSchema, roundTable: z.object({ ...tableFields, challenger: identifier.optional(), chain: legacyChainSchema.optional() }).strict().optional() }).strict()).min(1).max(MAX_CHANNELS),
}).strict().superRefine(checkLayout);
export type LegacySavedWorkspace = z.infer<typeof legacyWorkspaceSchema>;
export const readRunLogSchema = z.object({ runId: z.string().uuid() }).strict();
export const finishWorkspaceFlushSchema = z.object({ requestId: z.string().uuid(), workspace: savedWorkspaceSchema.optional() }).strict();

export const openRepositorySchema = z.object({ directory: directory.min(1) }).strict();
export const repositoryReferenceSchema = z.object({ repositoryId: z.string().uuid() }).strict();
export const repositoryPathSchema = repositoryReferenceSchema.extend({ path: directory }).strict();
export const gitDiffSchema = repositoryPathSchema.extend({ path: directory.min(1), area: z.enum(['working', 'staged', 'untracked']) }).strict();

/** Requests from the window to a chat run. Images are base64 (Claude's limit is about 5 MB each; 10 per message). */
export const chatRequestSchema = z.discriminatedUnion('action', [
  runReferenceSchema.extend({ action: z.literal('send'), text: z.string().max(200_000), images: z.array(chatImage).max(10) }).strict(),
  runReferenceSchema.extend({ action: z.literal('answer'), requestId: z.string().min(1).max(200), allow: z.boolean(), allowEdits: z.boolean().optional() }).strict(),
  runReferenceSchema.extend({ action: z.literal('interrupt') }).strict(),
  runReferenceSchema.extend({ action: z.literal('permissions'), level: permissionLevelSchema }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-open'), partner: runReferenceSchema, driver: z.enum(['claude', 'codex']), rounds: z.number().int().min(0).max(5), ...tableRecord, kind: z.literal('hierarchy').optional(), planner: runReferenceSchema.optional(), chain: savedChainSchema.optional(), rejoin: z.literal(true).optional() }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-plan'), approve: z.boolean(), note: z.string().max(20_000) }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-continue'), skipChallenge: z.boolean().optional() }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-waiting'), send: z.boolean() }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-send'), text: z.string().max(200_000), images: z.array(chatImage).max(10) }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-driver'), driver: z.enum(['claude', 'codex']) }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-rounds'), rounds: z.number().int().min(0).max(5) }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-stop') }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-close') }).strict(),
]);
