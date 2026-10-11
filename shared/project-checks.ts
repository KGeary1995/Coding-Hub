export type CheckName = 'test' | 'typecheck' | 'lint';
export interface InstructionFile { path: string; engine: 'claude' | 'codex'; scope: 'root' | 'nested' }
export interface ProjectAudit { directory: string; instructions: InstructionFile[]; truncated: boolean; scripts: CheckName[]; rulesApplied: boolean; warnings: string[] }
export interface CheckResult { script: CheckName; exitCode: number | null; output: string; truncated: boolean; timedOut: boolean; cancelled?: boolean }
export type ProjectCheckRequest = { action: 'inspect'; directory: string } | { action: 'run'; directory: string; script: CheckName };
