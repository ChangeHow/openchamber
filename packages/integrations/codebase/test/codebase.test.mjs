import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import {
  getCodebaseMergeRequestSource,
  parseCodebaseRemoteUrl,
} from '@openchamber-plugin/codebase';
import { createCodebaseHandler } from '@openchamber-plugin/codebase/server';
import {
  CodebaseAuthStoreError,
  createCodebaseAuthStore,
} from '../dist/server/storage.js';
import { createCodebaseClient } from '@openchamber-plugin/codebase/web';

const directories = [];
const user = { id: 'user-1', username: 'ada', avatarUrl: 'https://example.test/ada.png' };
const repository = {
  id: 'repo-1',
  path: 'group/repo',
  url: 'https://code.byted.org/group/repo',
  cloneUrl: 'https://code.byted.org/group/repo.git',
  sshUrl: 'git@code.byted.org:group/repo.git',
};

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codebase-integration-'));
  directories.push(directory);
  return directory;
}

function upstreamResponse(result, status = 200) {
  return new Response(JSON.stringify({ ResponseMetadata: {}, Result: result }), { status });
}

function upstreamError(token) {
  return new Response(JSON.stringify({
    ResponseMetadata: { Error: { Message: token } },
  }), { status: 200 });
}

function createUpstream(calls, mergeRequests = []) {
  return async (url, init) => {
    calls.push([url, init]);
    switch (new URL(url).searchParams.get('Action')) {
      case 'GetUser':
        return upstreamResponse({
          User: { Id: user.id, Username: user.username, AvatarURL: user.avatarUrl },
        });
      case 'GetRepository':
        return upstreamResponse({
          Repository: {
            Id: repository.id,
            Path: repository.path,
            URL: repository.url,
            CloneURL: repository.cloneUrl,
            SSHURL: repository.sshUrl,
          },
        });
      case 'ListRepoMergeRequests':
        return upstreamResponse({
          MergeRequests: mergeRequests,
          PageNumber: 2,
          PageSize: 50,
          TotalCount: 101,
        });
      default:
        throw new Error('Unexpected action');
    }
  };
}

function request(pathname, init) {
  return new Request(`http://host${pathname}`, init);
}

const upstreamIssue = {
  Id: 'issue-1',
  RepoId: repository.id,
  Number: 42,
  Title: 'Fix the issue picker',
  Description: '## Reproduction\n\n  Keep indentation.\n',
  Status: 'todo',
  CreatedAt: '2026-09-01T00:00:00Z',
  UpdatedAt: '2026-09-06T00:00:00Z',
  CreatedBy: { Username: user.username, AvatarURL: user.avatarUrl },
};

function createIssueUpstream(calls, options = {}) {
  const fallback = createUpstream(calls);
  return async (url, init) => {
    const action = new URL(url).searchParams.get('Action');
    if (action === 'GetUser') return fallback(url, init);
    calls.push([url, init]);
    if (action === 'GetRepository') {
      return upstreamResponse({ Repository: {
        Id: repository.id, Path: repository.path, URL: repository.url,
        CloneURL: repository.cloneUrl, SSHURL: repository.sshUrl,
        IssueEnabled: options.enabled ?? true,
      } });
    }
    if (options.fail) return upstreamError('code_pat_secret');
    if (action === 'SearchRepoIssues') {
      return upstreamResponse(options.list ?? {
        Issues: [upstreamIssue], PageNumber: 2, PageSize: 50, TotalCount: 101,
      });
    }
    if (action === 'GetIssue') return upstreamResponse({ Issue: options.issue ?? upstreamIssue });
    throw new Error('Unexpected issue action');
  };
}

async function issueClient(options = {}) {
  const calls = [];
  const handler = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => options.remote ?? repository.sshUrl,
    basePath: '/integration/codebase',
    fetch: createIssueUpstream(calls, options),
  });
  const api = createCodebaseClient({
    basePath: '/integration/codebase',
    fetch: (route, init) => handler(request(route, init)),
  });
  await api.authConnect('code_pat_secret');
  calls.length = 0;
  return { api, handler, calls };
}

