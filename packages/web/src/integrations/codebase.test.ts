import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCodebaseRuntimeAPI } from './codebase';

test('the browser adapter calls the current host transport without capturing its endpoint', async () => {
  let endpoint = 'first';
  const calls: Array<{ endpoint: string; path: RequestInfo | URL }> = [];
  const api = createCodebaseRuntimeAPI(async (input) => {
    calls.push({ endpoint, path: input });
    return Response.json({ connected: false });
  });
  assert.deepEqual(await api.authStatus(), { connected: false });
  endpoint = 'second';
  assert.deepEqual(await api.authStatus(), { connected: false });
  assert.deepEqual(calls, [
    { endpoint: 'first', path: '/api/codebase/auth/status' },
    { endpoint: 'second', path: '/api/codebase/auth/status' },
  ]);
});

test('issue reads use the host transport across endpoint switches and reject HTTP errors', async () => {
  let endpoint = 'first';
  const calls: Array<{ endpoint: string; path: RequestInfo | URL }> = [];
  const api = createCodebaseRuntimeAPI(async (input) => {
    calls.push({ endpoint, path: input });
    return Response.json({ error: 'Issue access denied' }, { status: 403 });
  });
  await assert.rejects(() => api.issuesList('/repo path', { page: 2, query: ' title & body ', status: 'in_progress' }), /Issue access denied/);
  endpoint = 'second';
  await assert.rejects(() => api.issueGet('/repo path', 42), /Issue access denied/);
  assert.deepEqual(calls, [
    { endpoint: 'first', path: '/api/codebase/issues?directory=%2Frepo+path&page=2&query=title+%26+body&status=in_progress' },
    { endpoint: 'second', path: '/api/codebase/issue?directory=%2Frepo+path&number=42' },
  ]);
});
