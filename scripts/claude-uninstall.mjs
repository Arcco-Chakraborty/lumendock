import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDist, io, root } from './lib/dist.mjs';

const { defaultConfigDirectory } = await loadDist('config');
const { runClaudeUninstallCommand } = await loadDist('claude-cli');
process.exitCode = await runClaudeUninstallCommand(process.argv.slice(2), {
  io, settingsPath: join(homedir(), '.claude', 'settings.json'), configDir: defaultConfigDirectory(), nodePath: process.execPath,
  wrapperPath: resolve(root, 'desktop/dist/claude/wrapper.js')
});
