import { performance } from 'node:perf_hooks';
import { TokenStore, defaultConfigDirectory, listNotificationApps } from './config.js';
import { PairingSession } from './pairing.js';
import { HubStore } from './store.js';
import { buildHub } from './server.js';
import { HubCollectors } from './collectors/index.js';
import { NotificationCollector } from './collectors/notifications.js';
import { HostCollector } from './collectors/host.js';
import { AllowlistSync } from './notification-sync.js';
import { runNotificationsCommand } from './notifications-cli.js';
import { resolveCodexPath } from './codex-path.js';

const args = process.argv.slice(2);
if (args[0] === 'notifications') {
  // Laptop-side setup: edit this app's private allowlist only; a running hub applies it within seconds.
  process.exitCode = await runNotificationsCommand(args,defaultConfigDirectory());
} else if (args.some(arg=>arg !== '--pair') || args.length > 1) {
  console.error('Usage: phone-monitor [--pair] | phone-monitor notifications allow|remove|list [APP_LABEL]'); process.exitCode = 1;
} else {
  const tokenStore = new TokenStore();
  const pairing = new PairingSession(tokenStore);
  const clock = {nowMs:()=>Date.now(),monotonicMs:()=>performance.now()};
  let allowlist: string[] = [];
  try { allowlist = listNotificationApps(tokenStore.directory); } catch { allowlist = []; }
  const store = new HubStore({notificationAllowlist:allowlist});
  const host = new HostCollector({store});
  // Refresh media/mic/DND right after a Deck key so its lit state follows quickly.
  const app = buildHub({store,pairing,tokenStore,clock,afterAction:()=>void host.poll()});
  const collectors = new HubCollectors({store,configDir:tokenStore.directory,nowMs:clock.nowMs,codex:{codexPath:resolveCodexPath({configDir:tokenStore.directory})}});
  const notifications = new NotificationCollector({store,clock});
  const allowlistSync = new AllowlistSync({configDir:tokenStore.directory,apply:async labels=>{store.setNotificationAllowlist(labels);await notifications.start(labels);}});
  const stop = () => { pairing.close(); allowlistSync.stop(); host.stop(); void Promise.all([notifications.stop(),collectors.stop(),app.close()]); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    tokenStore.read();
    await app.listen({host:'127.0.0.1',port:8765});
    await collectors.start();
    host.start();
    await allowlistSync.start();
    if (args.includes('--pair')) console.log(`Pairing code: ${pairing.open(clock.nowMs())} (expires in 120 seconds)`);
    console.log('Phone Monitor hub listening on 127.0.0.1:8765');
  } catch {
    console.error('Hub startup failed. Check private configuration and port 8765 availability.');
    allowlistSync.stop(); host.stop();
    await Promise.all([notifications.stop(),collectors.stop()]);
    await app.close(); process.exitCode = 1;
  }
}
