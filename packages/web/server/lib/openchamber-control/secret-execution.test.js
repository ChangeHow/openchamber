import { createServer } from 'node:net';
import path from 'node:path';
import { isRecord, isString } from '../shared/guards.js';
import { getEventListeners } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeSecretExecution, runSecret } from './secret-execution.js';

const inputs = [{ env: 'PASSWORD', label: 'Password' }, { env: 'OTP', label: 'One-time code' }];
const normalize = (patch = {}) => normalizeSecretExecution({ program: process.execPath, inputs, ...patch }, process.cwd(), { ...path, isString, isRecord });
const signal = () => new AbortController().signal;
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe.skipIf(process.platform === 'win32')('private-input execution', () => {
  it('normalizes defaults and refuses malformed public inputs before execution', () => {
    expect(normalize()).toMatchObject({ args: [], env: {}, workdir: process.cwd(), timeoutMs: 120000 });
    for (const patch of [
      { program: 'relative' }, { program: '/bad\0path' }, { args: [2] },
      { inputs: [] }, { inputs: [inputs[0], inputs[0]] },
      { inputs: [{ env: '__proto__', label: 'Prototype' }] },
      { inputs: [{ env: 'BAD-KEY', label: 'Key' }] },
      { inputs: [{ env: 'KEY', label: ' ' }] },
      { inputs: [{ ...inputs[0], reuse: 'true' }] }, { inputs: [{ ...inputs[0], refresh: 1 }] },
      { env: { PASSWORD: 'overlap' } }, { env: { PUBLIC: 2 } },
      { env: Object.fromEntries([['__proto__', 'public']]) },
      { workdir: 2 }, { timeoutMs: 600001 },
    ]) expect(() => normalize(patch)).toThrow(/^Invalid /);
  });

  it('injects an isolated environment and redacts literal UTF8, multiline and overlapping values across chunks', async () => {
    vi.stubEnv('UNRELATED_SECRET', 'not-inherited');
    vi.stubEnv('NODE_OPTIONS', '--invalid-inherited-hook');
    const before = { ...process.env };
    const secrets = { PASSWORD: 'synthetic.*[密]\nlong', OTP: 'synthetic.*[密]' };
    const request = normalize({ env: { PUBLIC: 'explicit' }, args: ['-e', `
      const { PASSWORD, OTP, PUBLIC, UNRELATED_SECRET, NODE_OPTIONS } = process.env;
      const data = Buffer.from(PASSWORD + '|' + OTP);
      for (const byte of data) process.stdout.write(Buffer.from([byte]));
      process.stderr.write(OTP + '|' + PASSWORD);
      process.stdout.write(JSON.stringify({ PUBLIC, UNRELATED_SECRET, NODE_OPTIONS, args: process.argv.slice(1) }));
    `, 'spaces and quotes \'"', '$(not-a-shell)'] });
    const controller = new AbortController();
    const result = await runSecret(request, secrets, controller.signal);
    expect(result).toMatchObject({ status: 'completed', exitCode: 0, stderr: '[REDACTED]|[REDACTED]' });
    expect(result.stdout).toBe('[REDACTED]|[REDACTED]{"PUBLIC":"explicit","args":["spaces and quotes \'\\\"","$(not-a-shell)"]}');
    expect(process.env).toEqual(before);
    expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    for (const value of Object.values(secrets)) expect(JSON.stringify(result)).not.toContain(value);
  });

  it('discards all output above the combined cap, including partial secret prefixes', async () => {
    const result = await runSecret(normalize({ args: ['-e', "process.stdout.write('partial'); process.stderr.write('x'.repeat(1024 * 1024));"] }), { PASSWORD: 'partial-secret', OTP: 'code' }, signal());
    expect(result).toMatchObject({ status: 'output_limit', stdout: '', stderr: 'Process output limit exceeded; output discarded.' });
  });

  it('keeps a nonzero exit and hides spawn error details', async () => {
    const secrets = { PASSWORD: 'synthetic-password', OTP: 'code' };
    expect(await runSecret(normalize({ args: ['-e', 'process.stderr.write(process.env.PASSWORD); process.exit(23)'] }), secrets, signal()))
      .toEqual({ status: 'failed', exitCode: 23, stdout: '', stderr: '[REDACTED]' });
    expect(await runSecret(normalize({ program: '/does-not-exist' }), secrets, signal()))
      .toEqual({ status: 'failed', exitCode: null, stdout: '', stderr: 'Process could not be started.' });
  });

  it('does not start an already cancelled call', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runSecret(normalize(), { PASSWORD: 'password', OTP: 'code' }, controller.signal))
      .toEqual({ status: 'cancelled', exitCode: null, stdout: '', stderr: '' });
  });

  it.each(['cancelled', 'timeout', 'completed'])('%s kills descendants holding inherited pipes', async (reason) => {
    // A descendant keeps an open socket and inherited pipes. The socket's close
    // proves it was killed; readiness drives cancellation without timing races.
    let ready;
    const connected = new Promise((resolve) => { ready = resolve; });
    let disconnected;
    const closed = new Promise((resolve) => { disconnected = resolve; });
    const server = createServer((socket) => {
      socket.once('data', () => ready());
      socket.once('close', () => disconnected());
    });
    await new Promise((resolve) => server.listen(0, 'localhost', resolve));
    const port = server.address().port;
    const controller = new AbortController();
    const descendant = `const socket = require('node:net').connect(${port}, 'localhost', () => socket.write('ready')); setInterval(() => {}, 1000);`;
    const request = normalize({ timeoutMs: 5000, args: ['-e', `
      const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { stdio: 'inherit' });
      ${reason === 'completed' ? "child.once('spawn', () => process.exit(0));" : 'setInterval(() => {}, 1000);'}
    `] });
    // Normal completion must wait until the descendant connects as well.
    if (reason === 'completed') request.args[1] = `
      const net = require('node:net');
      const server = net.createServer((socket) => { socket.once('data', () => process.exit(0)); });
      server.listen(0, 'localhost', () => require('node:child_process').spawn(process.execPath, ['-e',
        "const net = require('node:net'); const socket = net.connect(${port}, 'localhost', () => { socket.write('ready'); net.connect(" + server.address().port + ", 'localhost', function () { this.write('ready'); }); }); setInterval(() => {}, 1000);"
      ], { stdio: 'inherit' }));
    `;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = runSecret(request, { PASSWORD: 'password', OTP: 'code' }, controller.signal);
    try {
      await connected;
      if (reason === 'cancelled') controller.abort();
      if (reason === 'timeout') vi.advanceTimersByTime(5000);
      expect((await pending).status).toBe(reason);
      await closed;
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    } finally {
      controller.abort();
      await pending;
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('settles when a descendant escaped the process group', async () => {
    // The detached grandchild becomes its own process-group leader, so the
    // group kill cannot reach it, and it holds the inherited pipes: only the
    // grace settle after the kill can finish the run. Readiness arrives over
    // a socket so the escape is proven before the leader exits.
    let ready;
    const connected = new Promise((resolve) => { ready = resolve; });
    const server = createServer((socket) => socket.once('data', () => ready()));
    await new Promise((resolve) => server.listen(0, 'localhost', resolve));
    const port = server.address().port;
    const controller = new AbortController();
    const request = normalize({ timeoutMs: 100, args: ['-e', `
      require('node:child_process').spawn(process.execPath, ['-e',
        "const socket = require('node:net').connect(${port}, 'localhost', () => socket.write('ready')); setTimeout(() => process.exit(0), 8000); setInterval(() => {}, 1000);"],
        { detached: true, stdio: 'inherit' });
      process.exit(0);
    `] });
    try {
      // Before the grace settle this promise never resolved: the escaped
      // descendant kept the pipes open after the leader and group died.
      expect(await runSecret(request, { PASSWORD: 'password', OTP: 'code' }, controller.signal))
        .toEqual({ status: 'timeout', exitCode: 0, stdout: '', stderr: '' });
      expect(getEventListeners(controller.signal, 'abort')).toEqual([]);
    } finally {
      controller.abort();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
