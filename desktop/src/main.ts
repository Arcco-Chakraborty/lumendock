import { performance } from 'node:perf_hooks';
import { TokenStore } from './config.js';
import { PairingSession } from './pairing.js';
import { HubStore } from './store.js';
import { buildHub } from './server.js';

const args = process.argv.slice(2);
if (args.some(arg=>arg !== '--pair') || args.length > 1) {
  console.error('Usage: phone-monitor [--pair]'); process.exitCode = 1;
} else {
  const tokenStore = new TokenStore();
  const pairing = new PairingSession(tokenStore);
  const clock = {nowMs:()=>Date.now(),monotonicMs:()=>performance.now()};
  const app = buildHub({store:new HubStore(),pairing,tokenStore,clock});
  const stop = () => { pairing.close(); void app.close(); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    tokenStore.read();
    await app.listen({host:'127.0.0.1',port:8765});
    if (args.includes('--pair')) console.log(`Pairing code: ${pairing.open(clock.nowMs())} (expires in 120 seconds)`);
    console.log('Phone Monitor hub listening on 127.0.0.1:8765');
  } catch {
    console.error('Hub startup failed. Check private configuration and port 8765 availability.');
    await app.close(); process.exitCode = 1;
  }
}
