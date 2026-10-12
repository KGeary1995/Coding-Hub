import type { SavedWorkspace, SessionHistoryRun } from './types';
import type { UsageRecord } from './hub';
import type { VerificationProfile } from './workbench';
export interface SessionBudget { tokens: number | null; costUSD: number | null; contextPercent: number }
export interface PreparedSessionRequest { prompt: string; label: string }
export interface ConversationLabel { key: string; name: string; pinned: boolean }
export interface SearchHit { id: string; kind: 'file' | 'output' | 'memory' | 'rules' | 'annotation'; title: string; location: string; snippet: string; view: 'files' | 'history' | 'memory' | 'rules' | 'design'; snapshotId?: string }
export interface SearchResults { hits: SearchHit[]; limited: boolean }
export interface ProjectTemplate { id: string; name: string; description: string; workspace: SavedWorkspace; rules: string; checks: Pick<VerificationProfile, 'name' | 'steps' | 'timeoutSeconds'>[]; createdAt: string }
export interface DeliveryStatus { directory: string; branch: string | null; head: string | null; revision: string; renames: Record<string,string>; staged: string[]; unstaged: string[]; remotes: string[] }
export interface DeliveryResult { output: string; url: string | null }
export interface VisualDifference { content: string; width: number; height: number; changedPixels: number; totalPixels: number }
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
 | { action: 'flow-preview-size'; width: number; height: number }
 | { action: 'flow-design-diff'; before: string; after: string; threshold: number }
 | { action: 'flow-design-task'; snapshotId: string; annotationId: string; directory: string; scope: string[] }
 | { action: 'flow-release-status' }
 | { action: 'flow-support-export'; engine: 'claude' | 'codex'; directory: string | null; profileId?: string };
export type WorkflowResponse = ConversationLabel[] | ConversationLabel | (SessionHistoryRun & { diagnostic: string })[] | SearchResults | ProjectTemplate[] | ProjectTemplate | SavedWorkspace | DeliveryStatus | DeliveryResult | VisualDifference | { exported: boolean } | { state: string; publisher: string | null } | import('./workbench').Task | null;
export function budgetAlerts(budget: SessionBudget | undefined, usage: UsageRecord | undefined): string[] {
  if (!budget || !usage) return [];
  const tokens = usage.input + usage.output + (usage.engine === 'claude' ? usage.cached + usage.cacheWrite : 0);
  const messages: string[] = [];
  if (budget.tokens !== null && tokens >= budget.tokens) messages.push(`Reported tokens reached ${budget.tokens.toLocaleString()}`);
  if (budget.costUSD !== null && usage.cost !== null && usage.cost >= budget.costUSD) messages.push(`Estimated cost reached $${budget.costUSD.toFixed(2)}`);
  if (usage.context && usage.context.limit > 0 && usage.context.used / usage.context.limit * 100 >= budget.contextPercent) messages.push(`Context usage reached ${budget.contextPercent}%`);
  return messages;
}
export function recoveryAdvice(message: string, exitCode: number | null, hasDirectory: boolean) {
  if (!hasDirectory || /directory|cwd|enoent.*path/i.test(message)) return { title: 'Choose an existing project folder', view: 'projects' as const, detail: 'Select a workspace root or independent directory, then retry.' };
  if (/rules|CLAUDE\.md|AGENTS\.md/i.test(message)) return { title: 'Apply current shared rules', view: 'rules' as const, detail: 'Apply the saved rules to this session’s directory before retrying.' };
  if (/auth|login|sign.in|unauthorized|401|subscription|billing|quota|429/i.test(message)) return { title: 'Review the CLI account and provider limits', view: 'accounts' as const, detail: 'Use the correct account profile. Login checks do not verify model access or billing.' };
  if (/model|reasoning|config|toml|json|flag|argument/i.test(message)) return { title: 'Review model and CLI configuration', view: 'accounts' as const, detail: 'Run diagnostics and test local CLI defaults. Engine settings retain their raw values.' };
  return { title: exitCode ? `Investigate CLI exit ${exitCode}` : 'Check the local CLI', view: 'accounts' as const, detail: 'Review the recorded diagnostic and run connection checks. The exit code alone does not identify the cause.' };
}
export function redactDiagnostic(value: unknown, home: string, project: string | null): unknown {
 if (typeof value === 'string') { let text = value; for (const [source, replacement] of [[project, '<project>'], [home, '~']] as const) { if (source) { const escaped = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); text = text.replace(new RegExp(escaped, 'gi'), replacement); } } return text; }
 if (Array.isArray(value)) return value.map((item) => redactDiagnostic(item, home, project));
 if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDiagnostic(item, home, project)]));
 return value;
}
