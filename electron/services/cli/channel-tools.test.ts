import { afterEach, describe, expect, it } from 'vitest';
import { ChannelTools, type ChannelSummary, type ChannelToolsHost } from './channel-tools';

const tools: ChannelTools[] = [];
afterEach(() => { for (const item of tools.splice(0)) item.close(); });
const RUN = '11111111-1111-4111-8111-111111111111';
function setup(extra: Partial<ChannelToolsHost> = {}) {
  const sent: [string, string][] = []; let on = true;
  const channels: ChannelSummary[] = [
    { channel: 1, sessionId: 'me', name: 'Claude Code', engine: 'claude', running: true, waiting: null, folder: '/p' },
    { channel: 2, sessionId: 'other', name: 'Codex', engine: 'codex', running: true, waiting: null, folder: '/p' },
    { channel: 3, sessionId: 'asking', name: 'Shell', engine: 'shell', running: true, waiting: 'Allow rm?', folder: '/p' },
    { channel: 4, sessionId: 'off', name: 'Stopped', engine: 'claude', running: false, waiting: null, folder: null },
  ];
  const host: ChannelToolsHost = { enabled: () => on, channels: () => channels, sessionOf: (runId) => runId === RUN ? 'me' : null, replies: (sessionId, count) => [`${sessionId}:${count}`], send: async (sessionId, text) => { sent.push([sessionId, text]); }, ...extra };
  const item = new ChannelTools(host); tools.push(item);
  return { item, sent, off: () => { on = false; } };
}

describe('channel tools', () => {
  it('lists the channels, marking the caller\'s own', async () => {
    const { item } = setup();
    const { channels } = await item.run(RUN, 'list', {}) as { channels: { channel: number; you: boolean }[] };
    expect(channels.map((channel) => [channel.channel, channel.you])).toEqual([[1, true], [2, false], [3, false], [4, false]]);
  });
  it('sends another channel a message marked as from an agent, never to itself, a stopped one or one waiting for the person', async () => {
    const { item, sent } = setup();
    expect(await item.run(RUN, 'send', { channel: 2, text: 'Review the diff' })).toEqual({ sent: true, channel: 2 });
    expect(sent).toEqual([['other', '[Message from CH1 (Claude Code): an agent, not the person]\nReview the diff']]);
    await expect(item.run(RUN, 'send', { channel: 1, text: 'x' })).rejects.toMatchObject({ code: 'CHANNEL_TOOLS_SELF' });
    await expect(item.run(RUN, 'send', { channel: 4, text: 'x' })).rejects.toMatchObject({ code: 'CHANNEL_TOOLS_STOPPED' });
    await expect(item.run(RUN, 'send', { channel: 3, text: 'x' })).rejects.toMatchObject({ code: 'CHANNEL_TOOLS_WAITING' });
    await expect(item.run(RUN, 'send', { channel: 9, text: 'x' })).rejects.toMatchObject({ code: 'CHANNEL_TOOLS_CHANNEL' });
    expect(sent).toHaveLength(1);
  });
  it('reads a channel\'s last replies', async () => {
    expect(await setup().item.run(RUN, 'read', { channel: 2, replies: 2 })).toEqual({ channel: 2, name: 'Codex', replies: ['other:2'] });
  });
  it('waits for the next turn end, approval or stop, or the time given', async () => {
    const { item } = setup();
    const ended = item.run(RUN, 'wait', { channel: 2, timeoutSeconds: 5 });
    await Promise.resolve(); item.onSessionEvent({ type: 'answered', sessionId: 'other', runId: 'r', at: '', finished: true });
    expect(await ended).toEqual({ channel: 2, outcome: 'turn-ended' });
    const chat = item.run(RUN, 'wait', { channel: 2, timeoutSeconds: 5 });
    await Promise.resolve(); item.onChat({ sessionId: 'other', runId: 'r', event: { type: 'done', isError: false, error: null } } as never);
    expect(await chat).toEqual({ channel: 2, outcome: 'turn-ended' });
    expect(await item.run(RUN, 'wait', { channel: 3 })).toEqual({ channel: 3, outcome: 'waiting', waiting: 'Allow rm?' });
    expect(await item.run(RUN, 'wait', { channel: 4 })).toEqual({ channel: 4, outcome: 'stopped' });
    expect(await item.run(RUN, 'wait', { channel: 2, timeoutSeconds: 1 })).toEqual({ channel: 2, outcome: 'timeout' });
    // An approval request is remembered until the channel carries on: until then nothing is sent to it.
    item.onSessionEvent({ type: 'attention', sessionId: 'other', runId: 'r', at: '', message: 'Allow edit?' });
    await expect(item.run(RUN, 'send', { channel: 2, text: 'x' })).rejects.toMatchObject({ code: 'CHANNEL_TOOLS_WAITING' });
    item.onSessionEvent({ type: 'answered', sessionId: 'other', runId: 'r', at: '' });
    expect(await item.run(RUN, 'send', { channel: 2, text: 'x' })).toEqual({ sent: true, channel: 2 });
  });
  it('answers only a run\'s own secret address, and only while turned on', async () => {
    const { item, off } = setup(); await item.start();
    const url = item.register(RUN)!; expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/channels\//);
    const post = (address: string) => fetch(address, { method: 'POST', body: '{}' });
    expect((await post(`${url}/list`)).status).toBe(200);
    expect((await post(`${url.slice(0, -4)}0000/list`)).status).toBe(404);
    off(); const refused = await post(`${url}/list`); expect(refused.status).toBe(409); expect((await refused.json() as { error: string }).error).toMatch(/Channel tools are off/);
    expect(item.register('22222222-2222-4222-8222-222222222222')).toBeNull();
  });
});
