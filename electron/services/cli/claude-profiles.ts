import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ClaudeAccountProfile } from '../../../shared/accounts';
import { HubError } from './engine-adapter';

const profileSchema = z.object({ id: z.uuid(), name: z.string().trim().min(1).max(60), createdAt: z.iso.datetime() }).strict();
const registrySchema = z.object({ version: z.literal(1), profiles: z.array(profileSchema).max(10) }).strict();
const nameSchema = profileSchema.shape.name;
const authOverrides = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_REMOTE', 'ANTHROPIC_BASE_URL',
]);

/** Stores labels only. The official CLI owns credentials; they are never read here. */
export class ClaudeProfiles {
  private readonly root: string;
  private readonly file: string;
  constructor(storageRoot: string) {
    if (!path.isAbsolute(storageRoot)) throw new HubError('PROFILE_STORAGE', 'Profile storage requires an absolute local directory.');
    this.root = path.join(storageRoot, 'claude-profiles');
    this.file = path.join(this.root, 'profiles.json');
  }
  private read(): ClaudeAccountProfile[] {
    if (!fs.existsSync(this.root)) return [];
    if (!fs.lstatSync(this.root).isDirectory() || fs.lstatSync(this.root).isSymbolicLink()) throw new HubError('PROFILE_STORAGE', 'The profile directory must be a real local directory.');
    if (!fs.existsSync(this.file)) return [];
    try {
      if (!fs.lstatSync(this.file).isFile() || fs.lstatSync(this.file).isSymbolicLink() || fs.statSync(this.file).size > 32768) throw new Error();
      const value = registrySchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
      if (new Set(value.profiles.map((p) => p.id)).size !== value.profiles.length) throw new Error();
      return value.profiles;
    } catch { throw new HubError('PROFILE_STORAGE', 'The profile registry could not be read. Existing files were preserved.'); }
  }
  list() { return this.read(); }
  private write(profiles: ClaudeAccountProfile[]) {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.read(); // Reject redirected or invalid registries before replacing anything.
    const temporary = path.join(this.root, `.profiles-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, profiles }, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, this.file);
    } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  create(name: string): ClaudeAccountProfile {
    const parsed = nameSchema.safeParse(name);
    if (!parsed.success) throw new HubError('PROFILE_NAME', 'Use a profile name between 1 and 60 characters.');
    const profiles = this.read();
    if (profiles.length >= 10) throw new HubError('PROFILE_LIMIT', 'Up to ten named Claude profiles are supported.');
    if (profiles.some((p) => p.name.toLowerCase() === parsed.data.toLowerCase())) throw new HubError('PROFILE_NAME', 'Choose a unique profile name.');
    const profile = { id: randomUUID(), name: parsed.data, createdAt: new Date().toISOString() };
    this.write([...profiles, profile]);
    this.directory(profile.id);
    return profile;
  }
  rename(id: string, name: string): ClaudeAccountProfile {
    const profiles = this.read(); const profile = profiles.find((p) => p.id === id);
    if (!profile) throw new HubError('PROFILE_NOT_FOUND', 'This Claude profile is unavailable. Select another profile in session settings.');
    const parsed = nameSchema.safeParse(name);
    if (!parsed.success || profiles.some((p) => p.id !== id && p.name.toLowerCase() === parsed.data.toLowerCase())) throw new HubError('PROFILE_NAME', 'Use a unique profile name between 1 and 60 characters.');
    const renamed = { ...profile, name: parsed.data }; this.write(profiles.map((p) => p.id === id ? renamed : p)); return renamed;
  }
  directory(id: string): string {
    if (!z.uuid().safeParse(id).success || !this.read().some((p) => p.id === id)) throw new HubError('PROFILE_NOT_FOUND', 'This Claude profile is unavailable. Select another profile in session settings.');
    const directory = path.join(this.root, id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new HubError('PROFILE_STORAGE', 'The profile configuration directory must not be a link.');
    return directory;
  }
  environment(base: Record<string, string>, id?: string): Record<string, string> {
    if (!id) return { ...base };
    const directory = this.directory(id);
    const env = Object.fromEntries(Object.entries(base).filter(([key]) => !authOverrides.has(key.toUpperCase())));
    return { ...env, CLAUDE_CONFIG_DIR: directory };
  }
}
