import { performance } from 'node:perf_hooks';
import { TokenStore } from './config.js';
import { PairingSession } from './pairing.js';
import { HubStore } from './store.js';
import { buildHub } from './server.js';
import { HubCollectors } from './collectors/index.js';

const args = process.argv.slice(2);
if (args.some(arg=>arg !== '--pair') || args.length > 1) {
  console.error('Usage: phone-monitor [--pair]'); process.exitCode = 1;
} else {
  const tokenStore = new TokenStore();
  const pairing = new PairingSession(tokenStore);
  const clock = {nowMs:()=>Date.now(),monotonicMs:()=>performance.now()};
  const store = new HubStore();
  const app = buildHub({store,pairing,tokenStore,clock});
  const collectors = new HubCollectors({store,configDir:tokenStore.directory,nowMs:clock.nowMs});
  const stop = () => { pairing.close(); void Promise.all([collectors.stop(),app.close()]); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    tokenStore.read();
    await app.listen({host:'127.0.0.1',port:8765});
    await collectors.start();
    if (args.includes('--pair')) console.log(`Pairing code: ${pairing.open(clock.nowMs())} (expires in 120 seconds)`);
    console.log('Phone Monitor hub listening on 127.0.0.1:8765');
  } catch {
    console.error('Hub startup failed. Check private configuration and port 8765 availability.');
    await collectors.stop();
    await app.close(); process.exitCode = 1;
  }
}
