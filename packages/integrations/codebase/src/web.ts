import {
  codebaseAuthStatusSchema,
  codebaseIssueGetResultSchema,
  codebaseIssuesListResultSchema,
  codebaseMergeRequestsListResultSchema,
  type CodebaseAPI,
} from './contract.js';
import { z } from 'zod';

const errorSchema = z.object({ error: z.string() });

export interface CreateCodebaseClientOptions {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
  basePath: string;
}

async function parseResponse<T>(response: Response, schema: z.ZodType<T>, fallback: string): Promise<T> {
  const payload: unknown = await response.json().catch(() => null);
  const result = schema.safeParse(payload);
  const error = errorSchema.safeParse(payload);
  if (!response.ok || !result.success) throw new Error(error.success ? error.data.error : fallback);
  return result.data;
}

export function createCodebaseClient({ fetch, basePath }: CreateCodebaseClientOptions): CodebaseAPI {
  return {
    async authStatus() {
      return parseResponse(await fetch(`${basePath}/auth/status`, { method: 'GET', headers: { Accept: 'application/json' } }), codebaseAuthStatusSchema, 'Failed to load Codebase status');
    },
    async authConnect(pat) {
      return parseResponse(await fetch(`${basePath}/auth`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ pat }) }), codebaseAuthStatusSchema, 'Failed to connect Codebase');
    },
    async authDisconnect() {
      return parseResponse(await fetch(`${basePath}/auth`, { method: 'DELETE', headers: { Accept: 'application/json' } }), codebaseAuthStatusSchema, 'Failed to disconnect Codebase');
    },
    async mergeRequestsList(directory, options) {
      const params = new URLSearchParams({ directory });
      if (options?.page) params.set('page', String(options.page));
      if (options?.query?.trim()) params.set('query', options.query.trim());
      return parseResponse(await fetch(`${basePath}/merge-requests?${params}`, { method: 'GET', headers: { Accept: 'application/json' } }), codebaseMergeRequestsListResultSchema, 'Failed to load Codebase merge requests');
    },
    async issuesList(directory, options) {
      const params = new URLSearchParams({ directory });
      if (options?.page !== undefined) params.set('page', String(options.page));
      if (options?.query?.trim()) params.set('query', options.query.trim());
      if (options?.status) params.set('status', options.status);
      return parseResponse(await fetch(`${basePath}/issues?${params}`, { method: 'GET', headers: { Accept: 'application/json' } }), codebaseIssuesListResultSchema, 'Failed to load Codebase issues');
    },
    async issueGet(directory, number) {
      const params = new URLSearchParams({ directory, number: String(number) });
      return parseResponse(await fetch(`${basePath}/issue?${params}`, { method: 'GET', headers: { Accept: 'application/json' } }), codebaseIssueGetResultSchema, 'Failed to load Codebase issue');
    },
  };
}
