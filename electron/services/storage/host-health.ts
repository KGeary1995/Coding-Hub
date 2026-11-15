import { z } from 'zod';
import { load, save } from '../workbench/local-store';
import type { HostHealthReport } from '../../../shared/workbench';
const entry = z.object({ time: z.iso.datetime(), event: z.string().max(80), reason: z.string().max(120).nullable(), exitCode: z.number().int().nullable() }).strict();
const schema = z.object({ cleanShutdown: z.boolean(), events: z.array(entry).max(100) }).strict();

/**
 * Each window's state when the GPU process crashed, as one health reason (at most 120 characters): "w1 visible focused;
 * w2 minimized". Says nothing about what a window shows.
 */
export function gpuCrashWindows(windows: { isVisible(): boolean; isMinimized(): boolean; isFocused(): boolean }[]): string {
  if (!windows.length) return 'no windows';
  const states = windows.map((window, index) => `w${index + 1} ${[window.isMinimized() ? 'minimized' : window.isVisible() ? 'visible' : 'hidden', ...(window.isFocused() ? ['focused'] : [])].join(' ')}`);
  const text = states.join('; '); return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}
/** Only lifecycle metadata is recorded: no prompts, terminal output, account
 * identifiers, environment values or raw exception messages/stacks. */
export class HostHealth {
  private state: z.infer<typeof schema> = { cleanShutdown: false, events: [] };
  private previousShutdown: HostHealthReport['previousShutdown'] = 'unknown';
  constructor(private root: string) {
    try {
      const previous = load(root, 'host-health.json', schema, { cleanShutdown: true, events: [] });
      this.previousShutdown = previous.events.length ? previous.cleanShutdown ? 'clean' : 'unclean' : 'unknown';
      this.state.events = previous.events;
    } catch { /* Health reporting cannot prevent the app from starting. */ }
    this.record('host-start');
  }
  record(event: string, reason: string | null = null, exitCode: number | null = null) {
    const parsed = entry.safeParse({ time: new Date().toISOString(), event, reason, exitCode }); if (!parsed.success) return;
    this.state.events = [...this.state.events, parsed.data].slice(-100);
    try { save(this.root, 'host-health.json', this.state); } catch { /* A read-only diagnostics store must not close live sessions. */ }
  }
  close() { this.state.cleanShutdown = true; this.record('host-stop'); }
  report(): HostHealthReport { return { previousShutdown: this.previousShutdown, events: structuredClone(this.state.events) }; }
}
