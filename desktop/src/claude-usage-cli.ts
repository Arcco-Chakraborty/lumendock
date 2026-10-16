import { existsSync } from 'node:fs';
import { claudeUsagePollingEnabled, setClaudeUsagePolling } from './config.js';
import { claudeCredentialsPath } from './collectors/claude-usage.js';

const USAGE = 'Usage: claude-usage on | claude-usage off | claude-usage status';
// Only checks that Claude Code's sign-in file exists; its contents are read by the hub alone, at poll time.
export async function runClaudeUsageCommand(argv: readonly string[], configDir: string, out: (line: string) => void = console.log, credentialsPath = claudeCredentialsPath()): Promise<number> {
  const args = argv[0] === 'claude-usage' ? argv.slice(1) : argv;
  if (args.length !== 1 || !['on','off','status'].includes(args[0]!)) { out(USAGE); return 2; }
  const signedIn = existsSync(credentialsPath);
  try {
    if (args[0] !== 'status') await setClaudeUsagePolling(configDir,args[0] === 'on');
  } catch { out('The setting could not be saved. The private config file was not changed.'); return 1; }
  const on = claudeUsagePollingEnabled(configDir);
  out(on
    ? 'Claude usage polling is on. While the phone is connected, the hub uses the sign-in Claude Code keeps on this laptop to ask Anthropic for your usage every 3 minutes, with no Claude session open. The token is never refreshed, copied or sent to the phone.'
    : 'Claude usage polling is off. Claude usage updates only while a Claude Code session refreshes its status line.');
  if (on && !signedIn) out('Claude Code is not signed in on this laptop yet. Run `claude` once and sign in.');
  if (args[0] !== 'status') out('A running hub picks this up within a few seconds.');
  return 0;
}
