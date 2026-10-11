export interface GitHubRepository { nameWithOwner: string; description: string | null; isPrivate: boolean; updatedAt: string }
export type ProjectRequest = { action: 'github-list'; owner?: string } | { action: 'github-clone'; repository: string; parent: string } | { action: 'create'; parent: string; name: string; initializeGit: boolean } | { action: 'validate'; directory: string };
export type ProjectResponse = GitHubRepository[] | { directory: string };
