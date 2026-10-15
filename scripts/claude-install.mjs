import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadDist, io, root } from './lib/dist.mjs';

const { defaultConfigDirectory } = await loadDist('config');
const { runClaudeInstallCommand } = await loadDist('claude-cli');
// Explicit opt-in only; never runs at hub startup. Settings default to the user-level Claude file.
process.exitCode = await runClaudeInstallCommand(process.argv.slice(2), {
  io, settingsPath: join(homedir(), '.claude', 'settings.json'), configDir: defaultConfigDirectory(), nodePath: process.execPath,
  wrapperPath: resolve(root, 'desktop/dist/claude/wrapper.js'), overrideSettingsPaths: [join(homedir(), '.claude', 'settings.local.json')]
});
