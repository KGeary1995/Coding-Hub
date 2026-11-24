import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { HubError } from '../cli/engine-adapter';

/**
 * A Trace plugin's manifest, trace-plugin.json (docs/plugins.md, section 2). Read whole or refused whole, with why:
 * Trace never runs part of a manifest it could not read.
 */
export const PLUGIN_EVENTS = ['channel.needs-you', 'channel.turn-ended', 'channel.failed', 'channel.started', 'channel.stopped', 'task.ready-for-review', 'worktree.created', 'trace.started'] as const;
export const PLUGIN_PERMISSIONS = ['channels.read', 'channels.send', 'channels.control', 'tasks', 'notify'] as const;
export const PLATFORMS = ['windows', 'mac', 'linux'] as const;
const localId = z.string().regex(/^[A-Za-z0-9:_-]{1,64}$/, 'an id is letters, digits, colon, underscore and hyphen');
const command = z.array(z.string().min(1).max(1000).refine((value) => !value.includes('\0'))).min(1).max(40);
const platforms = z.array(z.enum(PLATFORMS)).min(1).optional();
const manifestSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/, 'the id is letters, digits, dot, colon, underscore and hyphen'),
  name: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(40),
  minTrace: z.string().regex(/^\d+\.\d+\.\d+$/, 'minTrace is a version such as 1.35.0'),
  description: z.string().max(500).optional(),
  platforms,
  permissions: z.array(z.enum(PLUGIN_PERMISSIONS)).max(PLUGIN_PERMISSIONS.length).default([]),
  build: z.array(z.object({ command, platforms }).strict()).max(10).default([]),
  actions: z.array(z.object({ id: localId, title: z.string().trim().min(1).max(80), context: z.enum(['workspace', 'channel', 'repository']).default('workspace'), command, platforms }).strict()).max(30).default([]),
  events: z.array(z.object({ on: z.enum(PLUGIN_EVENTS), command, platforms }).strict()).max(30).default([]),
  tiles: z.array(z.object({ id: localId, title: z.string().trim().min(1).max(80), command, platforms }).strict()).max(10).default([]),
}).strict();
export type PluginManifest = z.infer<typeof manifestSchema>;
export const MANIFEST_FILE = 'trace-plugin.json';

const platformOf = (value: NodeJS.Platform) => value === 'win32' ? 'windows' : value === 'darwin' ? 'mac' : 'linux';
const newer = (a: string, b: string) => { const x = a.split('.').map(Number); const y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

/**
 * Reads and checks a plugin folder's manifest. Items for another system are left out; a plugin for none of this
 * computer's, or one that needs a newer Trace, is refused. Duplicate ids are refused, as each must be unique.
 */
export function readManifest(folder: string, traceVersion: string, platform: NodeJS.Platform = process.platform): PluginManifest {
  const file = path.join(folder, MANIFEST_FILE);
  let raw: unknown;
  try { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.size > 256 * 1024) throw new Error(); raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new HubError('PLUGIN_MANIFEST', `${MANIFEST_FILE} was not found in that folder, or is not readable JSON.`); }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) throw new HubError('PLUGIN_MANIFEST', `${MANIFEST_FILE} is not valid: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`).join('; ')}.`);
  const manifest = parsed.data; const here = platformOf(platform);
  if (manifest.platforms && !manifest.platforms.includes(here)) throw new HubError('PLUGIN_PLATFORM', `${manifest.name} does not run on ${here === 'mac' ? 'a Mac' : here === 'windows' ? 'Windows' : 'Linux'}.`);
  if (newer(manifest.minTrace, traceVersion)) throw new HubError('PLUGIN_VERSION', `${manifest.name} needs Trace ${manifest.minTrace} or later; this is ${traceVersion}.`);
  for (const [kind, items] of [['action', manifest.actions], ['tile', manifest.tiles]] as const) { const ids = items.map((item) => item.id); const twice = ids.find((id, index) => ids.indexOf(id) !== index); if (twice) throw new HubError('PLUGIN_MANIFEST', `${MANIFEST_FILE} has two ${kind}s with the id ${twice}.`); }
  const ours = <T extends { platforms?: readonly string[] }>(items: T[]) => items.filter((item) => !item.platforms || item.platforms.includes(here));
  return { ...manifest, build: ours(manifest.build), actions: ours(manifest.actions), events: ours(manifest.events), tiles: ours(manifest.tiles) };
}

/** Every command a plugin may run, each as its argument list, for the preview shown before it is installed or linked. */
export function commandsOf(manifest: PluginManifest): { what: string; command: string[] }[] {
  return [
    ...manifest.build.map((item, index) => ({ what: `Build step ${index + 1}`, command: item.command })),
    ...manifest.actions.map((item) => ({ what: `Action: ${item.title}`, command: item.command })),
    ...manifest.events.map((item) => ({ what: `On ${item.on}`, command: item.command })),
    ...manifest.tiles.map((item) => ({ what: `Tile: ${item.title}`, command: item.command })),
  ];
}
