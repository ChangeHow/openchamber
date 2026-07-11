import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerBackgroundAutoAcceptRoutes } from './background-auto-accept-routes.js';

const createApp = (dependencies) => {
  const app = express();
  app.use(express.json());
  registerBackgroundAutoAcceptRoutes(app, dependencies);
  return app;
};

describe('background auto-accept routes', () => {
  it('returns and atomically replaces the authoritative state', async () => {
    let state = { enabled: false, sessions: {} };
    const persistSettings = vi.fn(async () => ({}));
    const app = createApp({
      persistSettings,
      getState: () => state,
      setState: (next) => { state = next; },
    });
    const next = { enabled: true, sessions: { parent: true, child: false } };

    await request(app).put('/api/openchamber/background-auto-accept').send(next).expect(200, next);
    await request(app).get('/api/openchamber/background-auto-accept').expect(200, next);
    expect(persistSettings).toHaveBeenCalledWith({ backgroundAutoAccept: next });
  });

  it('rejects partial payloads and preserves state when persistence fails', async () => {
    const state = { enabled: false, sessions: {} };
    const setState = vi.fn();
    const app = createApp({
      persistSettings: vi.fn(async () => { throw new Error('disk full'); }),
      getState: () => state,
      setState,
    });

    await request(app).put('/api/openchamber/background-auto-accept').send({ enabled: true }).expect(400);
    await request(app).put('/api/openchamber/background-auto-accept').send({ enabled: true, sessions: {} }).expect(500);
    expect(setState).not.toHaveBeenCalled();
    await request(app).get('/api/openchamber/background-auto-accept').expect(200, state);
  });
});
