import type { LinkedComputer } from '../../../shared/remote';

export interface LinkedAlert { id: string; title: string; body: string }
/**
 * Alerts for linked computers' channels: one when a channel there starts waiting for the person (an approval, a
 * question) or stops with an error. What each computer showed when it was first seen is taken as known, so connecting
 * (or reconnecting) does not repeat old alerts.
 */
export class LinkedAlerts {
  private known = new Map<string, Map<string, string>>();
  constructor(private notify: (alert: LinkedAlert) => void) {}
  update(computers: LinkedComputer[]) {
    for (const computer of computers) {
      if (!computer.linked || !computer.connected) continue;
      const before = this.known.get(computer.id); const now = new Map<string, string>();
      for (const channel of computer.channels) {
        const state = channel.running && channel.attention ? `waiting:${channel.runId}:${channel.attention}` : !channel.running && channel.failed ? `failed:${channel.runId ?? ''}:${channel.failed}` : '';
        if (!state) continue; now.set(channel.sessionId, state);
        if (!before || before.get(channel.sessionId) === state) continue;
        const name = `${computer.name} · CH${channel.channel}`;
        this.notify(state.startsWith('waiting') ? { id: computer.id, title: `${name} needs you`, body: channel.attention! } : { id: computer.id, title: `${name} stopped with an error`, body: channel.failed! });
      }
      this.known.set(computer.id, now);
    }
  }
}
