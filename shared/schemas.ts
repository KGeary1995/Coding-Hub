import { z } from 'zod';
import { hiddenSeatIds } from './table-seats';
import { MAX_COMMAND, MAX_STEP, MAX_WAIT_SECONDS, MAX_WAIT_TEXT } from './start-order';
import { AGENT_ID, AGENT_MODEL, AGENT_RESUME_ID, MAX_AGENT_PROMPT } from './agent-definition';

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
const chainFields = { blockedSeat: identifier.optional(), turnSeat: identifier.optional(), task: z.string().max(410_000), plan: z.string().max(200_000), report: z.string().max(200_000), reviewRound: z.number().int().min(0).max(10), finalRound: z.number().int().min(0).max(10), verdict: z.enum(['approved', 'changes']).nullable(), note: z.string().max(20_000), challenges: z.array(planChallenge).max(50).optional(), challenged: z.literal(true).optional(), replan: z.string().max(20_000).optional(), revision: z.string().max(410_000).optional(), held: z.string().max(2_000).optional(), nextTasks: z.array(z.string().min(1).max(200_000)).max(10).optional(), images: z.array(chatImage).max(10).refine((images) => images.reduce((sum, image) => sum + image.data.length, 0) <= 6_000_000, 'Too much image data to keep.').optional() };
export const savedChainSchema = z.object({ step: chainStep, stoppedAt: chainStep.optional(), blocked: z.enum(['planner', 'builder', 'reviewer']).optional(), ...chainFields }).strict();
/** A chain as Trace 1.20 saved it, with its Gemini seat's steps and flags (loading only; migrateWorkspace drops them). */
const legacyChainSchema = z.object({ step: legacyChainStep, stoppedAt: legacyChainStep.optional(), blocked: z.enum(['planner', 'builder', 'reviewer', 'challenger']).optional(), ...chainFields, geminiReviewed: z.literal(true).optional(), compared: z.literal(true).optional(), firstFinding: z.number().int().min(0).max(50).optional() }).strict();
const tableRecord = { findings: z.array(findingSchema).max(50).optional(), waiting: z.string().max(200_000).optional(), waitingImages: z.array(chatImage).max(10).refine((images) => images.reduce((sum, image) => sum + image.data.length, 0) <= 6_000_000, 'Too much image data to keep.').optional() };
/** A shared memory project key, as memory folders are named (memory.ts projectSchema). */
export const memoryKeySchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/);
const memoryKey = memoryKeySchema.optional();
/** A Gemini CLI channel (1.19 saved the same fields, so its channels load as they are). */
const geminiFields = { engine: z.literal('gemini'), resumeId: z.uuid().optional(), permissions, model };
/** `chat`: a Round Table seat (1.20, and again from 1.28). */
const geminiConfigSchema = z.object({ ...geminiFields, chat: z.boolean().optional() }).strict();
/** Claude Code and Codex, the engines with chats, memory and Round Table seats. */
const chatEngineOptions = [
  z.object({ engine: z.literal('claude'), chat: z.boolean().optional(), resumeId: z.uuid().optional(), accountProfileId: z.uuid().optional(), permissions, chrome: z.boolean().optional(), memoryKey, model, thinking: z.object({ budget_tokens: tokens }).strict(), tokenLimits: z.object({ maxOutputTokens: tokens, maxSessionTokens: tokens }).strict() }).strict(),
  z.object({ engine: z.literal('codex'), chat: z.boolean().optional(), resumeId: z.uuid().optional(), permissions, memoryKey, model, reasoningEffort: z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/).nullable() }).strict(),
] as const;
export const engineConfigSchema = z.discriminatedUnion('engine', [...chatEngineOptions, geminiConfigSchema]);
/** A custom agent's channel (docs/custom-agents.md): it names its definition, never a program. */
const customConfigSchema = z.object({ engine: z.literal('custom'), agentId: z.string().regex(AGENT_ID), model: z.string().max(120).refine((value) => value === '' || AGENT_MODEL.test(value), 'Use a model name, or leave blank for the programâ€™s default.'), permissions, resumeId: z.string().regex(AGENT_RESUME_ID).optional(), chat: z.boolean().optional() }).strict();
// A plugin tile names its plugin and tile by the manifest's own id rules (electron/services/plugins/manifest.ts).
const shellConfigSchema = z.object({ engine: z.literal('shell'), plugin: z.object({ id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/), tile: z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/) }).strict().optional() }).strict();
/** Every channel type: the agents, and a plain terminal, which takes no settings. */
export const channelConfigSchema = z.discriminatedUnion('engine', [...engineConfigSchema.options, customConfigSchema, shellConfigSchema]);
/**
 * A Gemini channel, or Trace 1.20's hidden Gemini seat at a hierarchy table (`chat`). Loading only: migrateWorkspace
 * removes the seats, and nothing can start one.
 */
