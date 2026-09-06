import type { CodebaseMergeRequest } from './contract.js';
import { createCodebaseClient } from './web.js';
import { codebaseMessages } from './i18n.js';

export type {
  CodebaseAPI,
  CodebaseAuthStatus,
  CodebaseIssue,
  CodebaseIssueGetResult,
  CodebaseIssuesListResult,
  CodebaseIssueStatus,
  CodebaseMergeRequest,
  CodebaseMergeRequestsListResult,
  CodebaseRepository,
  CodebaseUser,
} from './contract.js';

function normalizeRepositoryPath(value: string): string | null {
  if (!value || value.includes('?') || value.includes('#') || /%2f|%5c|%2e/i.test(value)) return null;
  const path = value.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  const parts = path.split('/');
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..' || part.includes('\\'))) return null;
  return parts.join('/');
}

export function parseCodebaseRemoteUrl(value: string): string | null {
  if (!value.trim()) return null;
  const remote = value.trim();
  const scp = /^git@code\.byted\.org:(.+)$/.exec(remote);
  if (scp) return normalizeRepositoryPath(scp[1]);
  try {
    const url = new URL(remote);
    if ((url.protocol !== 'https:' && url.protocol !== 'ssh:') || url.hostname !== 'code.byted.org' || url.port || url.search || url.hash) return null;
    if (url.protocol === 'ssh:' && url.username !== 'git') return null;
    if (url.protocol === 'https:' && (url.username || url.password)) return null;
    if (/\/(?:\.|\.\.)(?:\/|$)|%2e/i.test(remote)) return null;
    return normalizeRepositoryPath(url.pathname);
  } catch {
    return null;
  }
}

export function getCodebaseMergeRequestSource(mr: CodebaseMergeRequest): { repositoryPath: string; branch: string; cloneUrl: string; repositoryId: string } | null {
  if (!mr.sourceRepo || !mr.sourceBranch.trim()) return null;
  const cloneUrl = parseCodebaseRemoteUrl(mr.sourceRepo.cloneUrl) ? mr.sourceRepo.cloneUrl : (parseCodebaseRemoteUrl(mr.sourceRepo.sshUrl) ? mr.sourceRepo.sshUrl : null);
  if (!cloneUrl) return null;
  const repositoryPath = parseCodebaseRemoteUrl(cloneUrl);
  if (!repositoryPath) return null;
  return { repositoryPath, branch: mr.sourceBranch, cloneUrl, repositoryId: mr.sourceRepo.id };
}

/** Browser-safe provider entry point. Credential storage stays in the server entry. */
export const codebaseIntegration = {
  id: 'codebase',
  createClient: createCodebaseClient,
  i18n: codebaseMessages,
  parseRemoteUrl: parseCodebaseRemoteUrl,
  getMergeRequestSource: getCodebaseMergeRequestSource,
} as const;
