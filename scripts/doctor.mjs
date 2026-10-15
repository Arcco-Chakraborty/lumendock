import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDist, io, root } from './lib/dist.mjs';

const { runDoctorCommand } = await loadDist('setup-cli');
const { resolveCodexPath } = await loadDist('codex-path');
const { defaultConfigDirectory } = await loadDist('config');
let toolchain;
try { toolchain = JSON.parse(readFileSync(resolve(root, '.superpowers/toolchain.json'), 'utf8')); } catch { /* optional local manifest */ }
process.exitCode = await runDoctorCommand(process.argv.slice(2), {
  io,
  collect: async options => ({
    ...options, nodeVersion: process.versions.node, env: process.env, ...(toolchain ? { toolchain } : {}),
    codexPath: resolveCodexPath({ configDir: defaultConfigDirectory() }),
    // The hub imports the compiled shared protocol at runtime, so both outputs must exist.
    artifacts: { hub: existsSync(resolve(root, 'desktop/dist/main.js')) && existsSync(resolve(root, 'packages/protocol/dist/index.js')), apk: existsSync(resolve(root, 'artifacts/phone-monitor-debug.apk')) },
    fileExists: existsSync, listDir: readdirSync
  })
});
