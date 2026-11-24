import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

/** One step of a made-up Gemini conversation, in the shapes geminiHistory reads (transcript.ts) and two it leaves out. */
export type GeminiTestStep =
  | { input?: string; parts?: string[]; images?: number }
  | { reply?: string; thinking?: string; tools?: { id: string; name: string; input: string }[] }
  | { toolOutput: string } | { agentMessage: string } | { raw: Uint8Array; kind: number };

const varint = (value: number) => { const bytes: number[] = []; do { bytes.push((value & 127) | (value > 127 ? 128 : 0)); value = Math.floor(value / 128); } while (value > 0); return Buffer.from(bytes); };
/** A protobuf field: a number (varint) or bytes (a string, or a message built with these). */
export const field = (number: number, value: number | string | Buffer): Buffer => typeof value === 'number' ? Buffer.concat([varint(number * 8), varint(value)]) : Buffer.concat([varint(number * 8 + 2), varint(Buffer.byteLength(value)), Buffer.from(value)]);
const message = (...parts: Buffer[]) => Buffer.concat(parts);

/** A step's `step_payload` as agy 1.5.15 writes it: its kind (field 1), its status (4), its metadata (5), then the kind's own field. */
function payload(step: GeminiTestStep): { kind: number; bytes: Buffer | Uint8Array } {
  const head = (kind: number) => message(field(1, kind), field(4, 3), field(5, message(field(3, 2), field(12, randomUUID()))));
  if ('raw' in step) return { kind: step.kind, bytes: step.raw };
  if ('toolOutput' in step) return { kind: 132, bytes: message(head(132), field(140, message(field(1, message(field(1, 'output'), field(2, step.toolOutput))), field(2, message(field(1, step.toolOutput)))))) };
  if ('agentMessage' in step) return { kind: 101, bytes: message(head(101), field(114, message(field(1, step.agentMessage), field(3, 'agent_message')))) };
  if ('reply' in step || 'thinking' in step || 'tools' in step) {
    const tools = (step.tools ?? []).map((tool) => field(7, message(field(1, tool.id), field(2, tool.name), field(3, tool.input))));
    return { kind: 15, bytes: message(head(15), field(20, message(...(step.reply !== undefined ? [field(1, step.reply)] : []), ...(step.thinking !== undefined ? [field(3, step.thinking)] : []), field(6, 'bot-1'), ...tools, ...(step.reply !== undefined ? [field(8, step.reply)] : []), field(12, 2)))) };
  }
  const user = step as { input?: string; parts?: string[]; images?: number };
  const parts = (user.parts ?? (user.input !== undefined ? [user.input] : [])).map((text) => field(3, field(1, text)));
  const images = Array.from({ length: user.images ?? 0 }, () => field(9, message(field(1, 'image/png'), field(2, Buffer.from([0x89, 0x50, 0x4e, 0x47])), field(5, 'C:/image.png'))));
  return { kind: 14, bytes: message(head(14), field(19, message(...(user.input !== undefined ? [field(2, user.input)] : []), ...parts, field(4, ''), ...images))) };
}

/** A conversation file (`<home>/conversations/<id>.db`) with agy's `steps` table holding `steps` in order; returns where it is. */
export function writeGeminiConversation(home: string, steps: GeminiTestStep[], id = randomUUID(), wal = false): string {
  const file = path.join(home, 'conversations', `${id}.db`); fs.mkdirSync(path.dirname(file), { recursive: true });
  const database = new DatabaseSync(file);
  try {
    if (wal) database.exec('PRAGMA journal_mode=WAL');
    database.exec('CREATE TABLE `trajectory_meta` (`trajectory_id` text,`cascade_id` text,`trajectory_type` integer,`source` integer,PRIMARY KEY (`trajectory_id`))');
    database.exec('CREATE TABLE `steps` (`idx` integer,`step_type` integer NOT NULL DEFAULT 0,`status` integer NOT NULL DEFAULT 0,`has_subtrajectory` numeric NOT NULL DEFAULT false,`metadata` blob,`error_details` blob,`permissions` blob,`task_details` blob,`render_info` blob,`step_payload` blob,`step_format` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))');
    database.exec('CREATE TABLE `gen_metadata` (`idx` integer,`data` blob,`size` integer NOT NULL DEFAULT 0,PRIMARY KEY (`idx`))');
    const insert = database.prepare('INSERT INTO steps(idx, step_type, status, step_payload) VALUES(?, ?, 3, ?)');
    steps.forEach((step, index) => { const { kind, bytes } = payload(step); insert.run(index, kind, bytes); });
  } finally { database.close(); }
  return file;
}
