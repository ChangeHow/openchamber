import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import express from 'express';
import request from 'supertest';
import { registerCodebaseIntegration } from './codebase.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';

test('the host adapter preserves authentication, mount paths, and the injected Git resolver', async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-host-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  const directories = [];
  const upstreamCalls = [];
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  app.use('/api', (req, res, next) => {
    if (req.get('Authorization') !== 'Bearer host-test') return res.sendStatus(401);
    next();
  });
  registerCodebaseIntegration(app, {
    dataDirectory,
    resolveRemoteUrl: async (directory) => {
      directories.push(directory);
      return directory === '/github' ? 'git@github.com:openchamber/openchamber.git' : 'git@code.byted.org:team/repo.git';
    },
    fetch: async (url, init) => {
      const action = new URL(url).searchParams.get('Action');
      upstreamCalls.push(action);
      assert.equal(init.headers.Authorization, 'Bearer code_pat_fixture');
      if (action === 'GetUser') {
        return Response.json({ ResponseMetadata: {}, Result: { User: { Id: 'u1', Username: 'fixture' } } });
      }
      if (action === 'GetRepository') {
        assert.deepEqual(JSON.parse(init.body), { Path: 'team/repo' });
        return Response.json({
          ResponseMetadata: {},
          Result: { Repository: { Id: 'r1', Path: 'team/repo', URL: 'https://code.byted.org/team/repo', CloneURL: 'https://code.byted.org/team/repo.git', SSHURL: 'git@code.byted.org:team/repo.git', IssueEnabled: true } },
        });
      }
      if (action === 'SearchRepoIssues') {
        assert.deepEqual(JSON.parse(init.body).Filter, { Query: 'login', Status: 'todo' });
        return Response.json({ ResponseMetadata: {}, Result: { Issues: [], PageNumber: 1, PageSize: 50, TotalCount: 0 } });
      }
      if (action === 'GetIssue') {
        assert.equal(JSON.parse(init.body).Number, 42);
        return Response.json({ ResponseMetadata: {}, Result: { Issue: {
          Id: 'i1', RepoId: 'r1', Number: 42, Title: 'Login', Description: 'Issue body\n',
          Status: 'todo', CreatedAt: '2026-09-01T00:00:00Z', UpdatedAt: '2026-09-06T00:00:00Z',
        } } });
      }
      assert.equal(action, 'ListRepoMergeRequests');
      assert.equal(JSON.parse(init.body).Title, 'fix');
      return Response.json({ ResponseMetadata: {}, Result: { MergeRequests: [], PageNumber: 2, PageSize: 50, TotalCount: 101 } });
    },
  });
  app.use('/api', (_req, res) => res.json({ hostFallback: true }));

  await request(app).post('/api/codebase/auth').send({ pat: 'code_pat_fixture' }).expect(401);
  await request(app).get('/api/codebase/issues?directory=/codebase').expect(401);
  await request(app).get('/api/codebase/issue?directory=/codebase&number=42').expect(401);
  assert.deepEqual(upstreamCalls, []);
  const connect = await request(app).post('/api/codebase/auth').set('Authorization', 'Bearer host-test').send({ pat: 'code_pat_fixture' }).expect(200);
  assert.deepEqual(connect.body, { connected: true, user: { id: 'u1', username: 'fixture' } });
  assert.doesNotMatch(connect.text, /code_pat_/);

  const status = await request(app).get('/api/codebase/auth/status').set('Authorization', 'Bearer host-test').expect(200);
  assert.deepEqual(status.body, connect.body);
  const result = await request(app).get('/api/codebase/merge-requests?directory=%2Fcodebase&page=2&query=fix').set('Authorization', 'Bearer host-test').expect(200);
  assert.equal(result.body.hasMore, true);
  assert.equal(result.body.page, 2);
  assert.deepEqual(directories, ['/codebase']);

  await request(app).get('/api/codebase/merge-requests?directory=%2Fgithub').set('Authorization', 'Bearer host-test').expect(400);
  assert.deepEqual(upstreamCalls, ['GetUser', 'GetRepository', 'ListRepoMergeRequests']);
  const issues = await request(app).get('/api/codebase/issues?directory=/codebase&query=login&status=todo')
    .set('Authorization', 'Bearer host-test').expect(200);
  assert.deepEqual(issues.body.issues, []);
  const issue = await request(app).get('/api/codebase/issue?directory=/codebase&number=42')
    .set('Authorization', 'Bearer host-test').expect(200);
  assert.equal(issue.body.issue.description, 'Issue body\n');
  assert.equal(issue.body.issue.url, 'https://code.byted.org/team/repo/issues/42');
  assert.deepEqual(directories, ['/codebase', '/github', '/codebase', '/codebase']);
  await request(app).get('/api/codebase/missing').set('Authorization', 'Bearer host-test').expect(404);
  const unrelated = await request(app).get('/api/unrelated').set('Authorization', 'Bearer host-test').expect(200);
  assert.deepEqual(unrelated.body, { hostFallback: true });

  const disconnect = await request(app).delete('/api/codebase/auth').set('Authorization', 'Bearer host-test').expect(200);
  assert.deepEqual(disconnect.body, { connected: false });
});

test('the host adapter does not reflect upstream failures or invalid credentials', async (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-host-errors-'));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  let calls = 0;
  registerCodebaseIntegration(app, {
    dataDirectory,
    resolveRemoteUrl: async () => null,
    fetch: async () => {
      calls += 1;
      throw new Error('code_pat_secret');
    },
  });
  const invalid = await request(app).post('/api/codebase/auth').send({ pat: 42, extra: 'code_pat_secret' }).expect(400);
  assert.equal(calls, 0);
  assert.doesNotMatch(invalid.text, /code_pat_secret/);
  const failed = await request(app).post('/api/codebase/auth').send({ pat: 'code_pat_secret' }).expect(400);
  assert.doesNotMatch(failed.text, /code_pat_secret/);
  await request(app).get('/api/codebase/merge-requests?directory=/repo&page=0').expect(400);
});

test('the host adapter rejects malformed and oversized JSON without reflecting the body', async () => {
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  let calls = 0;
  registerCodebaseIntegration(app, {
    dataDirectory: '/unused-codebase-fixture',
    resolveRemoteUrl: async () => null,
    fetch: async () => {
      calls += 1;
      throw new Error('Unexpected upstream call');
    },
  });
  const malformed = await request(app).post('/api/codebase/auth')
    .set('Content-Type', 'application/json').send('{"pat":"code_pat_secret"').expect(400);
  assert.doesNotMatch(malformed.text, /code_pat_secret/);
  const oversized = await request(app).post('/api/codebase/auth')
    .set('Content-Type', 'application/json')
    .send(`${' '.repeat(16 * 1024)}{"pat":"code_pat_secret"}`).expect(413);
  assert.doesNotMatch(oversized.text, /code_pat_secret/);
  assert.equal(calls, 0);
});
