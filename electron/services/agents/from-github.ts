import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentDefinitionSchema, definitionProblems } from '../../../shared/agent-definition';
import type { AgentFetched } from '../../../shared/agents';
import { HubError } from '../cli/engine-adapter';
import { fetchRepo, githubUrl, parseSource, systemGit, type Git, type RepoUrl } from '../plugins/github';

/**
 * "From a list" (docs/custom-agents.md, phase 2): a shared definition is a GitHub repository with the topic `trace-agent`
 * holding `trace-agent.json`. It is fetched with the computer's own Git as plugins are (plugins/github.ts), checked here,
 * and handed to the form: saving it still goes through the native confirmation, and nothing from it runs before that.
 */
export const AGENT_FILE = 'trace-agent.json';
const MAX_BYTES = 64 * 1024;

export async function fetchDefinition(repo: string, git: Git = systemGit, url: RepoUrl = githubUrl): Promise<AgentFetched> {
  let source: ReturnType<typeof parseSource>;
  try { source = parseSource(repo); } catch { throw new HubError('AGENT_SOURCE', 'Enter a GitHub repository as owner/repo, or paste its github.com address.'); }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-agent-'));
  try {
    const commit = await fetchRepo(source, dir, git, url);
    const file = path.join(dir, ...(source.folder ? source.folder.split('/') : []), AGENT_FILE);
    let stat: fs.Stats; try { stat = fs.lstatSync(file); } catch { throw new HubError('AGENT_SOURCE', `${source.repo} has no ${AGENT_FILE}, so it holds no Trace agent.`); }
    // A link (or a folder that is one) could point at a file elsewhere on this computer: only a plain file inside the copy.
    if (!stat.isFile() || stat.size > MAX_BYTES || !fs.realpathSync(file).startsWith(fs.realpathSync(dir) + path.sep)) throw new HubError('AGENT_SOURCE', `${AGENT_FILE} in ${source.repo} is not a plain file under 64 KB.`);
    let data: unknown; try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { data = null; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HubError('AGENT_SOURCE', `${AGENT_FILE} in ${source.repo} is not a JSON object.`);
    const parsed = agentDefinitionSchema.safeParse(data);
    return { definition: data as Record<string, unknown>, problems: parsed.success ? [] : definitionProblems(parsed.error), source: { repo: source.repo, commit } };
  } finally {
    // Windows refuses to delete Git's read-only object files for a moment after git exits: retried, else left in temp.
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* Left in the temp folder. */ }
  }
}
