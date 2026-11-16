export type RuntimeProfile = 'full' | 'offload';
export interface RuntimeOptions { profile: RuntimeProfile; pair: boolean; profileResources: boolean }
interface Service { start(): void | Promise<void>; stop(): void | Promise<void> }
export interface RuntimeDependencies<Helper extends {stop():void}, Vitals, Calendar> {
  windows: boolean;
  createHelper(): Helper;
  createVitals(helper: Helper | undefined): Vitals;
  createHost(vitals: Vitals, helper: Helper | undefined): Service & {poll():Promise<void>};
  createCalendar(): {stop():void;routes:Calendar};
  createQuotas(): Service;
  createNotifications(): {start(labels:string[]):Promise<void>;stop():void|Promise<void>};
  createAllowlistSync(notifications: {start(labels:string[]):Promise<void>;stop():void|Promise<void>}): Service;
  executeAction(action:string,getHelper:()=>Helper):Promise<{success:boolean;message?:string}>;
}
export function parseRuntimeOptions(args: readonly string[]):RuntimeOptions {
  const allowed = new Set(['--pair','--offload','--profile-resources']);
  if (new Set(args).size !== args.length || args.some(arg=>!allowed.has(arg))) throw Error('RUNTIME_ARGUMENTS');
  return {profile:args.includes('--offload')?'offload':'full',pair:args.includes('--pair'),profileResources:args.includes('--profile-resources')};
}

/** Composition has no platform/global dependencies. In offload, expensive factories are never called. */
export function createRuntime<H extends {stop():void}, V, C>(profile:RuntimeProfile,deps:RuntimeDependencies<H,V,C>) {
  let stopped = false;
  let stopping:Promise<void>|undefined;
  let helper:H|undefined;
  const getHelper = ():H => {
    if (stopped) throw Error('RUNTIME_STOPPED');
    return helper ??= deps.createHelper();
  };
  const fullHelper = profile === 'full' && deps.windows ? getHelper() : undefined;
  const host = profile === 'full' ? deps.createHost(deps.createVitals(fullHelper),fullHelper) : undefined;
  const calendar = profile === 'full' ? deps.createCalendar() : undefined;
  const quotas = deps.createQuotas();
  const notifications = deps.createNotifications();
  const allowlist = deps.createAllowlistSync(notifications);
  return {
    calendar:calendar?.routes,
    async start():Promise<void> {
      if (stopped) throw Error('RUNTIME_STOPPED');
      await quotas.start();
      if (stopped) return;
      await host?.start();
      if (stopped) return;
      await allowlist.start();
    },
    async afterAction():Promise<void> { if (!stopped) await host?.poll(); },
    executeAction(action:string):Promise<{success:boolean;message?:string}> {
      if (stopped) return Promise.reject(Error('RUNTIME_STOPPED'));
      return deps.executeAction(action,getHelper);
    },
    stop():Promise<void> {
      if (stopping) return stopping;
      stopped = true;
      // Settled cleanup runs every owned stop even when a different service fails.
      stopping = Promise.allSettled([
        () => allowlist.stop(), () => host?.stop(), () => calendar?.stop(),
        () => helper?.stop(), () => notifications.stop(), () => quotas.stop(),
      ].map(stop=>Promise.resolve().then(stop))).then(()=>undefined);
      return stopping;
    },
  };
}
