import { performance } from 'node:perf_hooks';
import { TokenStore, defaultConfigDirectory, listNotificationApps } from './config.js';
import { PairingSession } from './pairing.js';
import { HubStore } from './store.js';
import { buildHub } from './server.js';
import { HubCollectors } from './collectors/index.js';
import { NotificationCollector } from './collectors/notifications.js';
import { HostCollector } from './collectors/host.js';
import { VitalsReader } from './collectors/vitals.js';
import { AllowlistSync } from './notification-sync.js';
import { runNotificationsCommand } from './notifications-cli.js';
import { resolveCodexPath } from './codex-path.js';
import { ClaudeUsagePoller } from './collectors/claude-usage.js';
import { runClaudeUsageCommand } from './claude-usage-cli.js';
import { CalendarService } from './calendar/service.js';
import { runCalendarCommand } from './calendar/cli.js';
import type { HostState } from '@phone-monitor/protocol';
import { readWindowsHostState, WindowsHostHelper } from './win/host-helper.js';
import { WindowsVitalsReader } from './win/vitals.js';
import { WindowsNotificationCollector } from './win/notifications.js';
import { createRuntime, parseRuntimeOptions, type RuntimeOptions } from './runtime.js';
import { executeAction } from './actions.js';
import { executeWindowsAction } from './win/actions.js';
import { ResourceSampler, startResourceProfiler } from './resources.js';

const windows = process.platform === 'win32';

const args = process.argv.slice(2);
let options:RuntimeOptions|undefined;
try { options = parseRuntimeOptions(args); } catch { /* Subcommands have their own parsers. */ }
if (args[0] === 'notifications') {
  // Laptop-side setup: edit this app's private allowlist only; a running hub applies it within seconds.
  process.exitCode = await runNotificationsCommand(args,defaultConfigDirectory());
} else if (args[0] === 'claude-usage') {
  process.exitCode = await runClaudeUsageCommand(args,defaultConfigDirectory());
} else if (args[0] === 'calendar') {
  process.exitCode = await runCalendarCommand(args,defaultConfigDirectory());
} else if (!options) {
  console.error('Usage: phone-monitor [--pair] [--offload] [--profile-resources] | phone-monitor notifications allow|remove|list [APP_LABEL] | phone-monitor claude-usage on|off|status | phone-monitor calendar connect --client FILE|disconnect|status|help'); process.exitCode = 1;
} else {
  const tokenStore = new TokenStore();
  const pairing = new PairingSession(tokenStore);
  const clock = {nowMs:()=>Date.now(),monotonicMs:()=>performance.now()};
  let allowlist: string[] = [];
  try { allowlist = listNotificationApps(tokenStore.directory); } catch { allowlist = []; }
  const store = new HubStore({notificationAllowlist:allowlist});
  // Vitals are read only while the phone is polling, so an idle hub stays quiet.
  // Windows reads the same state through its resident PowerShell helper instead of Linux tools.
  // Asking it costs more than Linux's tools, so while no phone is watching it is asked every 15 s, not every 2 s.
  let windowsState: {state:HostState; at:number} | null = null;
  const runtime = createRuntime(options.profile, {
    windows,
    createHelper:()=>new WindowsHostHelper(),
    createVitals:helper=>windows?new WindowsVitalsReader(undefined,helper):new VitalsReader(),
    createHost:(reader,helper)=>new HostCollector({store,vitals:{reader,active:()=>store.isPhoneActive(clock.monotonicMs())},
      ...(windows?{readState:async()=>{
        const now = clock.monotonicMs();
        if (windowsState && !store.isPhoneActive(now) && now-windowsState.at<15_000) return {...windowsState.state};
        windowsState={state:await readWindowsHostState(helper!),at:now};
        return {...windowsState.state};
      }}:{})}),
    createCalendar:()=>{const service=new CalendarService({directory:tokenStore.directory,nowMs:clock.nowMs,phoneActive:()=>store.isPhoneActive(clock.monotonicMs())});return {routes:service,stop:()=>service.stop()};},
    createQuotas:()=>new HubCollectors({store,configDir:tokenStore.directory,nowMs:clock.nowMs,codex:{codexPath:resolveCodexPath({configDir:tokenStore.directory})},
      claudeUsage:{poller:new ClaudeUsagePoller(),active:()=>store.isPhoneActive(clock.monotonicMs())}}),
    createNotifications:()=>windows?new WindowsNotificationCollector({store,clock}):new NotificationCollector({store,clock}),
    createAllowlistSync:notifications=>new AllowlistSync({configDir:tokenStore.directory,apply:async labels=>{store.setNotificationAllowlist(labels);await notifications.start(labels);}}),
    executeAction:(action,getHelper)=>windows?executeWindowsAction(action,{helper:getHelper()}):executeAction(action),
  });
  const app = buildHub({store,pairing,tokenStore,clock,afterAction:()=>{void runtime.afterAction().catch(()=>undefined);},
    actionExecutor:runtime.executeAction,...(runtime.calendar?{calendar:runtime.calendar}:{})});
  const stopProfiler=options.profileResources?startResourceProfiler(new ResourceSampler(options.profile),line=>console.log(line)):()=>{};
  const stop = () => { stopProfiler(); pairing.close(); void Promise.allSettled([runtime.stop(),app.close()]); };
  process.once('SIGINT',stop); process.once('SIGTERM',stop);
  try {
    tokenStore.read();
    await app.listen({host:'127.0.0.1',port:8765});
    await runtime.start();
    if (options.pair) console.log(`Pairing code: ${pairing.open(clock.nowMs())} (expires in 120 seconds)`);
    console.log('LumenDock hub listening on 127.0.0.1:8765');
  } catch {
    console.error('Hub startup failed. Check private configuration and port 8765 availability.');
    stopProfiler();
    pairing.close();
    await runtime.stop();
    await app.close(); process.exitCode = 1;
  }
}
