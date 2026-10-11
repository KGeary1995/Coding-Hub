export interface ManagedWorktree { id: string; repository: string; directory: string; branch: string; createdAt: string }
export type ProjectToolsRequest = { action: 'worktree-list' } | { action: 'worktree-create'; directory: string } | { action: 'worktree-remove'; id: string };
export type ProjectToolsResponse = ManagedWorktree[] | ManagedWorktree | null;
