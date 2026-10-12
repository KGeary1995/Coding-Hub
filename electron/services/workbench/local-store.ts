import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { HubError } from '../cli/engine-adapter';
export function load<T>(root: string, name: string, schema: z.ZodType<T>, fallback: T): T {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) return fallback;
  try { if (fs.lstatSync(file).isSymbolicLink() || !fs.statSync(file).isFile() || fs.statSync(file).size > 4 * 1024 * 1024) throw new Error(); return schema.parse(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch { throw new HubError('LOCAL_DATA', `${name} could not be read. Existing data was preserved.`); }
}
export function save(root: string, name: string, value: unknown) {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(root).isSymbolicLink()) throw new HubError('LOCAL_DATA', 'Storage must be a real local directory.');
  const file = path.join(root, name); if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new HubError('LOCAL_DATA', 'The data file must not be a link.');
  const serialized = JSON.stringify(value, null, 2); if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new HubError('LOCAL_LIMIT', 'Local records exceed the supported size. Existing data was preserved.');
  const temporary = path.join(root, '.' + randomUUID() + '.tmp');
  try { fs.writeFileSync(temporary, serialized, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}
export function directory(input: string): string { if (!path.isAbsolute(input) || input.includes('\0')) throw new HubError('PROJECT_PATH', 'Choose an absolute local project directory.'); const result = fs.realpathSync(input); if (!fs.statSync(result).isDirectory()) throw new HubError('PROJECT_PATH', 'Choose a project directory.'); return result; }