test('issue list and detail preserve repository, pagination, search, status, and body', async () => {
  const { api, calls } = await issueClient();
  const list = await api.issuesList('/workspace with spaces', { page: 2, query: ' picker & title ', status: 'todo' });
  assert.deepEqual(list.repo, { ...repository, issuesEnabled: true });
  assert.equal(list.page, 2);
  assert.equal(list.hasMore, true);
  assert.deepEqual(list.issues[0], {
    id: upstreamIssue.Id, number: 42, title: upstreamIssue.Title,
    url: `${repository.url}/issues/42`, description: upstreamIssue.Description,
    status: 'todo', createdAt: upstreamIssue.CreatedAt, updatedAt: upstreamIssue.UpdatedAt,
    author: { username: user.username, avatarUrl: user.avatarUrl },
  });
  assert.equal(new URL(calls[1][0]).searchParams.get('Action'), 'SearchRepoIssues');
  assert.deepEqual(JSON.parse(calls[1][1].body), {
    RepoId: repository.id, Filter: { Query: 'picker & title', Status: 'todo' },
    PageNumber: 2, PageSize: 50, SortBy: 'UpdatedAt', SortOrder: 'Desc',
    Selector: { CreatedBy: true },
  });
  const detail = await api.issueGet('/workspace with spaces', 42);
  assert.deepEqual(detail, { repo: list.repo, issue: list.issues[0] });
  assert.equal(new URL(calls[3][0]).searchParams.get('Action'), 'GetIssue');
  assert.deepEqual(JSON.parse(calls[3][1].body), {
    RepoId: repository.id, Number: 42, Selector: { CreatedBy: true },
  });
  for (const [url, init] of calls) {
    assert.equal(new URL(url).origin, 'https://codebase-api.byted.org');
    assert.equal(init.headers.Authorization, 'Bearer code_pat_secret');
    assert.equal(init.redirect, 'error');
  }
});

test('issues distinguish successful empty lists and empty descriptions from failures', async () => {
  const empty = await issueClient({
    list: { Issues: [], PageNumber: 1, PageSize: 50, TotalCount: 0 },
    issue: { ...upstreamIssue, Description: '', CreatedBy: undefined },
  });
  const result = await empty.api.issuesList('/workspace');
  assert.deepEqual(result.issues, []);
  assert.equal(result.hasMore, false);
  assert.deepEqual(JSON.parse(empty.calls[1][1].body).Filter, {});
  const detail = await empty.api.issueGet('/workspace', 42);
  assert.equal(detail.issue.description, '');
  assert.equal(detail.issue.author, undefined);

  for (const options of [
    { fail: true },
    { list: { Issues: [] }, issue: { ...upstreamIssue, Description: undefined } },
    { list: { Issues: [{ ...upstreamIssue, RepoId: 'other' }], PageNumber: 1, PageSize: 50, TotalCount: 1 }, issue: { ...upstreamIssue, RepoId: 'other' } },
  ]) {
    const { api } = await issueClient(options);
    await assert.rejects(() => api.issuesList('/workspace'), /^Error: Failed to load Codebase issues$/);
    await assert.rejects(() => api.issueGet('/workspace', 42), /^Error: Failed to load Codebase issue$/);
  }
  const wrongNumber = await issueClient({ issue: { ...upstreamIssue, Number: 43 } });
  await assert.rejects(() => wrongNumber.api.issueGet('/workspace', 42));
});

test('issue routes reject invalid queries, unconnected accounts, and disabled repositories', async () => {
  const { handler, api, calls } = await issueClient();
  for (const route of [
    '/issues', '/issues?directory=/x&page=0', '/issues?directory=/x&status=open',
    '/issue?directory=/x', '/issue?directory=/x&number=0', '/issue?directory=/x&number=1.5',
  ]) {
    assert.equal((await handler(request(`/integration/codebase${route}`))).status, 400);
  }
  assert.equal(calls.length, 0);
  await api.authDisconnect();
  await assert.rejects(() => api.issuesList('/workspace'), /Codebase is not connected/);
  await assert.rejects(() => api.issueGet('/workspace', 42), /Codebase is not connected/);
  assert.equal(calls.length, 0);

  for (const options of [{ enabled: false }, { remote: 'git@github.com:group/repo.git' }]) {
    const current = await issueClient(options);
    await assert.rejects(() => current.api.issuesList('/workspace'), /Issues are not enabled|not hosted/);
    await assert.rejects(() => current.api.issueGet('/workspace', 42), /Issues are not enabled|not hosted/);
    assert.ok(current.calls.every(([url]) => new URL(url).searchParams.get('Action') === 'GetRepository'));
  }
});

