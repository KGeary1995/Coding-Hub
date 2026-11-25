import { describe, expect, it } from 'vitest';
import { agentLook } from './agent-look';

describe('how a custom agent is offered (1.43.0)', () => {
  it('is a chat only when its program is the ACP server itself, a terminal and a chat when ACP is a subcommand, and a terminal without ACP', () => {
    expect(agentLook({ id: 'claude-acp', name: 'Claude ACP', acp: { args: [] } })).toMatchObject({ chat: true, chatOnly: true });
    expect(agentLook({ id: 'gemini-acp', name: 'Gemini', acp: { args: ['acp'] } })).toMatchObject({ chat: true });
    expect(agentLook({ id: 'gemini-acp', name: 'Gemini', acp: { args: ['acp'] } }).chatOnly).toBeUndefined();
    expect(agentLook({ id: 'aider', name: 'Aider' })).not.toHaveProperty('chat');
    // A look passed on from another computer keeps what it said.
    expect(agentLook({ id: 'claude-acp', name: 'Claude ACP', chatOnly: true })).toMatchObject({ chat: true, chatOnly: true });
  });
});
