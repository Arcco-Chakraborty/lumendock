import { resolve } from 'node:path';
import { loadDist, io, root } from './lib/dist.mjs';

const { nodeRunner } = await loadDist('adb');
const { defaultConfigDirectory } = await loadDist('config');
const { systemctlUser, defaultUnitDirectory } = await loadDist('service');
const { runInstallHubCommand } = await loadDist('setup-cli');
// Optional and explicit: this script never runs unless the user invokes it, and enabling needs --enable.
process.exitCode = await runInstallHubCommand(process.argv.slice(2), {
  io, systemctl: systemctlUser(nodeRunner), nodePath: process.execPath, nodeMajor: Number(process.versions.node.split('.')[0]),
  hubPath: resolve(root, 'desktop/dist/main.js'), configDir: defaultConfigDirectory(), unitDir: defaultUnitDirectory()
});
