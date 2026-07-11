import { describe, expect, test } from 'bun:test';
import { createNotificationTriggerRuntime } from './runtime.js';

describe('notification permission auto-accept mirror', () => {
  test('suppresses notifications but does not reply to permissions', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response('true', { status: 200 });
    };

    try {
      const runtime = createNotificationTriggerRuntime({
        buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
        getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      });
      runtime.setAutoAcceptSession('session-1', true);

      await runtime.maybeSendPushForTrigger({
        type: 'permission.asked',
        properties: {
          id: 'permission-1',
          sessionID: 'session-1',
          directory: '/repo',
          permission: 'bash',
        },
      });

      // Characterizes the lock-screen bug: this runtime only suppresses the
      // notification. When server-side handling is enabled, the daemon watcher
      // must own the reply; otherwise the existing client behavior remains.
      expect(calls).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
