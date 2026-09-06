import { describe, expect, test } from 'bun:test';
import type { GitHubPullRequestSummary, GitWorktreeInfo } from '@/lib/api/types';
import type { CodebaseMergeRequest } from '@openchamber-plugin/codebase';
import { codebaseWorktreeAdapter } from '@/lib/integrations/codebase';
import { githubWorktreeAdapter } from '@/lib/integrations/github';
import { createWorktreeAvailabilityStore, getWorktreeAvailability, type WorktreeProviderAdapter } from './worktreeAvailability';

const worktree: GitWorktreeInfo = { head: 'abc', name: 'existing', branch: 'refs/heads/feature', path: '/repo/existing' };
const mr: CodebaseMergeRequest = {
  id: 'mr-1', number: 1, title: 'Feature', url: 'https://code.byted.org/team/repo/merge_requests/1',
  sourceBranch: 'feature', targetBranch: 'main', draft: false, updatedAt: '2026-09-06',
  sourceRepo: { id: 'repo-1', path: 'team/repo', url: 'https://code.byted.org/team/repo', cloneUrl: 'https://code.byted.org/team/repo.git', sshUrl: 'git@code.byted.org:team/repo.git' },
};

describe('provider-neutral worktree availability', () => {
  test('checks 200 candidates from one authoritative list and returns the existing path', async () => {
    let reads = 0;
    const store = createWorktreeAvailabilityStore(async () => { reads += 1; return [worktree]; });
    expect(getWorktreeAvailability(store.getSnapshot(), '/repo', 'feature')).toEqual({ status: 'checking' });
    await store.refresh('/repo');
    for (let index = 0; index < 200; index += 1) {
      expect(getWorktreeAvailability(store.getSnapshot(), '/repo', 'feature')).toEqual({ status: 'exists', path: '/repo/existing' });
    }
    expect(reads).toBe(1);
    expect(getWorktreeAvailability(store.getSnapshot(), '/repo', 'Feature')).toEqual({ status: 'available' });
    expect(getWorktreeAvailability(store.getSnapshot(), '/other', 'feature')).toEqual({ status: 'checking' });
    expect(getWorktreeAvailability(store.getSnapshot(), '/repo', null)).toEqual({ status: 'unavailable' });
  });

  test('a branch or directory alone is not an occupied worktree', async () => {
    const store = createWorktreeAvailabilityStore(async () => [{ ...worktree, branch: '' }]);
    await store.refresh('/repo');
    expect(getWorktreeAvailability(store.getSnapshot(), '/repo', 'feature')).toEqual({ status: 'available' });
  });

  test('failure stays blocked and an explicit retry can recover to empty success', async () => {
    let fail = true;
    const store = createWorktreeAvailabilityStore(async () => {
      if (fail) throw new Error('Offline');
      return [];
    });
    await store.refresh('/repo');
    expect(getWorktreeAvailability(store.getSnapshot(), '/repo', 'feature')).toEqual({ status: 'error' });
    fail = false;
    await store.refresh('/repo');
    expect(getWorktreeAvailability(store.getSnapshot(), '/repo', 'feature')).toEqual({ status: 'available' });
  });

  test('reset and a new project reject late completions from the old request', async () => {
    const resolvers: Array<(value: GitWorktreeInfo[]) => void> = [];
    const store = createWorktreeAvailabilityStore(() => new Promise<GitWorktreeInfo[]>((resolve) => { resolvers.push(resolve); }));
    const old = store.refresh('/old');
    store.reset();
    const current = store.refresh('/new');
    resolvers[1]([]);
    await current;
    resolvers[0]([worktree]);
    await old;
    expect(getWorktreeAvailability(store.getSnapshot(), '/new', 'feature')).toEqual({ status: 'available' });
    expect(getWorktreeAvailability(store.getSnapshot(), '/old', 'feature')).toEqual({ status: 'checking' });
  });

  test('refreshes in the same directory cannot overwrite newer results', async () => {
    const resolvers: Array<(value: GitWorktreeInfo[]) => void> = [];
    const store = createWorktreeAvailabilityStore(() => new Promise<GitWorktreeInfo[]>((resolve) => { resolvers.push(resolve); }));
    const old = store.refresh('/repo');
    const current = store.refresh('/repo');
    resolvers[1]([worktree]);
    await current;
    resolvers[0]([]);
    await old;
    expect(getWorktreeAvailability(store.getSnapshot(), '/repo', 'feature')).toEqual({ status: 'exists', path: worktree.path });
  });

  test('Codebase and GitHub adapt their own data into the same host contract', async () => {
    const github: GitHubPullRequestSummary = { number: 1, title: 'Feature', url: 'https://github.com/team/repo/pull/1', head: 'feature', base: 'main', state: 'open', draft: false };
    const store = createWorktreeAvailabilityStore(async () => [worktree]);
    await store.refresh('/repo');
    for (const branch of [githubWorktreeAdapter.getLocalBranch(github), codebaseWorktreeAdapter.getLocalBranch(mr)]) {
      expect(getWorktreeAvailability(store.getSnapshot(), '/repo', branch)).toEqual({ status: 'exists', path: worktree.path });
    }
    expect(codebaseWorktreeAdapter.getLocalBranch({ ...mr, sourceRepo: null })).toBeNull();
    expect(githubWorktreeAdapter.getLocalBranch({ ...github, head: '' })).toBeNull();
    // A new provider only needs to adapt its data; this is not a GitLab API implementation.
    const adapter: WorktreeProviderAdapter<{ source_branch: string }> = { getLocalBranch: (item) => item.source_branch };
    expect(getWorktreeAvailability(store.getSnapshot(), '/repo', adapter.getLocalBranch({ source_branch: 'feature' }))).toEqual({ status: 'exists', path: worktree.path });
  });
});
