import { z } from 'zod';
import {
  codebaseIssueStatusSchema,
  type CodebaseAuthStatus,
  type CodebaseIssue,
  type CodebaseIssueGetResult,
  type CodebaseIssuesListResult,
  type CodebaseIssueStatus,
  type CodebaseMergeRequestsListResult,
  type CodebaseRepository,
  type CodebaseUser,
} from './contract.js';
import { parseCodebaseRemoteUrl } from './index.js';
import { createCodebaseUpstream } from './server/openapi.js';
import { createCodebaseAuthStore } from './server/storage.js';

export interface CreateCodebaseHandlerOptions {
  dataDirectory: string;
  resolveRemoteUrl: (directory: string) => Promise<string | null>;
  basePath: string;
  fetch?: typeof globalThis.fetch;
}

export interface CodebaseUpstream {
  getUser(pat: string): Promise<CodebaseUser>;
  getRepository(pat: string, repositoryPath: string): Promise<CodebaseRepository>;
  listMergeRequests(
    pat: string,
    repo: CodebaseRepository,
    page: number,
    query: string,
  ): Promise<Omit<CodebaseMergeRequestsListResult, 'repo'>>;
  listIssues(
    pat: string,
    repo: CodebaseRepository,
    page: number,
    query: string,
    status?: CodebaseIssueStatus,
  ): Promise<Omit<CodebaseIssuesListResult, 'repo'>>;
  getIssue(pat: string, repo: CodebaseRepository, number: number): Promise<CodebaseIssue>;
}

const authRequestSchema = z.object({
  pat: z.string().trim().min(1).startsWith('code_pat_'),
});
const listRequestSchema = z.object({
  directory: z.string().trim().min(1),
  page: z.coerce.number().int().positive().optional(),
  query: z.string().optional(),
});
const issueListRequestSchema = listRequestSchema.extend({ status: codebaseIssueStatusSchema.optional() });
const issueGetRequestSchema = listRequestSchema.pick({ directory: true }).extend({
  number: z.coerce.number().int().positive(),
});

type ResponseBody = { error: string } | CodebaseAuthStatus | CodebaseMergeRequestsListResult | CodebaseIssuesListResult | CodebaseIssueGetResult;

function json(status: number, body: ResponseBody): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

type ParsedAuthBody = z.infer<typeof authRequestSchema> | null | 'too-large';

async function parseAuthBody(request: Request): Promise<ParsedAuthBody> {
  const body = await request.text();
  if (Buffer.byteLength(body) > 16 * 1024) return 'too-large';
  let value;
  try {
    value = JSON.parse(body);
  } catch {
    value = null;
  }
  const parsed = authRequestSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createCodebaseHandler({ dataDirectory, resolveRemoteUrl, basePath, fetch = globalThis.fetch }: CreateCodebaseHandlerOptions): (request: Request) => Promise<Response> {
  const store = createCodebaseAuthStore(dataDirectory);
  const upstream = createCodebaseUpstream(fetch);
  let writes = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = writes.then(operation, operation);
    writes = result.then(() => undefined, () => undefined);
    return result;
  };
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === `${basePath}/auth/status` && request.method === 'GET') {
      try { return json(200, store.status()); } catch { return json(500, { error: 'Failed to load Codebase status' }); }
    }
    if (url.pathname === `${basePath}/auth` && request.method === 'POST') {
      const input = await parseAuthBody(request);
      if (input === 'too-large') return json(413, { error: 'Request body too large' });
      if (!input) return json(400, { error: 'Invalid Codebase PAT' });
      try {
        return json(200, await serialize(async () => {
          const user = await upstream.getUser(input.pat);
          store.write({ pat: input.pat, user });
          return { connected: true, user };
        }));
      } catch { return json(400, { error: 'Failed to connect Codebase' }); }
    }
    if (url.pathname === `${basePath}/auth` && request.method === 'DELETE') {
      try { return json(200, await serialize(async () => { store.clear(); return { connected: false }; })); } catch { return json(500, { error: 'Failed to disconnect Codebase' }); }
    }
    if (url.pathname === `${basePath}/merge-requests` && request.method === 'GET') {
      const input = listRequestSchema.safeParse({ directory: url.searchParams.get('directory'), page: url.searchParams.get('page') ?? undefined, query: url.searchParams.get('query') ?? undefined });
      if (!input.success) return json(400, { error: 'Invalid merge request query' });
      try {
        const credentials = store.read();
        if (!credentials) return json(401, { error: 'Codebase is not connected' });
        const remoteUrl = await resolveRemoteUrl(input.data.directory);
        const repositoryPath = remoteUrl ? parseCodebaseRemoteUrl(remoteUrl) : null;
        if (!repositoryPath) return json(400, { error: 'Directory remote is not hosted on code.byted.org' });
        const repo = await upstream.getRepository(credentials.pat, repositoryPath);
        const result = await upstream.listMergeRequests(credentials.pat, repo, input.data.page ?? 1, input.data.query?.trim() ?? '');
        return json(200, { repo, ...result });
      } catch { return json(502, { error: 'Failed to load Codebase merge requests' }); }
    }
    const isIssueDetail = url.pathname === `${basePath}/issue`;
    if ((isIssueDetail || url.pathname === `${basePath}/issues`) && request.method === 'GET') {
      const input = isIssueDetail
        ? issueGetRequestSchema.safeParse({ directory: url.searchParams.get('directory'), number: url.searchParams.get('number') })
        : issueListRequestSchema.safeParse({
          directory: url.searchParams.get('directory'),
          page: url.searchParams.get('page') ?? undefined,
          query: url.searchParams.get('query') ?? undefined,
          status: url.searchParams.get('status') ?? undefined,
        });
      if (!input.success) return json(400, { error: 'Invalid issue query' });
      try {
        const credentials = store.read();
        if (!credentials) return json(401, { error: 'Codebase is not connected' });
        const remoteUrl = await resolveRemoteUrl(input.data.directory);
        const repositoryPath = remoteUrl ? parseCodebaseRemoteUrl(remoteUrl) : null;
        if (!repositoryPath) return json(400, { error: 'Directory remote is not hosted on code.byted.org' });
        const repo = await upstream.getRepository(credentials.pat, repositoryPath);
        if (repo.issuesEnabled !== true) return json(409, { error: 'Issues are not enabled for this repository' });
        if ('number' in input.data) {
          const issue = await upstream.getIssue(credentials.pat, repo, input.data.number);
          return json(200, { repo, issue });
        }
        const result = await upstream.listIssues(credentials.pat, repo, input.data.page ?? 1, input.data.query?.trim() ?? '', input.data.status);
        return json(200, { repo, ...result });
      } catch {
        return json(502, { error: isIssueDetail ? 'Failed to load Codebase issue' : 'Failed to load Codebase issues' });
      }
    }
    return json(404, { error: 'Not found' });
  };
}
