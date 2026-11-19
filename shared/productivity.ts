import type { SavedWorkspace, SessionHistoryRun } from './types';
import { newTokens, type UsageRecord } from './hub';
import type { VerificationProfile } from './workbench';
export interface SessionBudget { tokens: number | null; costUSD: number | null; contextPercent: number }
export interface PreparedSessionRequest { prompt: string; label: string }
export interface ConversationLabel { key: string; name: string; pinned: boolean }
export interface SearchHit { id: string; kind: 'file' | 'output' | 'memory' | 'rules'; title: string; location: string; snippet: string; view: 'files' | 'history' | 'memory' | 'rules'; noteId?: string }
export interface SearchResults { hits: SearchHit[]; limited: boolean }
export interface ProjectTemplate { id: string; name: string; description: string; workspace: SavedWorkspace; rules: string; checks: Pick<VerificationProfile, 'name' | 'steps' | 'timeoutSeconds'>[]; createdAt: string }
export interface DeliveryStatus { directory: string; branch: string | null; head: string | null; revision: string; renames: Record<string,string>; staged: string[]; unstaged: string[]; remotes: string[] }
export interface DeliveryResult { output: string; url: string | null }
export type WorkflowRequest =
 | { action: 'flow-conversations' } | { action: 'flow-conversation-save'; key: string; name: string; pinned: boolean }
 | { action: 'flow-failures' }
 | { action: 'flow-search'; query: string; directory: string | null; includeOutput: boolean }
 | { action: 'flow-templates' } | { action: 'flow-template-save'; name: string; description: string; workspace: SavedWorkspace; includeRules: boolean; includeChecks: boolean }
 | { action: 'flow-template-apply'; id: string; directory: string; applyRules: boolean; applyChecks: boolean }
 | { action: 'flow-template-delete'; id: string }
 | { action: 'flow-git-inspect'; directory: string }
 | { action: 'flow-git-stage' | 'flow-git-unstage'; directory: string; revision: string; paths: string[] }
 | { action: 'flow-git-commit'; directory: string; revision: string; message: string }
 | { action: 'flow-git-push'; directory: string; revision: string; remote: string }
 | { action: 'flow-git-pr'; directory: string; revision: string; title: string; body: string; base: string; draft: boolean }
 | { action: 'flow-open-pr'; url: string }
 /** A link in a chat reply, opened in the browser: http and https only (checked again by the host). */
 | { action: 'flow-open-link'; url: string }
 | { action: 'flow-release-status' }
 | { action: 'flow-support-export'; engine: 'claude' | 'codex'; directory: string | null; profileId?: string };
export type WorkflowResponse = ConversationLabel[] | ConversationLabel | (SessionHistoryRun & { diagnostic: string })[] | SearchResults | ProjectTemplate[] | ProjectTemplate | SavedWorkspace | DeliveryStatus | DeliveryResult | { exported: boolean } | { state: string; publisher: string | null } | import('./workbench').Task | null;
export function budgetAlerts(budget: SessionBudget | undefined, usage: UsageRecord | undefined): string[] {
  if (!budget || !usage) return [];
  const tokens = newTokens(usage);
  const messages: string[] = [];
  if (budget.tokens !== null && tokens >= budget.tokens) messages.push(`Reported tokens reached ${budget.tokens.toLocaleString()}`);
  if (budget.costUSD !== null && usage.cost !== null && usage.cost >= budget.costUSD) messages.push(`Estimated cost reached $${budget.costUSD.toFixed(2)}`);
  if (usage.context && usage.context.limit > 0 && usage.context.used / usage.context.limit * 100 >= budget.contextPercent) messages.push(`Context usage reached ${budget.contextPercent}%`);
  return messages;
}
/**
 * Advice for a channel that failed. `message` holds the CLI's last output, so the patterns are whole words and phrases
 * that name a cause ("author" is no sign-in problem, port 14290 no rate limit), and the folder and rules cases match only
 * Trace's own launch errors (a missing command's "No such file or directory" is not about the project folder).
 */
export function recoveryAdvice(message: string, exitCode: number | null, hasDirectory: boolean) {
  // The host's generic exit diagnostic mentions "this project folder": that is no folder problem.
  if (!hasDirectory || /working (?:directory|folder)|absolute local|\bcwd\b/i.test(message)) return { title: 'Choose an existing project folder', view: 'projects' as const, detail: 'Select a project folder or give the channel a folder of its own, then retry.' };
  if (/shared rules/i.test(message)) return { title: 'Apply current shared rules', view: 'rules' as const, detail: 'Apply the saved rules to this channel’s folder before retrying.' };
  if (/\b(?:401|429)\b|\bo?auth(?:entication|orization|enticated?)?\b|\btoken (?:has )?expired\b|\bnot logged in\b|\blog ?in\b|\bsign(?:ed)?.in\b|unauthori[sz]ed|\bsubscription\b|\bbilling\b|\bquota\b|\brate.limit/i.test(message)) return { title: 'Review the CLI account and provider limits', view: 'accounts' as const, detail: 'Use the correct account profile. Login checks do not verify model access or billing.' };
  if (/\bmodel\b|\breasoning\b|\bconfig(?:uration)?\b|\.toml\b|invalid json|unknown (?:option|flag|argument)|\bflag\b|\bargument\b/i.test(message)) return { title: 'Review model and CLI configuration', view: 'accounts' as const, detail: 'Run diagnostics and test local CLI defaults. Engine settings retain their raw values.' };
  return { title: exitCode ? `Investigate CLI exit ${exitCode}` : 'Check the local CLI', view: 'accounts' as const, detail: 'Review the recorded diagnostic and run connection checks. The exit code alone does not identify the cause.' };
}
/**
 * A folder as a pattern that finds it however a report writes it: with either separator, without a trailing one, and
 * only as a whole folder name (C:\Users\kg is not the start of C:\Users\kgeary or C:\Users\kg.old; a full stop after it ends a sentence).
 */
function folderPattern(folder: string): RegExp | null {
 const parts = folder.split(/[\\/]+/); while (parts.length > 1 && !parts.at(-1)) parts.pop(); if (!parts.join('')) return null;
 return new RegExp(parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]+') + String.raw`(?![\w~-]|\.[\w~-])`, 'gi');
}
export function redactDiagnostic(value: unknown, home: string, project: string | null): unknown {
 // Longest path first: a project that contains the home folder (C:\ or C:\Users) must not hide the username.
 if (typeof value === 'string') { let text = value; for (const [source, replacement] of ([[project, '<project>'], [home, '~']] as const).slice().sort((a, b) => (b[0]?.length ?? 0) - (a[0]?.length ?? 0))) { const pattern = source ? folderPattern(source) : null; if (pattern) text = text.replace(pattern, replacement); } return text; }
 if (Array.isArray(value)) return value.map((item) => redactDiagnostic(item, home, project));
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDiagnostic(item, home, project)]));
 return value;
}
