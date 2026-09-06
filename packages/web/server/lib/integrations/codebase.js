import { createCodebaseHandler } from '@openchamber-plugin/codebase/server';
import express from 'express';
import { getRemoteUrl } from '../git/index.js';

export function registerCodebaseIntegration(app, { dataDirectory, resolveRemoteUrl = getRemoteUrl, fetch = globalThis.fetch }) {
  const handleRequest = createCodebaseHandler({
    dataDirectory,
    resolveRemoteUrl,
    fetch,
    basePath: '/api/codebase',
  });

  const parseJson = express.json({ limit: '16kb' });
  // Host authentication runs first. Keep parser errors from reflecting a submitted PAT.
  app.use('/api/codebase', (req, res, next) => {
    parseJson(req, res, (error) => {
      if (error) {
        const status = error.status === 413 ? 413 : 400;
        res.status(status).json({ error: status === 413 ? 'Request body too large' : 'Invalid JSON request' });
        return;
      }
      next();
    });
  });
  app.use('/api/codebase', async (req, res) => {
    try {
      const request = new Request(`http://integration.invalid${req.originalUrl}`, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
      });
      const response = await handleRequest(request);
      res.status(response.status).type('application/json').send(await response.text());
    } catch {
      res.status(500).json({ error: 'Codebase request failed' });
    }
  });
}
