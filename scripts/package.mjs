import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PackageError } from './lib/frontend.mjs';
import { packageProject } from './lib/package-build.mjs';
import { run } from './lib/run.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--build')) {
  console.error('Usage: npm run package [-- --build]\n  --build  run "npm run build" first (default: package the existing build output)');
  process.exit(2);
}
try {
  if (args.includes('--build')) {
    const npm = process.env.npm_execpath;
    if (!npm) throw new Error('Run this command through npm.');
    run(process.execPath, [npm, 'run', 'build'], { cwd: root });
  }
  packageProject({ root, log: line => console.log(line) });
  console.log('Wrote artifacts/SHA256SUMS and artifacts/phone-monitor-manifest.json. Verify with: (cd artifacts && sha256sum -c SHA256SUMS)');
} catch (error) {
  if (error instanceof PackageError) {
    console.error('Packaging refused:');
    for (const problem of error.problems) console.error(`  - ${problem}`);
  } else console.error(error instanceof Error ? error.message : error);
  process.exit(error?.status && Number.isInteger(error.status) ? error.status : 1);
}