const legacyGeminiConfigSchema = z.object({ ...geminiFields, chat: z.boolean().optional() }).strict();
const legacyChannelConfigSchema = z.discriminatedUnion('engine', [...chatEngineOptions, legacyGeminiConfigSchema, customConfigSchema, shellConfigSchema]);
export const dimensions = { cols: z.number().int().min(2).max(500), rows: z.number().int().min(1).max(300) };
export const runReferenceSchema = z.object({ sessionId: identifier, runId: z.string().uuid() }).strict();
export const startSessionSchema = z.object({ sessionId: identifier, cwd: z.string().min(1).max(4096).refine((value) => !value.includes('\0'), 'Invalid folder path.'), config: channelConfigSchema, ...dimensions, firstRequest: z.string().min(1).max(MAX_AGENT_PROMPT).refine((value) => !value.includes('\0')).optional() }).strict();
export const writeSessionSchema = runReferenceSchema.extend({ data: z.string().max(64 * 1024) }).strict();
export const resizeSessionSchema = runReferenceSchema.extend(dimensions).strict();
export const ackSessionSchema = runReferenceSchema.extend({ bytes: z.number().int().min(0).max(64 * 1024 * 1024) }).strict();

const directory = z.string().max(4096).refine((value) => !value.includes('\0'), 'Invalid folder path.');
const binding = z.discriminatedUnion('mode', [z.object({ mode: z.literal('workspace') }).strict(), z.object({ mode: z.literal('independent'), cwd: directory }).strict()]);
const sessionFields = {
  id: identifier, title: z.string().min(1).max(160), binding,
  budget: z.object({ tokens: z.number().int().min(1).max(100000000).nullable(), costUSD: z.number().positive().max(100000).nullable(), contextPercent: z.number().int().min(1).max(100) }).strict().optional(),
  preparedRequest: z.object({ prompt: z.string().min(1).max(4000), label: z.string().min(1).max(100) }).strict().optional(),
  startup: z.object({ order: z.number().int().min(1).max(MAX_STEP), command: z.string().min(1).max(MAX_COMMAND).optional(), prompt: z.string().min(1).max(4000).optional(), waitFor: z.string().min(1).max(MAX_WAIT_TEXT).optional(), waitSeconds: z.number().int().min(5).max(MAX_WAIT_SECONDS).optional() }).strict().optional(),
  createdAt: z.string().datetime(),
};
const seatDuty = z.enum(['plan', 'challenge', 'build', 'review', 'final']);
/** What the person sets for a Round Table seat (shared/table-seats.ts SeatSettings); the limits are MAX_SEAT_NAME and MAX_SEAT_INSTRUCTIONS there. */
const seatSettings = { name: z.string().min(1).max(40).optional(), instructions: z.string().min(1).max(4000).optional(), duties: z.array(seatDuty).min(1).max(5).optional() };
const savedSeat = z.object({ session: identifier, ...seatSettings }).strict();
const seatReference = runReferenceSchema.extend(seatSettings).strict();
/** A table preset (shared/table-seats.ts TablePreset), kept in the preferences. Whether its seats make a table (checkSeats) is checked where it is used. */
export const tablePresetSchema = z.object({ id: identifier, name: z.string().min(1).max(60), kind: z.enum(['discussion', 'hierarchy']), rounds: z.number().int().min(0).max(5), driver: z.number().int().min(0).max(MAX_CHANNELS - 1).optional(), seats: z.array(z.object({ engine: z.enum(['claude', 'codex', 'gemini', 'custom']), model, agent: z.string().regex(AGENT_ID).optional(), ...seatSettings }).strict().refine((seat) => (seat.engine === 'custom') === Boolean(seat.agent), 'A custom agent’s seat names its agent.')).min(2).max(MAX_CHANNELS) }).strict();
const tableFields = { seats: z.array(savedSeat).min(2).max(MAX_CHANNELS).optional(), driverSeat: identifier.optional(), partner: identifier, driver: z.enum(['claude', 'codex', 'gemini', 'custom']), rounds: z.number().int().min(0).max(5), ...tableRecord, kind: z.literal('hierarchy').optional(), planner: identifier.optional() };
const tileSchema = z.object({
  sessionId: identifier, x: z.number().int().min(0).max(11), y: z.number().int().min(0).max(1000),
  w: z.number().int().min(3).max(12), h: z.number().int().min(10).max(1000),
  minW: z.number().int().min(3).max(12), minH: z.number().int().min(10).max(1000),
}).strict();
const workspaceShape = { version: z.literal(1), rootDirectory: directory.nullable(), tiles: z.array(tileSchema).min(1).max(MAX_CHANNELS), layoutMode: z.enum(['columns', 'rows', 'grid']), focusedSessionId: identifier.nullable() };
/** Each channel has one tile (a Round Table's hidden seats have none), the focused one exists, and tiles fit and do not overlap. */
function checkLayout(workspace: { sessions: { id: string; roundTable?: { partner: string; planner?: string; challenger?: string; seats?: { session: string }[] } }[]; tiles: z.infer<typeof tileSchema>[]; focusedSessionId: string | null }, context: z.RefinementCtx) {
  const ids = new Set(workspace.sessions.map((session) => session.id));
  const tileIds = new Set(workspace.tiles.map((tile) => tile.sessionId));
  /** A Round Table's partner runs inside its lead's tile, so it has none (1.16.0 and 1.16.1 saved one; hydrate drops it). */
  const seated = new Set(workspace.sessions.flatMap((session) => session.roundTable ? hiddenSeatIds(session.roundTable, session.id).filter((id) => ids.has(id)) : []));
  if (ids.size !== workspace.sessions.length || tileIds.size !== workspace.tiles.length || [...tileIds].some((id) => !ids.has(id)) || [...ids].some((id) => !seated.has(id) && !tileIds.has(id))) context.addIssue({ code: 'custom', message: 'Each channel must have exactly one grid tile.' });
  if (workspace.focusedSessionId && !ids.has(workspace.focusedSessionId)) context.addIssue({ code: 'custom', message: 'The focused channel does not exist.' });
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
/** The window's report on itself (shared/ipc.ts WindowHealthReport); `detail` is a short label, never page content. */
export const windowHealthSchema = z.object({ kind: z.enum(['long-task', 'stall', 'context-lost', 'context-restored']), ms: z.number().int().min(0).max(3_600_000).optional(), detail: z.string().max(60).regex(/^[\w .:/-]*$/).optional() }).strict();
/** A chat link the window asks the host to open in the browser. */
export const openLinkSchema = z.object({ action: z.literal('flow-open-link'), url: z.string().min(1).max(4096) }).strict();
/** The address to open for a link, or why it is refused: only web links (http, https), never file:, javascript: and the like. */
export function webLink(value: string): { href: string } | { refused: 'invalid' | 'scheme' } {
  let url: URL; try { url = new URL(value); } catch { return { refused: 'invalid' }; }
  return url.protocol === 'http:' || url.protocol === 'https:' ? { href: url.href } : { refused: 'scheme' };
}

export const openRepositorySchema = z.object({ directory: directory.min(1) }).strict();
export const repositoryReferenceSchema = z.object({ repositoryId: z.string().uuid() }).strict();
export const repositoryPathSchema = repositoryReferenceSchema.extend({ path: directory }).strict();
export const gitDiffSchema = repositoryPathSchema.extend({ path: directory.min(1), area: z.enum(['working', 'staged', 'untracked']) }).strict();
/** A full commit id (SHA-1 or SHA-256), never a ref or a revision expression: Git gets nothing it could read as an option. */
export const gitCommitSchema = repositoryReferenceSchema.extend({ sha: z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/) }).strict();

