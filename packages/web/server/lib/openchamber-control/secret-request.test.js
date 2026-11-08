import { describe, expect, it, vi } from 'vitest';

import { createSecretLeases } from './secret-leases.js';
import { createSecretRequests } from './secret-request.js';
const call = { sessionId: 'ses_1', callId: 'call_1', directory: '/repo' };

describe.skipIf(process.platform === 'win32')('secret.run handoff', () => {
  const input = {
    program: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.PASSWORD + ":" + process.env.OTP)'],
    inputs: [{ env: 'PASSWORD', label: 'Password' }, { env: 'OTP', label: 'Code' }],
  };
  const values = { PASSWORD: 'synthetic-password', OTP: 'synthetic-code' };
  const setup = () => {
    let started;
    const waiting = new Promise((resolve) => { started = resolve; });
    const changes = [];
    const requests = createSecretRequests({ isEnabled: async () => true, onWaitChange: (change) => { changes.push(change); if (change.type === 'waiting') started(); } });
    return { requests, waiting, changes };
  };

  it('releases all inputs once in memory and never sends them to files, events or results', async () => {
    const { requests, waiting, changes } = setup();
    const pending = requests.run(input, { ...call, directory: process.cwd() });
    await waiting;
    await expect(requests.answer({ ...call, values: { PASSWORD: values.PASSWORD } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.answer({ ...call, value: values.PASSWORD })).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.answer({ ...call, values: { ...values, OTP: '' } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.answer({ ...call, values })).resolves.toEqual({ status: 'submitted' });
    await expect(requests.answer({ ...call, values })).rejects.toMatchObject({ statusCode: 404 });
    const result = await pending;
    expect(result).toEqual({ status: 'completed', exitCode: 0, stdout: '[REDACTED]:[REDACTED]', stderr: '' });
    for (const value of Object.values(values)) expect(JSON.stringify({ changes, result })).not.toContain(value);
  });

  it('declines or aborts without starting a process or accepting late inputs', async () => {
    for (const decline of [true, false]) {
      const { requests, waiting } = setup();
      const controller = new AbortController();
      const pending = requests.run(input, { ...call, directory: process.cwd(), signal: controller.signal });
      await waiting;
      // A filled partial client state has never left the client.
      if (decline) await requests.answer({ ...call, declined: true });
      else controller.abort();
      expect(await pending).toEqual({ status: 'cancelled', exitCode: null, stdout: '', stderr: '' });
      await expect(requests.answer({ ...call, values })).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it('refuses disabled execution and cancels before waiting when chat already arrived', async () => {
    const onWaitChange = vi.fn();
    const disabled = createSecretRequests({ isEnabled: async () => false, onWaitChange });
    await expect(disabled.run(input, call)).rejects.toMatchObject({ statusCode: 403 });
    const requests = createSecretRequests({ isEnabled: async () => true, onWaitChange, hasUnreadChat: async () => true });
    expect(await requests.run(input, call)).toEqual({ status: 'cancelled', exitCode: null, stdout: '', stderr: '' });
    expect(onWaitChange).not.toHaveBeenCalled();
    await expect(requests.answer({ ...call, value: 'obsolete-file-answer' })).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe.skipIf(process.platform === 'win32')('session credential reuse', () => {
  const bindings = [{ env: 'PASSWORD', label: 'Password', reuse: true }, { env: 'OTP', label: 'Code' }];
  const input = { program: process.execPath, args: ['-e', 'process.stdout.write(process.env.PASSWORD); process.stderr.write(process.env.OTP || "")'], inputs: bindings };
  const values = { PASSWORD: 'synthetic-leased-password', OTP: 'synthetic-once-code' };
  const setup = (leases) => {
    const changes = [];
    const requests = createSecretRequests({ isEnabled: async () => true, leases, onWaitChange: (change) => changes.push(change) });
    const invoke = async (patch, callId, answers = [], sessionId = 'session') => {
      const asked = [];
      const replies = [];
      const result = await requests.run({ ...input, ...patch }, { sessionId, callId, directory: process.cwd(), onInputs: (inputs) => {
        if (!inputs.length) return;
        asked.push(inputs.map((binding) => binding.env));
        const answer = answers.shift();
        if (!answer) throw new Error('Unexpected private-input card');
        replies.push(requests.answer({ sessionId, callId, ...answer }));
      } });
      return { result, asked, replies: await Promise.all(replies) };
    };
    return { requests, invoke, changes };
  };

  it('leases only opted-in bindings, skips a fully leased card, asks only missing fields, and honors refresh', async () => {
    const { invoke, changes } = setup();
    const first = await invoke({}, 'first', [{ values }]);
    expect(first.asked).toEqual([['PASSWORD', 'OTP']]);
    const partial = await invoke({}, 'partial', [{ values: { OTP: values.OTP } }]);
    expect(partial.asked).toEqual([['OTP']]);
    expect(partial.result).toMatchObject({ status: 'completed', stdout: '[REDACTED]', stderr: '[REDACTED]', reused: ['PASSWORD'] });
    const all = await invoke({ inputs: [bindings[0]] }, 'all');
    expect(all.asked).toEqual([]);
    expect(all.result.reused).toEqual(['PASSWORD']);
    const fresh = await invoke({ inputs: [{ ...bindings[0], refresh: true }] }, 'fresh', [{ values: { PASSWORD: 'synthetic-new-password' } }]);
    expect(fresh.asked).toEqual([['PASSWORD']]);
    expect(fresh.result).not.toHaveProperty('reused');
    const other = await invoke({ inputs: [bindings[0]] }, 'other', [{ declined: true }], 'other-session');
    expect(other.result.status).toBe('cancelled');
    for (const value of [...Object.values(values), 'synthetic-new-password']) {
      expect(JSON.stringify({ first, partial, all, fresh, other, changes })).not.toContain(value);
    }
  });

  it('retains leases after a failed or declined execution and revokes only the calling session', async () => {
    const { invoke, requests } = setup();
    const failure = await invoke({ args: ['-e', 'process.exit(2)'] }, 'failure', [{ values }]);
    expect(failure.result.status).toBe('failed');
    expect((await invoke({}, 'decline', [{ declined: true }])).result.status).toBe('cancelled');
    expect((await invoke({ inputs: [bindings[0]] }, 'retry')).asked).toEqual([]);
    expect(requests.revoke('other-session')).toEqual({ status: 'revoked' });
    expect((await invoke({ inputs: [bindings[0]] }, 'still-valid')).asked).toEqual([]);
    expect(requests.revoke('session')).toEqual({ status: 'revoked' });
    expect((await invoke({ inputs: [bindings[0]] }, 'revoked', [{ declined: true }])).asked).toEqual([['PASSWORD']]);
  });

  it('keeps a submitted reusable value when cancellation ends its call', async () => {
    const controller = new AbortController();
    const requests = createSecretRequests({ isEnabled: async () => true, onWaitChange: (change) => {
      if (change.type === 'settled') controller.abort();
    } });
    let reply;
    const result = await requests.run({ ...input, inputs: [bindings[0]] }, {
      sessionId: 'session', callId: 'cancelled', directory: process.cwd(), signal: controller.signal,
      onInputs: (inputs) => {
        if (inputs.length) reply = requests.answer({ sessionId: 'session', callId: 'cancelled', values: { PASSWORD: values.PASSWORD } });
      },
    });
    await reply;
    expect(result.status).toBe('cancelled');
    const cards = vi.fn();
    expect(await requests.run({ ...input, inputs: [bindings[0]] }, {
      sessionId: 'session', callId: 'retry-cancelled', directory: process.cwd(), onInputs: cards,
    })).toMatchObject({ status: 'completed', reused: ['PASSWORD'] });
    expect(cards).toHaveBeenCalledExactlyOnceWith([], 1);
  });

  it.each(['expiry', 'revoke'])('re-asks a lease invalidated by %s while another input waits, before spawning', async (reason) => {
    let time = 0;
    const leases = createSecretLeases({ now: () => time });
    const { invoke, requests } = setup(leases);
    await invoke({ inputs: [bindings[0]] }, 'seed', [{ values: { PASSWORD: values.PASSWORD } }]);
    const asked = [];
    const replies = [];
    const result = await requests.run(input, { sessionId: 'session', callId: 'waiting', directory: process.cwd(), onInputs: (inputs) => {
      if (!inputs.length) return;
      asked.push(inputs.map((binding) => binding.env));
      if (asked.length === 1) {
        if (reason === 'expiry') time = 600_000;
        else requests.revoke('session');
        replies.push(requests.answer({ sessionId: 'session', callId: 'waiting', values: { OTP: values.OTP } }));
      } else replies.push(requests.answer({ sessionId: 'session', callId: 'waiting', values: { PASSWORD: values.PASSWORD } }));
    } });
    await Promise.all(replies);
    expect(asked).toEqual([['OTP'], ['PASSWORD']]);
    expect(result).toMatchObject({ status: 'completed', stdout: '[REDACTED]', stderr: '[REDACTED]' });
    expect(result).not.toHaveProperty('reused');
    time += 600_000;
    expect((await invoke({ inputs: [bindings[0]] }, 'expired', [{ declined: true }])).asked).toEqual([['PASSWORD']]);
  });
});
