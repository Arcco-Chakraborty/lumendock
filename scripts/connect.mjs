import { loadDist, io } from './lib/dist.mjs';

const { AdbConnection, defaultAdbPath } = await loadDist('adb');
const { runConnectCommand } = await loadDist('setup-cli');
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => abort.abort());
process.exitCode = await runConnectCommand(process.argv.slice(2), {
  io, signal: abort.signal, createAdb: adbPath => new AdbConnection({ adbPath: adbPath ?? defaultAdbPath() })
});