afterEach(() => {
  directories.splice(0).forEach((directory) => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

test('client and handler preserve query pagination and fixed upstream details', async () => {
  const calls = [];
  const handler = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => 'git@code.byted.org:group/repo.git',
    basePath: '/api/codebase',
    fetch: createUpstream(calls, [{
      Id: 'mr-1',
      Number: 1,
      Title: 'Fix',
      URL: 'https://code.byted.org/mr/1',
      TargetBranchName: 'main',
      UpdatedAt: '2026-01-01T00:00:00Z',
      CreatedBy: { Username: 'octo', AvatarURL: 'https://example.test/octo.png' },
    }]),
  });
  const api = createCodebaseClient({
    basePath: '/api/codebase',
    fetch: (route, init) => handler(request(route, init)),
  });

  assert.deepEqual(await api.authConnect(' code_pat_secret '), {
    connected: true,
    user,
  });
  const result = await api.mergeRequestsList(' /workspace ', { page: 2, query: ' fix ' });
  assert.deepEqual(result, {
    repo: repository,
    mergeRequests: [{
      id: 'mr-1',
      number: 1,
      title: 'Fix',
      url: 'https://code.byted.org/mr/1',
      sourceBranch: '',
      targetBranch: 'main',
      sourceRepo: null,
      author: { username: 'octo', avatarUrl: 'https://example.test/octo.png' },
      draft: false,
      updatedAt: '2026-01-01T00:00:00Z',
    }],
    page: 2,
    hasMore: true,
  });
  assert.equal(calls[0][0], 'https://codebase-api.byted.org/v2/?Action=GetUser');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer code_pat_secret');
  assert.equal(calls[0][1].redirect, 'error');
  assert.match(calls[2][1].body, /"Title":"fix"/);
  assert.match(calls[2][1].body, /"TargetRepoId":"repo-1"/);
});

test('credential store distinguishes missing, malformed, unreadable, and failed writes', () => {
  const directory = temporaryDirectory();
  const store = createCodebaseAuthStore(directory);
  assert.equal(store.read(), null);
  store.write({ pat: 'code_pat_old', user });
  const credential = store.file;
  const oldContent = fs.readFileSync(credential, 'utf8');
  assert.equal(fs.statSync(credential).mode & 0o777, 0o600);

  const failingStore = createCodebaseAuthStore(directory, {
    ...fs,
    renameSync() {
      throw new Error('rename failed');
    },
  });
  assert.throws(
    () => failingStore.write({ pat: 'code_pat_new', user }),
    CodebaseAuthStoreError,
  );
  assert.equal(fs.readFileSync(credential, 'utf8'), oldContent);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
  );

  fs.writeFileSync(credential, '{bad');
  assert.throws(() => store.read(), CodebaseAuthStoreError);
  const unreadableStore = createCodebaseAuthStore(directory, {
    ...fs,
    readFileSync() {
      const error = new Error('denied');
      error.code = 'EACCES';
      throw error;
    },
  });
  assert.throws(() => unreadableStore.read(), CodebaseAuthStoreError);
});

