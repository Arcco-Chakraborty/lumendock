import { loadDist, io } from './lib/dist.mjs';

const { nodeRunner } = await loadDist('adb');
const { defaultConfigDirectory } = await loadDist('config');
const { systemctlUser, defaultUnitDirectory } = await loadDist('service');
const { runUninstallHubCommand } = await loadDist('setup-cli');
process.exitCode = await runUninstallHubCommand(process.argv.slice(2), {
  io, systemctl: systemctlUser(nodeRunner), configDir: defaultConfigDirectory(), unitDir: defaultUnitDirectory()
});
