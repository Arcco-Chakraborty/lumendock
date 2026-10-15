import { spawnSync } from 'node:child_process';

// Structured process runner: executable plus an argument array, never a shell string.
// A nonzero exit (or a spawn failure) throws, so callers cannot accidentally continue.
export function run(executable, args = [], options = {}) {
  if (typeof executable !== 'string' || executable === '') throw new TypeError('run: executable must be a non-empty string');
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new TypeError('run: args must be an array of strings');
  const result = spawnSync(executable, args, {
    cwd: options.cwd, env: options.env, stdio: options.stdio ?? 'inherit', shell: false
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`${executable} ${args.join(' ')} failed with ${result.status === null ? `signal ${result.signal}` : `exit code ${result.status}`}`);
    error.status = result.status ?? 1;
    throw error;
  }
  return result;
}
