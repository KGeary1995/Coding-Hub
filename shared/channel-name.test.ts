import { describe, expect, it } from 'vitest';
import { channelName, sessionTopic } from './channel-name';

describe('channel names', () => {
  it('names a channel after its folder until the person names it', () => {
    expect(channelName({ engine: 'claude', title: 'Claude Code', cwd: '/Users/me/Coding-Hub' })).toBe('Coding-Hub');
    expect(channelName({ engine: 'codex', title: 'Codex', cwd: 'C:\\Users\\me\\ADHD-Tax\\' })).toBe('ADHD-Tax');
    expect(channelName({ engine: 'claude', title: 'Release work', cwd: '/Users/me/Coding-Hub' })).toBe('Release work');
    expect(channelName({ engine: 'shell', title: 'Terminal', cwd: null })).toBe('Terminal');
  });
  it('takes what the session is about from the CLI terminal title, and ignores titles that say nothing new', () => {
    expect(sessionTopic('✳ Fix token counts in the status bar', 'claude', 'Coding-Hub')).toBe('Fix token counts in the status bar');
    expect(sessionTopic('⠂ Fix token counts', 'claude', 'Coding-Hub')).toBe('Fix token counts');
    expect(sessionTopic('✳ Claude Code', 'claude', 'Coding-Hub')).toBeNull();
    expect(sessionTopic('⠋ Coding-Hub', 'codex', 'Coding-Hub')).toBeNull();
    expect(sessionTopic('me@mac:~/Coding-Hub', 'shell', 'Coding-Hub')).toBeNull();
    expect(sessionTopic('', 'claude', 'x')).toBeNull();
  });
});