test('handler serializes connect and disconnect after the first validation resolves', async () => {
  const events = [];
  let releaseFirst;
  let markFirstStarted;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const handler = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => null,
    basePath: '/api/codebase',
    fetch: async (_url, init) => {
      const token = init.headers.Authorization;
      events.push(`start:${token}`);
      if (token === 'Bearer code_pat_first') {
        markFirstStarted();
        await gate;
      }
      events.push(`end:${token}`);
      return upstreamResponse({ User: { Id: token.slice(-5), Username: 'user' } });
    },
  });
  const first = handler(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_first' }),
  }));
  await firstStarted;
  const disconnect = handler(request('/api/codebase/auth', { method: 'DELETE' }));
  assert.deepEqual(events, ['start:Bearer code_pat_first']);
  releaseFirst();
  await Promise.all([first, disconnect]);
  assert.deepEqual(events, ['start:Bearer code_pat_first', 'end:Bearer code_pat_first']);
  assert.deepEqual(
    await (await handler(request('/api/codebase/auth/status'))).json(),
    { connected: false },
  );
});

test('upstream failures remain failures and never reflect PATs or become empty lists', async () => {
  const handler = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => 'https://code.byted.org/group/repo.git',
    basePath: '/api/codebase',
    fetch: async () => upstreamError('code_pat_secret'),
  });
  const connect = await handler(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_secret' }),
  }));
  assert.equal(connect.status, 400);
  assert.doesNotMatch(await connect.text(), /code_pat_/);

  const httpFailure = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => null,
    basePath: '/api/codebase',
    fetch: async () => new Response('nope', { status: 503 }),
  });
  const failed = await httpFailure(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_secret' }),
  }));
  assert.equal(failed.status, 400);

  const throwing = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => null,
    basePath: '/api/codebase',
    fetch: async () => {
      throw new Error('network failed');
    },
  });
  assert.equal((await throwing(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_secret' }),
  }))).status, 400);
});

test('failed PAT validation leaves the previous credential connected', async () => {
  let rejectValidation = false;
  const handler = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => null,
    basePath: '/api/codebase',
    fetch: async () => {
      if (rejectValidation) return upstreamError('code_pat_rejected');
      return upstreamResponse({
        User: { Id: user.id, Username: user.username, AvatarURL: user.avatarUrl },
      });
    },
  });
  await handler(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_old' }),
  }));
  rejectValidation = true;
  const rejected = await handler(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_rejected' }),
  }));
  assert.equal(rejected.status, 400);
  assert.doesNotMatch(await rejected.text(), /code_pat_/);
  assert.deepEqual(
    await (await handler(request('/api/codebase/auth/status'))).json(),
    { connected: true, user },
  );
});

test('maps target, fork, missing, and malformed optional source repositories', async () => {
  const calls = [];
  const handler = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => 'https://code.byted.org/group/repo.git',
    basePath: '/api/codebase',
    fetch: createUpstream(calls, [
      {
        Id: 'target', Number: 1, Title: 'Target', URL: 'https://code.byted.org/mr/1',
        SourceRepoId: 'repo-1', TargetBranchName: 'main', Draft: false,
        UpdatedAt: '2026-01-01T00:00:00Z', Description: '', SourceBranchName: '',
      },
      {
        Id: 'fork', Number: 2, Title: 'Fork', URL: 'https://code.byted.org/mr/2',
        SourceRepoId: 'repo-2', TargetBranchName: 'main', Draft: false,
        UpdatedAt: '2026-01-01T00:00:00Z', SourceRepository: {
          Id: 'repo-2', Path: 'fork/repo', URL: 'https://code.byted.org/fork/repo',
          CloneURL: 'https://code.byted.org/fork/repo.git',
          SSHURL: 'git@code.byted.org:fork/repo.git',
        },
      },
      {
        Id: 'missing', Number: 3, Title: 'Missing', URL: 'https://code.byted.org/mr/3',
        SourceRepoId: 'repo-3', TargetBranchName: 'main', Draft: false,
        UpdatedAt: '2026-01-01T00:00:00Z',
      },
      {
        Id: 'malformed', Number: 4, Title: 'Malformed', URL: 'https://code.byted.org/mr/4',
        SourceRepoId: 'repo-4', TargetBranchName: 'main', Draft: false,
        UpdatedAt: '2026-01-01T00:00:00Z', SourceRepository: { Id: 4 },
      },
    ]),
  });
  await handler(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_secret' }),
  }));
  const result = await (await handler(request('/api/codebase/merge-requests?directory=/workspace'))).json();
  assert.equal(result.mergeRequests[0].sourceRepo.id, 'repo-1');
  assert.equal(result.mergeRequests[0].sourceBranch, '');
  assert.equal('description' in result.mergeRequests[0], false);
  assert.equal(result.mergeRequests[1].sourceRepo.id, 'repo-2');
  assert.equal(result.mergeRequests[2].sourceRepo, null);
  assert.equal(result.mergeRequests[3].sourceRepo, null);
});

