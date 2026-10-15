import { existsSync, readdirSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { readPrivateJson } from './private-files.js';

// The Codex CLI is often only installed inside the VS Code/Cursor extension, not on PATH.
// Resolution order: PHONE_MONITOR_CODEX env, `codexPath` in this app's private config.json,
// `codex` on PATH, then the newest bundled extension binary. The collector still verifies the
// exact compatible version before using whichever path is found.
export interface CodexPathOptions { env?: NodeJS.ProcessEnv; configDir: string; home?: string }
const executable = (path: string) => { try { const s = statSync(path); return s.isFile() && (s.mode & 0o111) !== 0; } catch { return false; } };
export function codexCandidates(options: CodexPathOptions): string[] {
  const env = options.env ?? process.env, home = options.home ?? homedir(), found: string[] = [];
  const explicit = env.PHONE_MONITOR_CODEX;
  if (explicit && isAbsolute(explicit)) found.push(explicit);
  try {
    const config = readPrivateJson(join(options.configDir, 'config.json')) as Record<string, unknown> | null;
    if (config && typeof config.codexPath === 'string' && isAbsolute(config.codexPath)) found.push(config.codexPath);
  } catch { /* unreadable config: fall through to discovery */ }
  for (const dir of (env.PATH ?? '').split(delimiter)) if (dir && isAbsolute(dir)) found.push(join(dir, 'codex'));
  for (const root of ['.vscode/extensions', '.vscode-server/extensions', '.cursor/extensions']) {
    const base = join(home, root);
    if (!existsSync(base)) continue;
    let entries: string[] = [];
    try { entries = readdirSync(base).filter(name => /^openai\.chatgpt-/.test(name)); } catch { continue; }
    const bundled = entries.map(name => join(base, name, 'bin', 'linux-x86_64', 'codex'))
      .filter(executable).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    found.push(...bundled);
  }
  return [...new Set(found)];
}
export function resolveCodexPath(options: CodexPathOptions): string {
  return codexCandidates(options).find(executable) ?? 'codex';
}
