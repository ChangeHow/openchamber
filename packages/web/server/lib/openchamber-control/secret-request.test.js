import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
