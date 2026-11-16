import { describe, expect, it } from 'vitest';
import { BridgeReplySchema, BridgeRequestSchema } from '../src/schema.js';
const status = {calendarBackend:'desktop',calendarAuth:'disconnected',revision:1,iot:{running:false,bindAddress:null,port:8787,deviceCount:0,selectedDeviceId:null}};
const reply = (data:unknown) => ({v:1,id:'synthetic-phone-hub',ok:true,data});
describe('phone hub bridge boundary', () => {
  it('accepts fixed empty native setup/status operations', () => {
    for(const op of ['app.phoneHubStatus','app.configurePhoneHub']) {
      expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic-hub',op,args:{}}).success).toBe(true);
      expect(BridgeRequestSchema.safeParse({v:1,id:'synthetic-hub',op,args:{token:'synthetic-secret'}}).success).toBe(false);
    }
  });
  it('accepts a bounded sanitized status', () => {
    expect(BridgeReplySchema.safeParse(reply(status)).success).toBe(true);
    expect(BridgeReplySchema.safeParse(reply({...status,calendarBackend:'phone',calendarAuth:'ready',iot:{...status.iot,running:true,bindAddress:'192.168.42.1',deviceCount:1,selectedDeviceId:'synthetic_device'}})).success).toBe(true);
  });
  it('rejects secrets and unsafe or inconsistent listener addresses', () => {
    expect(BridgeReplySchema.safeParse(reply({...status,accessToken:'synthetic-secret'})).success).toBe(false);
    for(const bindAddress of ['0.0.0.0','127.0.0.1','8.8.8.8','192.168.001.2','192.168.42.256',null]) {
      expect(BridgeReplySchema.safeParse(reply({...status,iot:{...status.iot,running:true,bindAddress}})).success).toBe(false);
    }
    expect(BridgeReplySchema.safeParse(reply({...status,iot:{...status.iot,deviceCount:9}})).success).toBe(false);
  });
});
