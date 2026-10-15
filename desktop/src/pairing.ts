import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { TokenStore } from './config.js';

export class PairingSession {
  private code: string | null = null;
  private openedAt = 0;
  private failures = 0;
  constructor(private readonly tokenStore: TokenStore) {}
  open(nowMs: number): string {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('BAD_PAYLOAD');
    this.code = randomInt(0,100_000_000).toString().padStart(8,'0');
    this.openedAt = nowMs; this.failures = 0;
    return this.code;
  }
  close(): void { this.code = null; this.failures = 0; }
  private requireOpen(nowMs: number): string {
    if (this.code === null) throw new Error('PAIRING_CLOSED');
    if (!Number.isSafeInteger(nowMs) || nowMs < this.openedAt || nowMs-this.openedAt >= 120000) {
      this.close(); throw new Error('PAIRING_EXPIRED');
    }
    return this.code;
  }
  rejectAttempt(nowMs: number): never {
    this.requireOpen(nowMs);
    this.failures += 1;
    if (this.failures >= 5) this.close();
    throw new Error('BAD_PAIRING_CODE');
  }
  exchange(code: string, nowMs: number): {token:string} {
    const expected = this.requireOpen(nowMs);
    if (!/^\d{8}$/.test(code) || !timingSafeEqual(Buffer.from(code),Buffer.from(expected))) return this.rejectAttempt(nowMs);
    const token = randomBytes(32).toString('hex');
    // All steps are synchronous in one event-loop turn. Closing only after
    // persistence succeeds preserves both the old token and a retryable setup.
    try { this.tokenStore.write(token); } catch { throw new Error('TOKEN_PERSIST_FAILED'); }
    this.close(); return {token};
  }
}
