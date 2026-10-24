import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { TailscaleState } from '../../../shared/remote';

export type RunTailscale = (args: string[]) => Promise<string>;
const CANDIDATES = process.platform === 'win32'
  ? [process.env.ProgramFiles && `${process.env.ProgramFiles}\\Tailscale\\tailscale.exe`, 'tailscale.exe']
  : process.platform === 'darwin' ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale', 'tailscale'] : ['/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale'];

/** The CLI to run, looked up on every call so Tailscale installed while Trace is open is found without a restart. */
export const tailscaleExecutable = (exists: (file: string) => boolean = fs.existsSync, candidates: (string | undefined)[] = CANDIDATES) =>
  candidates.find((candidate): candidate is string => Boolean(candidate) && (!candidate!.includes('/') && !candidate!.includes('\\') || exists(candidate!))) ?? 'tailscale';

/** Runs the tailscale CLI by fixed arguments only; nothing a phone or page sends reaches its command line. */
export function tailscaleRunner(): RunTailscale {
  return (args) => new Promise((resolve, reject) => execFile(tailscaleExecutable(), args, { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(Object.assign(new Error(String(stderr || error.message).trim().split('\n')[0].slice(0, 300)), { code: (error as NodeJS.ErrnoException).code })); else resolve(stdout);
  }));
}

const proxies = (value: unknown, port: number) => typeof value === 'string' && new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}/?$`).test(value);

/** Reads whether Tailscale is connected, this computer's tailnet name, and whether HTTPS on the tailnet reaches the remote. */
export async function tailscaleState(run: RunTailscale, port: number): Promise<TailscaleState> {
  const state: TailscaleState = { installed: false, running: false, host: null, serving: false, funnel: false, error: null };
  let status: { BackendState?: string; Self?: { DNSName?: string } };
  try { status = JSON.parse(await run(['status', '--json'])); state.installed = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return state;
    // The CLI exits with an error when Tailscale is installed but stopped or signed out.
    return { ...state, installed: true, error: (error as Error).message || 'Tailscale is not running.' };
  }
  state.running = status.BackendState === 'Running';
  state.host = status.Self?.DNSName?.replace(/\.$/, '') || null;
  if (!state.running) return { ...state, error: `Tailscale is ${status.BackendState?.toLowerCase() ?? 'not connected'}. Open Tailscale and sign in.` };
  try {
    const serve = JSON.parse((await run(['serve', 'status', '--json'])).trim() || '{}') as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>; AllowFunnel?: Record<string, boolean> };
    // Only HTTPS on this computer's tailnet name at port 443 counts: that is the address the pairing link names.
    for (const [hostPort, web] of Object.entries(serve.Web ?? {})) {
      if (hostPort.toLowerCase() !== `${state.host?.toLowerCase()}:443` || !proxies(web.Handlers?.['/']?.Proxy, port)) continue;
      state.serving = true; if (serve.AllowFunnel?.[hostPort]) state.funnel = true;
    }
  } catch (error) { state.error = (error as Error).message; }
  return state;
}

/** Points HTTPS on the tailnet (port 443 of this computer's tailnet name) at the remote. It stays set across restarts. */
export async function serveRemote(run: RunTailscale, port: number) { await run(['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]); }
