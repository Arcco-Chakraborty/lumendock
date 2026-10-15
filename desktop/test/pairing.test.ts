import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TokenStore } from '../src/config.js';
import { PairingSession } from '../src/pairing.js';

const dirs: string[] = [];
const makeStore = () => { const dir = mkdtempSync(join(tmpdir(),'phone-monitor-synthetic-')); dirs.push(dir); return new TokenStore(join(dir,'app')); };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true}); });
describe('setup-only atomic pairing', () => {
  it('starts closed and accepts one cryptographic eight-digit code once', () => {
    const store = makeStore(); const pairing = new PairingSession(store);
    expect(() => pairing.exchange('12345678',0)).toThrow('PAIRING_CLOSED');
    const code = pairing.open(1000); expect(code).toMatch(/^\d{8}$/);
    const result = pairing.exchange(code,2000); expect(result.token).toMatch(/^[a-f0-9]{64}$/);
    expect(store.matchesBearer(`Bearer ${result.token}`)).toBe(true);
    expect(() => pairing.exchange(code,2001)).toThrow('PAIRING_CLOSED');
  });
  it('closes on the fifth total failure, including malformed codes', () => {
    const pairing = new PairingSession(makeStore()); const code = pairing.open(0);
    const wrong = code === '00000000' ? '00000001' : '00000000';
    for (const input of [wrong,'bad',wrong,'',wrong]) expect(() => pairing.exchange(input,1)).toThrow('BAD_PAIRING_CODE');
    expect(() => pairing.exchange(code,2)).toThrow('PAIRING_CLOSED');
  });
  it('rejects at the exact 120000-ms deadline', () => {
    const pairing = new PairingSession(makeStore()); const code = pairing.open(1000);
    expect(() => pairing.exchange(code,121000)).toThrow('PAIRING_EXPIRED');
    expect(() => pairing.exchange(code,121001)).toThrow('PAIRING_CLOSED');
  });
  it('makes concurrent exchange attempts yield only one usable token', async () => {
    const store = makeStore(); const pairing = new PairingSession(store); const code = pairing.open(0);
    const results = await Promise.allSettled([Promise.resolve().then(() => pairing.exchange(code,1)),Promise.resolve().then(() => pairing.exchange(code,1))]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
  });
  it('keeps the old token during setup, replaces privately, and reloads it', () => {
    const store = makeStore(); const old = 'a'.repeat(64); store.write(old);
    const pairing = new PairingSession(store); const code = pairing.open(0);
    expect(store.matchesBearer(`Bearer ${old}`)).toBe(true);
    expect(store.matchesBearer(`bearer ${old}`)).toBe(false);
    expect(store.matchesBearer(`Bearer ${old}x`)).toBe(false);
    const replacement = pairing.exchange(code,1).token;
    expect(store.matchesBearer(`Bearer ${old}`)).toBe(false);
    expect(new TokenStore(store.directory).read()).toBe(replacement);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.directory,'phone-token')).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(store.directory,'phone-token'),'utf8').trim()).toBe(replacement);
  });
  it('preserves the old token if replacement persistence fails', () => {
    const store = makeStore(); const old = 'a'.repeat(64); store.write(old);
    const pairing = new PairingSession(store); const code = pairing.open(0);
    const actualWrite = store.write.bind(store); store.write = () => { throw new Error('synthetic write failure'); };
    expect(() => pairing.exchange(code,1)).toThrow('TOKEN_PERSIST_FAILED');
    expect(store.matchesBearer(`Bearer ${old}`)).toBe(true);
    store.write = actualWrite;
    expect(pairing.exchange(code,2).token).toMatch(/^[a-f0-9]{64}$/);
  });
  it('rejects malformed persisted tokens rather than accepting them as authorization', () => {
    const store = makeStore(); store.write('a'.repeat(64));
    writeFileSync(join(store.directory,'phone-token'),'bad',{mode:0o600});
    expect(() => new TokenStore(store.directory).read()).toThrow('BAD_TOKEN_FILE');
  });
});
