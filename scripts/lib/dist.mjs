import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));

// Setup scripts are thin wrappers over the compiled, unit-tested desktop modules.
export async function loadDist(name) {
  const file = new URL(`../../desktop/dist/${name}.js`, import.meta.url);
  if (!existsSync(file)) {
    console.error('The desktop hub is not built. Run: npm run build --workspace @phone-monitor/desktop');
    process.exit(1);
  }
  return import(pathToFileURL(fileURLToPath(file)).href);
}
export const io = { out: line => console.log(line), err: line => console.error(line) };
