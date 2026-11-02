import { describe, expect, it } from 'vitest';
import { createSecretLeases } from './secret-leases.js';

const minute = 60_000;
const password = { env: 'PASSWORD', label: 'Password', reuse: true };

describe('session credential lease deadlines', () => {
  it('expires at issuance plus 10 minutes, without extending on use or sharing between sessions', () => {
    let time = 0;
    const leases = createSecretLeases({ now: () => time });
    leases.remember('first', [password, { env: 'OTP', reuse: false }], { PASSWORD: 'synthetic-password', OTP: 'synthetic-code' });
    time = 10 * minute - 1;
    expect(leases.resolve('first', [password])).toEqual({ PASSWORD: 'synthetic-password' });
    expect(leases.resolve('second', [password])).toEqual({});
    expect(leases.resolve('first', [{ env: 'OTP', reuse: true }])).toEqual({});
    time++;
    leases.sweep();
    expect(leases.resolve('first', [password])).toEqual({});
  });

  it('caps staggered issuances at the first session window deadline and starts a new window only with fresh values', () => {
    let time = 0;
    const leases = createSecretLeases({ now: () => time, ttlMs: 60 * minute });
    leases.remember('session', [password], { PASSWORD: 'synthetic-first' });
    time = 29 * minute;
    leases.remember('session', [password], { PASSWORD: 'synthetic-refresh' });
    time = 30 * minute - 1;
    expect(leases.resolve('session', [password])).toEqual({ PASSWORD: 'synthetic-refresh' });
    time++;
    expect(leases.resolve('session', [password])).toEqual({});
    leases.remember('session', [password], { PASSWORD: 'synthetic-new-window' });
    time = 60 * minute;
    expect(leases.resolve('session', [password])).toEqual({});
  });
});