test('rejects missing metadata and malformed complete list responses', async () => {
  let action = '';
  const handler = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => 'https://code.byted.org/group/repo.git',
    basePath: '/api/codebase',
    fetch: async (url) => {
      action = new URL(url).searchParams.get('Action');
      if (action === 'GetUser') {
        return upstreamResponse({ User: { Id: user.id, Username: user.username } });
      }
      if (action === 'GetRepository') {
        return upstreamResponse({
          Repository: {
            Id: repository.id,
            Path: repository.path,
            URL: repository.url,
            CloneURL: repository.cloneUrl,
            SSHURL: repository.sshUrl,
          },
        });
      }
      return new Response(JSON.stringify({
        ResponseMetadata: {},
        Result: { MergeRequests: [] },
      }), { status: 200 });
    },
  });
  await handler(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_secret' }),
  }));
  assert.equal((await handler(request('/api/codebase/merge-requests?directory=/workspace'))).status, 502);

  const missingMetadata = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => null,
    basePath: '/api/codebase',
    fetch: async () => new Response(JSON.stringify({ Result: {} }), { status: 200 }),
  });
  const status = await missingMetadata(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: 'code_pat_secret' }),
  }));
  assert.equal(status.status, 400);
});

test('rejects malformed requests and actual oversized bodies', async () => {
  const handler = createCodebaseHandler({
    dataDirectory: temporaryDirectory(),
    resolveRemoteUrl: async () => null,
    basePath: '/api/codebase',
    fetch: createUpstream([]),
  });
  assert.equal((await handler(request('/api/codebase/auth', {
    method: 'POST',
    body: '{bad',
  }))).status, 400);
  assert.equal((await handler(request('/api/codebase/auth', {
    method: 'POST',
    body: JSON.stringify({ pat: `code_pat_${'x'.repeat(16 * 1024)}` }),
  }))).status, 413);
  assert.equal((await handler(request('/api/codebase/merge-requests?directory=/x&page=0'))).status, 400);
});

test('parses canonical remotes and source extraction rejects unsafe URLs', () => {
  assert.equal(parseCodebaseRemoteUrl('git@code.byted.org:group/repo.git'), 'group/repo');
  assert.equal(parseCodebaseRemoteUrl('ssh://git@code.byted.org/group/repo.git'), 'group/repo');
  assert.equal(parseCodebaseRemoteUrl('ssh://git@code.byted.org:2222/group/repo.git'), null);
  assert.equal(parseCodebaseRemoteUrl('https://token@code.byted.org/group/repo.git'), null);
  assert.equal(parseCodebaseRemoteUrl('https://code.byted.org/group/repo.git?x=1'), null);
  assert.equal(parseCodebaseRemoteUrl('https://code.byted.org/group/%2e%2e/repo.git'), null);
  assert.equal(parseCodebaseRemoteUrl('https://code.byted.org.evil.test/group/repo.git'), null);

  const sshRepository = {
    ...repository,
    cloneUrl: 'https://wrong.example/group/repo.git',
    sshUrl: 'ssh://git@code.byted.org/group/repo.git',
  };
  assert.deepEqual(getCodebaseMergeRequestSource({
    id: 'mr', number: 1, title: 'Fix', url: 'https://code.byted.org/mr',
    sourceBranch: 'feature', targetBranch: 'main', sourceRepo: sshRepository,
    draft: false, updatedAt: 'now',
  }), {
    repositoryPath: 'group/repo',
    branch: 'feature',
    cloneUrl: 'ssh://git@code.byted.org/group/repo.git',
    repositoryId: 'repo-1',
  });
});
