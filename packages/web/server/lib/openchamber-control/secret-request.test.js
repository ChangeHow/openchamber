import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSecretLeases } from './secret-leases.js';
import { createSecretFiles, createSecretRequests, SECRET_FILE_LIFETIME_MS } from './secret-request.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

const createHarness = async ({ enabled = true, now } = {}) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-secrets-'));
  temporaryDirectories.push(root);
  const directory = path.join(root, 'secrets');
  // An absent `now` takes the module's default clock.
  const files = createSecretFiles({ directory, now });
  const onWaitChange = vi.fn();
  const requests = createSecretRequests({ isEnabled: async () => enabled, files, onWaitChange });
  return { directory, files, requests, onWaitChange };
};

const ask = { label: 'Cloudflare API token', reason: 'To deploy the worker with wrangler.' };
const call = { sessionId: 'ses_1', callId: 'call_1', directory: '/repo' };
// The call starts waiting once its checks have run.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('secret.request', () => {
  it('writes the saved value to a private file and gives the call only its path', async () => {
    const { directory, requests, onWaitChange } = await createHarness();
    const pending = requests.request(ask, call);
    await settle();
    expect(onWaitChange).toHaveBeenCalledWith({ type: 'waiting', sessionId: 'ses_1', callId: 'call_1', title: 'Cloudflare API token', directory: '/repo' });

    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', value: 'cf-token-123' })).resolves.toEqual({ status: 'saved' });
    const result = await pending;

    expect(result.answer).toEqual({ status: 'saved', file: expect.stringContaining(directory) });
    expect(JSON.stringify(result)).not.toContain('cf-token-123');
    expect(await fs.readFile(result.answer.file, 'utf8')).toBe('cf-token-123');
    if (process.platform !== 'win32') {
      expect((await fs.stat(result.answer.file)).mode & 0o777).toBe(0o600);
      expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(onWaitChange).toHaveBeenLastCalledWith({ type: 'settled', sessionId: 'ses_1', callId: 'call_1' });
  });

  it('writes nothing when the user declines', async () => {
    const { directory, requests } = await createHarness();
    const pending = requests.request(ask, call);
    await settle();

    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', declined: true })).resolves.toEqual({ status: 'declined' });

    await expect(pending).resolves.toMatchObject({ answer: { status: 'declined' } });
    expect(await fs.readdir(directory).catch(() => [])).toEqual([]);
  });

  it('refuses an answer for a call that stopped waiting and leaves no file behind', async () => {
    const { directory, requests } = await createHarness();
    const controller = new AbortController();
    const pending = requests.request(ask, { ...call, signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).rejects.toBeTruthy();

    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', value: 'late' }))
      .rejects.toMatchObject({ statusCode: 404, message: 'This request is no longer waiting for a secret' });
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('keeps waiting after an empty value', async () => {
    const { requests } = await createHarness();
    const pending = requests.request(ask, call);
    await settle();

    await expect(requests.answer({ sessionId: 'ses_1', callId: 'call_1', value: '   ' })).rejects.toMatchObject({ statusCode: 400 });
    await requests.answer({ sessionId: 'ses_1', callId: 'call_1', value: 'v' });
    await expect(pending).resolves.toMatchObject({ answer: { status: 'saved' } });
  });

  it.each([
    [{ reason: 'why' }, 400],
    [{ label: 'Key' }, 400],
    [{ label: 'k'.repeat(121), reason: 'why' }, 400],
  ])('refuses the request %o before waiting', async (input, statusCode) => {
    const { requests, onWaitChange } = await createHarness();
    await expect(requests.request(input, call)).rejects.toMatchObject({ statusCode });
    expect(onWaitChange).not.toHaveBeenCalled();
  });

  it('does not wait when the user wrote in the chat before the card appeared', async () => {
    const { directory, onWaitChange } = await createHarness();
    const requests = createSecretRequests({ isEnabled: async () => true, files: createSecretFiles({ directory }), onWaitChange, hasUnreadChat: async () => true });

    await expect(requests.request(ask, call)).resolves.toMatchObject({ answer: { answered: false, reason: 'chat-sent-earlier' } });
    expect(onWaitChange).not.toHaveBeenCalled();
  });

  it('refuses while the tool is turned off', async () => {
    const { requests } = await createHarness({ enabled: false });
    await expect(requests.request(ask, call)).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('secret files', () => {
  it('removes a file whose write failed partway', async () => {
    const { directory } = await createHarness();
    const failing = {
      ...fs,
      writeFile: async (file, value, options) => {
        await fs.writeFile(file, String(value).slice(0, 3), options);
        throw new Error('ENOSPC');
      },
    };
    const files = createSecretFiles({ directory, fsPromises: failing });

    await expect(files.write('secret-value')).rejects.toThrow('ENOSPC');
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it('sweeps files older than 24 hours and keeps the rest', async () => {
    let now = Date.now();
    const { files } = await createHarness({ now: () => now });
    const old = await files.write('old');
    const past = new Date(now - SECRET_FILE_LIFETIME_MS - 1000);
    await fs.utimes(old, past, past);
    const fresh = await files.write('fresh');

    await files.sweep();

    await expect(fs.access(old)).rejects.toBeTruthy();
    await expect(fs.readFile(fresh, 'utf8')).resolves.toBe('fresh');
    now += SECRET_FILE_LIFETIME_MS + 1000;
    await files.sweep();
    await expect(fs.access(fresh)).rejects.toBeTruthy();
  });
});

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
    const files = { write: vi.fn(), remove: vi.fn() };
    const changes = [];
    const requests = createSecretRequests({ isEnabled: async () => true, files, onWaitChange: (change) => { changes.push(change); if (change.type === 'waiting') started(); } });
    return { requests, waiting, files, changes };
  };

  it('releases all inputs once in memory and never sends them to files, events or results', async () => {
    const { requests, waiting, files, changes } = setup();
    const pending = requests.run(input, { ...call, directory: process.cwd() });
    await waiting;
    await expect(requests.answer({ ...call, values: { PASSWORD: values.PASSWORD } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.answer({ ...call, value: values.PASSWORD })).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.answer({ ...call, values: { ...values, OTP: '' } })).rejects.toMatchObject({ statusCode: 400 });
    await expect(requests.answer({ ...call, values })).resolves.toEqual({ status: 'submitted' });
    await expect(requests.answer({ ...call, values })).rejects.toMatchObject({ statusCode: 404 });
    const result = await pending;
    expect(result).toEqual({ status: 'completed', exitCode: 0, stdout: '[REDACTED]:[REDACTED]', stderr: '' });
    expect(files.write).not.toHaveBeenCalled();
    for (const value of Object.values(values)) expect(JSON.stringify({ changes, result })).not.toContain(value);
  });

  it('declines or aborts without starting a process or accepting late inputs', async () => {
    for (const decline of [true, false]) {
      const { requests, waiting, files } = setup();
      const controller = new AbortController();
      const pending = requests.run(input, { ...call, directory: process.cwd(), signal: controller.signal });
      await waiting;
      // A filled partial client state has never left the client.
      if (decline) await requests.answer({ ...call, declined: true });
      else controller.abort();
      expect(await pending).toEqual({ status: 'cancelled', exitCode: null, stdout: '', stderr: '' });
      await expect(requests.answer({ ...call, values })).rejects.toMatchObject({ statusCode: 404 });
      expect(files.write).not.toHaveBeenCalled();
    }
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
