import type { CodingHubHost } from '../shared/ipc';

declare global {
  interface Window { codingHub?: CodingHubHost }
}