/** Requests from the window to a chat run. Images are base64 (Claude's limit is about 5 MB each; 10 per message). */
export const chatRequestSchema = z.discriminatedUnion('action', [
  runReferenceSchema.extend({ action: z.literal('send'), text: z.string().max(200_000), images: z.array(chatImage).max(10) }).strict(),
  runReferenceSchema.extend({ action: z.literal('answer'), requestId: z.string().min(1).max(200), allow: z.boolean(), allowEdits: z.boolean().optional() }).strict(),
  runReferenceSchema.extend({ action: z.literal('interrupt') }).strict(),
  runReferenceSchema.extend({ action: z.literal('permissions'), level: permissionLevelSchema }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-open'), partner: runReferenceSchema, driver: z.enum(['claude', 'codex', 'gemini', 'custom']), rounds: z.number().int().min(0).max(5), ...tableRecord, kind: z.literal('hierarchy').optional(), planner: runReferenceSchema.optional(), chain: savedChainSchema.optional(), rejoin: z.literal(true).optional(), seats: z.array(seatReference).min(2).max(MAX_CHANNELS).optional(), driverSeat: identifier.optional() }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-seats'), seats: z.array(seatReference).min(2).max(MAX_CHANNELS), driverSeat: identifier.optional() }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-plan'), approve: z.boolean(), note: z.string().max(20_000) }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-continue'), skipChallenge: z.boolean().optional() }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-review-again') }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-waiting'), send: z.boolean() }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-next-drop'), index: z.number().int().min(0).max(9), head: z.string().min(1).max(200) }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-send'), text: z.string().max(200_000), images: z.array(chatImage).max(10) }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-driver'), driver: z.enum(['claude', 'codex', 'gemini', 'custom']), seat: identifier.optional() }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-rounds'), rounds: z.number().int().min(0).max(5) }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-stop') }).strict(),
  runReferenceSchema.extend({ action: z.literal('table-close') }).strict(),
]);
