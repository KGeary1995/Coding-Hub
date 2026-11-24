import { PreviewDetector, type PreviewAddress, type PreviewOffer } from '../../../shared/app-preview';
import { HubError } from '../cli/engine-adapter';

/** At most this many addresses are kept for a run (a dev server that moved port a few times keeps its latest ones). */
const PER_RUN = 8;
/**
 * The app previews Trace may show (1.39.0): only addresses a running channel printed itself, in any channel (Claude Code,
 * Codex, Gemini, a terminal). The window names a channel and a port; the address comes from here, never from the window.
 */
export class PreviewOffers {
  private detector = new PreviewDetector();
  private runs = new Map<string, { runId: string; addresses: PreviewAddress[] }>();
  /** A run's output: the addresses it prints for the first time in this run, each with `fresh` for the run's first. */
  data(sessionId: string, runId: string, chunk: string): { address: PreviewAddress; fresh: boolean }[] {
    let run = this.runs.get(sessionId); if (run && run.runId !== runId) { this.detector.forget(run.runId); run = undefined; }
    const found: { address: PreviewAddress; fresh: boolean }[] = [];
    for (const address of this.detector.feed(runId, chunk)) {
      if (run?.addresses.some((item) => item.url === address.url)) continue;
      const fresh = !run; if (!run) { run = { runId, addresses: [] }; this.runs.set(sessionId, run); }
      run.addresses = [...run.addresses.filter((item) => item.url !== address.url), address].slice(-PER_RUN); found.push({ address, fresh });
    }
    return found;
  }
  /** The run ended: what it printed is no longer offered. True when it had offered something. */
  exit(sessionId: string, runId: string) { this.detector.forget(runId); const run = this.runs.get(sessionId); if (!run || run.runId !== runId) return false; this.runs.delete(sessionId); return true; }
  /** Each running channel's latest address. */
  list(): PreviewOffer[] { return [...this.runs].map(([sessionId, run]) => { const latest = run.addresses.at(-1)!; return { sessionId, port: latest.port, url: latest.url }; }); }
  /** The address a channel printed on that port, or a refusal: Trace never opens a port no running channel printed. */
  allowed(sessionId: string, port: number): PreviewAddress {
    const address = [...this.runs.get(sessionId)?.addresses ?? []].reverse().find((item) => item.port === port);
    if (!address) throw new HubError('PREVIEW_UNKNOWN', 'That channel has not printed this app address while running. Start the app in the channel again.');
    return address;
  }
}
