import Fastify, { type FastifyInstance } from 'fastify';
import { PairRequestSchema } from '@phone-monitor/protocol';
import { TokenStore } from './config.js';
import { PairingSession } from './pairing.js';
import { HubStore } from './store.js';

export interface HubClock {nowMs():number; monotonicMs():number}
export interface HubOptions {store:HubStore; pairing:PairingSession; tokenStore:TokenStore; clock:HubClock}
const badPayload = {v:1,error:{code:'BAD_PAYLOAD'}};
export function buildHub({store,pairing,tokenStore,clock}: HubOptions): FastifyInstance {
  // No request logging: authorization, pairing, query strings and notification
  // payloads must never reach an access log.
  const app = Fastify({logger:false,bodyLimit:16*1024});
  app.addHook('onRequest',async (request,reply) => {
    if (request.url !== '/healthz') reply.header('cache-control','no-store');
    if (request.headers.host !== '127.0.0.1:8765' || request.headers.origin !== undefined) return reply.code(403).send({v:1,error:{code:'BAD_PAYLOAD'}});
    if (request.url.includes('?')) return reply.code(400).send(badPayload);
    if (request.method === 'POST' && request.url === '/v1/pair') {
      const contentType = request.headers['content-type']?.split(';',1)[0]?.trim().toLowerCase();
      if (contentType !== 'application/json') {
        try { pairing.rejectAttempt(clock.nowMs()); } catch { /* Count an invalid setup request without leaking setup data. */ }
        return reply.code(415).send(badPayload);
      }
    }
  });
  app.setErrorHandler((error,request,reply) => {
    if (request.url === '/v1/pair') { try { pairing.rejectAttempt(clock.nowMs()); } catch { /* Fixed safe response below. */ } }
    const status = (error as {statusCode?:number}).statusCode;
    return reply.code(status === 413 ? 413 : status === 415 ? 415 : 400).send(badPayload);
  });
  app.setNotFoundHandler((_request,reply)=>reply.code(404).send(badPayload));
  app.get('/healthz',async()=>({v:1,status:'ok'}));
  app.get('/v1/snapshot',async (request,reply) => {
    if (!tokenStore.matchesBearer(request.headers.authorization)) return reply.code(401).send({v:1,error:{code:'AUTH_REQUIRED'}});
    const snapshot = store.snapshot(clock.nowMs());
    store.markPhoneActivity(clock.monotonicMs());
    return snapshot;
  });
  app.post('/v1/pair',async (request,reply) => {
    const parsed = PairRequestSchema.safeParse(request.body);
    try {
      if (!parsed.success) pairing.rejectAttempt(clock.nowMs());
      return pairing.exchange(parsed.data!.code,clock.nowMs());
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (code === 'PAIRING_CLOSED' || code === 'PAIRING_EXPIRED') return reply.code(403).send({v:1,error:{code}});
      if (code === 'TOKEN_PERSIST_FAILED') return reply.code(503).send({v:1,error:{code}});
      return reply.code(400).send(badPayload);
    }
  });
  return app;
}
