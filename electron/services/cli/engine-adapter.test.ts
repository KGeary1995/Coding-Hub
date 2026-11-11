import { describe, expect, it } from 'vitest';
import type { EngineInfo } from '../../../shared/ipc';
import { startSessionSchema } from '../../../shared/schemas';
import { buildGeminiChatLaunch, buildGeminiLaunch, buildLaunch, launchedLevel } from './engine-adapter';
import { GEMINI_MODEL } from '../../../shared/gemini';

const info = (engine: 'claude' | 'codex'): EngineInfo => ({ engine, available: true, executable: '/cli', version: '2.1.296', supportsModel: true, supportsConfig: true, supportsNoDaemon: false, error: null });
const claude = { engine: 'claude' as const, model: '', thinking: { budget_tokens: null }, tokenLimits: { maxOutputTokens: null, maxSessionTokens: null } };

describe('engine-specific CLI launch policy', () => {
  it('inherits local defaults without adding authentication or permission overrides', () => {
    expect(buildLaunch(claude, info('claude'))).toEqual({ args: [], env: {} });
    expect(buildLaunch({ engine: 'codex', model: '', reasoningEffort: null }, info('codex'))).toEqual({ args: [], env: {} });
  });
  it('maps the channel’s permission level to each CLI’s flags, and refuses a level the CLI cannot take', () => {
    const allowed = { supportsPermissions: true };
    expect(buildLaunch({ ...claude, permissions: 'edits' }, { ...info('claude'), ...allowed }).args).toEqual(['--permission-mode', 'acceptEdits']);
    expect(buildLaunch({ ...claude, permissions: 'full' }, { ...info('claude'), ...allowed }).args).toEqual(['--allow-dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']);
    // No setting is the default, Allow edits; a CLI without the flags keeps its own settings for it.
    expect(buildLaunch(claude, { ...info('claude'), ...allowed }).args).toEqual(['--permission-mode', 'acceptEdits']);
    expect(launchedLevel(claude, info('claude'))).toBe('ask'); expect(launchedLevel(claude, { ...info('claude'), ...allowed })).toBe('edits');
    // A Claude chat may be switched to full access later, which Claude allows only with this flag (alone it changes nothing).
    expect(buildLaunch({ ...claude, chat: true, permissions: 'ask' }, { ...info('claude'), ...allowed }).args).toEqual(['--allow-dangerously-skip-permissions']);
    expect(buildLaunch({ ...claude, chat: true }, info('claude')).args).toEqual([]);
    expect(buildLaunch({ engine: 'codex', model: '', reasoningEffort: null, permissions: 'edits' }, { ...info('codex'), ...allowed }).args).toEqual(['--ask-for-approval', 'on-request', '--sandbox', 'workspace-write']);
    expect(buildLaunch({ engine: 'codex', model: '', reasoningEffort: null, permissions: 'full', resumeId: '6f9619ff-8b86-4011-b42d-00cf4fc964ff' }, { ...info('codex'), ...allowed, supportsResume: true }).args).toEqual(['resume', '6f9619ff-8b86-4011-b42d-00cf4fc964ff', '--ask-for-approval', 'never', '--sandbox', 'danger-full-access']);
    expect(() => buildLaunch({ ...claude, permissions: 'full' }, info('claude'))).toThrow('permission flags');
  });
  it('turns on Claude in Chrome only when asked and only on a Claude Code that advertises --chrome', () => {
    expect(buildLaunch({ ...claude, chrome: true }, { ...info('claude'), supportsChrome: true }).args).toEqual(['--chrome']);
    expect(buildLaunch(claude, { ...info('claude'), supportsChrome: true }).args).toEqual([]);
    expect(() => buildLaunch({ ...claude, chrome: true }, info('claude'))).toThrow('--chrome');
    expect(startSessionSchema.safeParse({ sessionId: 's', cwd: '/p', cols: 80, rows: 24, config: { engine: 'codex', model: '', reasoningEffort: null, chrome: true } }).success).toBe(false);
  });
  it('passes Codex model and reasoning as separate arguments and disables the shared daemon when supported', () => {
    expect(buildLaunch({ engine: 'codex', model: 'gpt-5.3-codex', reasoningEffort: 'xhigh' }, { ...info('codex'), supportsNoDaemon: true }).args).toEqual(['--model', 'gpt-5.3-codex', '--config', 'model_reasoning_effort="xhigh"', '--no-daemon']);
  });
  it('maps supported manual-thinking overrides without mutating the parent environment', () => {
    expect(buildLaunch({ ...claude, model: 'claude-sonnet-4-5-20250929', thinking: { budget_tokens: 4096 }, tokenLimits: { maxOutputTokens: 8192, maxSessionTokens: null } }, info('claude')).env).toEqual({ MAX_THINKING_TOKENS: '4096', CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' });
  });
  it('rejects silent budget fallback on adaptive-thinking aliases', () => {
    expect(() => buildLaunch({ ...claude, model: 'sonnet', thinking: { budget_tokens: 4096 } }, info('claude'))).toThrow('manual extended thinking');
    expect(() => buildLaunch({ ...claude, model: 'claude-sonnet-4-6', thinking: { budget_tokens: 4096 } }, info('claude'))).toThrow('manual extended thinking');
  });
  it('rejects unsupported session-wide limits and conflicting token limits', () => {
    expect(() => buildLaunch({ ...claude, tokenLimits: { maxSessionTokens: 10000, maxOutputTokens: null } }, info('claude'))).toThrow('session ID');
    expect(buildLaunch({ ...claude, tokenLimits: { maxSessionTokens: 10000, maxOutputTokens: null } }, { ...info('claude'), supportsSessionId: true }).args).toEqual([]);
    expect(() => buildLaunch({ ...claude, model: 'claude-3-7-sonnet-latest', thinking: { budget_tokens: 8192 }, tokenLimits: { maxSessionTokens: null, maxOutputTokens: 4096 } }, info('claude'))).toThrow('smaller');
  });
  it('rejects unadvertised flags and cross-engine configurations', () => {
    expect(() => buildLaunch({ engine: 'codex', model: '', reasoningEffort: 'high' }, { ...info('codex'), supportsConfig: false })).toThrow('--config');
    expect(() => buildLaunch(claude, info('codex'))).toThrow('does not match');
  });
  it('validates IPC structure, dimensions, engine fields, and flag-like model identifiers', () => {
    const request = { sessionId: 'session-1', cwd: '/repos/test', config: claude, cols: 100, rows: 24 };
    expect(startSessionSchema.safeParse(request).success).toBe(true);
    for (const invalid of [{ ...request, executable: 'powershell' }, { ...request, cols: 0 }, { ...request, cwd: '/tmp/\0bad' }, { ...request, config: { ...claude, reasoningEffort: 'high' } }, { ...request, config: { ...claude, model: '--dangerously-skip-permissions' } }]) expect(startSessionSchema.safeParse(invalid).success).toBe(false);
  });
});

it('passes an explicitly selected catalog model and raw reasoning effort exactly for new and resumed Codex runs',()=>{
 const config={engine:'codex' as const,model:'custom/provider-model',reasoningEffort:'minimal'};
 expect(startSessionSchema.safeParse({sessionId:'custom',cwd:'/tmp',cols:80,rows:24,config}).success).toBe(true);
 expect(buildLaunch(config,info('codex')).args).toEqual(['--model','custom/provider-model','--config','model_reasoning_effort="minimal"']);
 const resumeId='11111111-1111-4111-8111-111111111111';expect(buildLaunch({...config,resumeId},{...info('codex'),supportsResume:true}).args).toEqual(['resume',resumeId,'--model','custom/provider-model','--config','model_reasoning_effort="minimal"']);
});

describe('Gemini CLI launch', () => {
  const agy: EngineInfo = { engine: 'gemini', available: true, executable: '/agy', version: '1.5.6', supportsModel: true, supportsConfig: false, supportsNoDaemon: false, supportsMode: true, supportsSkipPermissions: true, error: null };
  const config = { engine: 'gemini' as const, model: GEMINI_MODEL };
  it('always passes the fixed model, then the level’s flag', () => {
    expect(buildGeminiLaunch(config, agy)).toEqual(['--model', GEMINI_MODEL, '--mode', 'accept-edits']);
    expect(buildGeminiLaunch({ ...config, permissions: 'edits' }, agy)).toEqual(['--model', GEMINI_MODEL, '--mode', 'accept-edits']);
    expect(buildGeminiLaunch({ ...config, permissions: 'ask' }, agy)).toEqual(['--model', GEMINI_MODEL]);
    expect(buildGeminiLaunch({ ...config, permissions: 'full' }, agy)).toEqual(['--model', GEMINI_MODEL, '--dangerously-skip-permissions']);
  });
  it('refuses rather than drops a flag agy does not list, another model, or another engine', () => {
    expect(() => buildGeminiLaunch(config, { ...agy, supportsModel: false })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MODEL_FLAG' }));
    expect(() => buildGeminiLaunch(config, { ...agy, supportsMode: false })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PERMISSIONS' }));
    expect(() => buildGeminiLaunch({ ...config, permissions: 'full' }, { ...agy, supportsSkipPermissions: false })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PERMISSIONS' }));
    expect(buildGeminiLaunch({ ...config, permissions: 'ask' }, { ...agy, supportsMode: false, supportsSkipPermissions: false })).toEqual(['--model', GEMINI_MODEL]);
    expect(() => buildGeminiLaunch({ ...config, model: 'gemini-3.8-flash-high' }, agy)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MODEL' }));
    expect(() => buildGeminiLaunch(config, { ...agy, engine: 'codex' })).toThrow(expect.objectContaining({ code: 'ENGINE_MISMATCH' }));
    expect(() => buildGeminiLaunch(config, { ...agy, available: false, error: 'not found' })).toThrow(expect.objectContaining({ code: 'ENGINE_UNAVAILABLE' }));
  });
});
describe('Gemini Round Table seat launch', () => {
  const agy: EngineInfo = { engine: 'gemini', available: true, executable: '/agy', version: '1.5.6', supportsModel: true, supportsConfig: false, supportsNoDaemon: false, supportsMode: true, supportsSkipPermissions: true, supportsAcp: true, error: null };
  const config = { engine: 'gemini' as const, model: GEMINI_MODEL, chat: true };
  it('runs agy acp with no flags (the model and plan mode are set in the protocol), never skipping permissions, at any level', () => {
    for (const permissions of ['ask', 'edits', 'full'] as const) expect(buildGeminiChatLaunch({ ...config, permissions }, agy)).toEqual(['acp']);
  });
  it('refuses another model, a CLI without its ACP server, and a missing agy', () => {
    expect(() => buildGeminiChatLaunch({ ...config, model: 'gemini-4-argon-medium' }, agy)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_MODEL' }));
    expect(() => buildGeminiChatLaunch(config, { ...agy, supportsAcp: false })).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_ACP' }));
    expect(() => buildGeminiChatLaunch(config, { ...agy, available: false, error: 'not found' })).toThrow(expect.objectContaining({ code: 'ENGINE_UNAVAILABLE' }));
  });
});
