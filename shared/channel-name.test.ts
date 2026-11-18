import { describe, expect, it } from 'vitest';
import { channelName, sessionTopic, terminalTitle } from './channel-name';

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
  it('keeps a topic’s own first character and never ends it in half an emoji', () => {
    for (const title of ['.env handling', '/review the PR', '~/.zshrc cleanup', '`npm test` fails on CI', '#123 fix', '$PATH broken']) expect(sessionTopic(`✳ ${title}`, 'claude', 'x')).toBe(title);
    expect(sessionTopic('· * • Fix it', 'claude', 'x')).toBe('Fix it'); expect(terminalTitle('⠋⠙ Working')).toBe('Working');
    const cut = sessionTopic('a'.repeat(79) + '😀 tail', 'claude', 'x')!; expect(cut.endsWith('😀')).toBe(true); expect(cut).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});
