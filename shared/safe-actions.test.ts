import { describe, expect, it } from 'vitest';
import { claudeLookOnlyRules, claudeMemoryRules, geminiSafeSettings, LOOK_ONLY_TOOLS, safeActionRules, SAFE_COMMANDS } from './safe-actions';
import { claudeAttentionSettings } from '../electron/services/cli/attention';

describe('safe actions', () => {
  it('are Claude Code rules for commands that only look or run the project’s own checks', () => {
    expect(safeActionRules()).toContain('Bash(npm test:*)'); expect(safeActionRules()).toContain('Bash(git diff:*)');
    // Nothing that installs, deletes, rewrites history or reaches the network.
    for (const command of SAFE_COMMANDS) expect(command).not.toMatch(/\b(install|add|rm|del|push|pull|fetch|reset|checkout|clean|curl|wget)\b/);
  });
  it('join Trace’s hook settings only when given', () => {
    expect(JSON.parse(claudeAttentionSettings('http://127.0.0.1:1/a')).permissions).toBeUndefined();
    expect(JSON.parse(claudeAttentionSettings('http://127.0.0.1:1/a', null, false, safeActionRules())).permissions.allow).toEqual(safeActionRules());
  });
});

describe('safe actions for Gemini', () => {
  it('are exact commands, as agy matches them, beside the person’s own saved rules', () => {
    const allow = (JSON.parse(geminiSafeSettings({ allow: ['command(echo mine)', 3] })) as { permissions: { allow: string[] } }).permissions.allow;
    expect(allow[0]).toBe('command(echo mine)'); expect(allow).toContain('command(npm test)'); expect(allow).toContain('command(git status --short)');
    expect(allow.some((rule) => rule.includes('*'))).toBe(false);
    expect((JSON.parse(geminiSafeSettings(undefined)) as { permissions: { allow: string[] } }).permissions.allow).toContain('command(cargo test)');
  });
  it('keep the person’s deny and ask rules, and add Trace’s own tools with or without the safe commands', () => {
    const settings = JSON.parse(geminiSafeSettings({ allow: ['command(echo mine)'], deny: ['command(rm -rf /)'], ask: ['mcp(x/y)'] }, ['mcp(trace_memory/read_memory)'], false)) as { permissions: { allow: string[]; deny: string[]; ask: string[] } };
    expect(settings.permissions).toEqual({ allow: ['command(echo mine)', 'mcp(trace_memory/read_memory)'], deny: ['command(rm -rf /)'], ask: ['mcp(x/y)'] });
  });
  it('lets Claude Code run Trace’s tools that only look, by the names it gives MCP tools (seen in a real Claude chat)', () => {
    expect(claudeLookOnlyRules()).toEqual(['mcp__trace-channels__list_channels', 'mcp__trace-channels__read_channel', 'mcp__trace-channels__wait_for_channel', 'mcp__trace-channels__list_tasks']);
    expect(claudeMemoryRules()).toEqual(['mcp__coding-hub-memory__memory_context', 'mcp__coding-hub-memory__read_memory', 'mcp__coding-hub-memory__write_handoff', 'mcp__coding-hub-memory__list_decisions', 'mcp__coding-hub-memory__retire_decision', 'mcp__coding-hub-memory__list_open_items', 'mcp__coding-hub-memory__resolve_open_item']);
    expect(LOOK_ONLY_TOOLS).not.toContain('send_to_channel'); expect(LOOK_ONLY_TOOLS).not.toContain('add_task'); expect(LOOK_ONLY_TOOLS).not.toContain('update_task');
  });
});
