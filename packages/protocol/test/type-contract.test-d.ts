import type { BridgeReplyData, BridgeRequest, HubSnapshot, LinkSnapshot } from '../src/index.js';

type Assert<T extends true> = T;
type Equal<A,B> = (<T>()=>T extends A ? 1 : 2) extends (<T>()=>T extends B ? 1 : 2) ? true : false;
// Protect the generic Zod link schema's payload against loss/optional inference.
type HubReplyHasExactPayload = Assert<Equal<BridgeReplyData<'hub.snapshot'>,LinkSnapshot<HubSnapshot>>>;
type BrightnessHasExactArgs = Assert<Equal<Extract<BridgeRequest,{op:'app.setBrightness'}>['args'],{value:number}>>;
type SetupHasExactReply = Assert<Equal<BridgeReplyData<'app.setupHub'>,{setupId:string;started:boolean}>>;

import type { CalendarPage, CalendarRangeRequest, CalendarSourcesPage, CalendarSelectReply } from '../src/index.js';
type CalendarReplyHasExactPayload = Assert<Equal<BridgeReplyData<'hub.calendar'>,LinkSnapshot<CalendarPage>>>;
type CalendarSourcesReplyHasExactPayload = Assert<Equal<BridgeReplyData<'hub.calendarSources'>,LinkSnapshot<CalendarSourcesPage>>>;
type CalendarSelectHasExactReply = Assert<Equal<BridgeReplyData<'hub.calendarSelect'>,CalendarSelectReply>>;
type CalendarHasExactArgs = Assert<Equal<Extract<BridgeRequest,{op:'hub.calendar'}>['args'],CalendarRangeRequest>>;
