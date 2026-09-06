import { describe, expect, test } from 'bun:test';
import type { CodebaseIssue, CodebaseMergeRequest } from '@openchamber-plugin/codebase';
import { loadCodebaseBranchLinks } from './codebase-status';
import { codebaseWorktreeAttachment } from './codebase';
import { buildLinkedGuestIssue, getLinkedIssues, withLinkedIssue } from '../linkedIssues';

const repo = { id: 'r1', path: 'team/repo', url: 'https://code.byted.org/team/repo', cloneUrl: 'https://code.byted.org/team/repo.git', sshUrl: 'git@code.byted.org:team/repo.git' };
const mr: CodebaseMergeRequest = {
  id: 'mr1', number: 545, title: 'Rename extension', url: `${repo.url}/merge_requests/545`,
  description: 'MR body', sourceBranch: 'chore/update-chrome-ext-name', targetBranch: 'main',
  sourceRepo: repo, draft: false, updatedAt: '2026-09-06T00:00:00Z',
};

describe('Codebase worktree integration', () => {
  test('issue and MR attachments preserve content, identity, and branches for the session flow', () => {
    const issue: CodebaseIssue = {
      id: 'i1', number: 42, title: 'Fix login', url: `${repo.url}/issues/42`,
      description: '## Details\n\n  Preserve this.\n', status: 'todo',
      createdAt: '2026-09-01', updatedAt: '2026-09-06', author: { username: 'ada' },
    };
    const attachment = codebaseWorktreeAttachment(issue);
    expect([attachment.providerId, attachment.id, attachment.kind, attachment.author]).toEqual(['codebase', '#42', 'issue', 'ada']);
    expect(attachment.branches).toBe(undefined);
    expect(attachment.text).toContain(JSON.stringify(issue, null, 2));
    const pull = codebaseWorktreeAttachment(mr);
    expect([pull.providerId, pull.id, pull.kind]).toEqual(['codebase', '!545', 'pull']);
    expect(pull.branches).toEqual({ head: mr.sourceBranch, base: 'main' });
    expect(pull.text).toContain('MR body');
    const linked = buildLinkedGuestIssue({ providerId: pull.providerId, identifier: pull.id, title: pull.title, url: pull.url, thread: 'pull', head: pull.branches?.head, base: pull.branches?.base, linkedAt: 1 });
    expect(withLinkedIssue({}, linked, true).openchamber).toEqual({ linked_issues: [linked] });
    expect(getLinkedIssues(null)).toEqual([]);
  });

  test('one paginated repository read serves many branches and excludes a fork with the same branch', async () => {
    const calls: number[] = [];
    const links = await loadCodebaseBranchLinks({
      async mergeRequestsList(_directory, options) {
        const page = options?.page ?? 1;
        calls.push(page);
        return { repo, page, hasMore: page === 1, mergeRequests: page === 1
          ? [{ ...mr, id: 'fork', sourceRepo: { ...repo, id: 'fork' } }, mr]
          : [{ ...mr, id: 'older', number: 1 }, { ...mr, id: 'other', sourceBranch: 'other' }] };
      },
    }, '/repo');
    expect(calls).toEqual([1, 2]);
    expect(links.get(mr.sourceBranch)?.number).toBe(545);
    expect(links.size).toBe(2);
    for (let index = 0; index < 200; index += 1) expect(links.get(mr.sourceBranch)).toBe(mr);
    expect(calls.length).toBe(2);
  });

  test('a failed or invalid later page never returns an authoritative partial index', async () => {
    await expect(loadCodebaseBranchLinks({
      async mergeRequestsList(_directory, options) {
        if (options?.page === 2) throw new Error('Offline');
        return { repo, page: 1, hasMore: true, mergeRequests: [mr] };
      },
    }, '/repo')).rejects.toThrow('Offline');
    await expect(loadCodebaseBranchLinks({
      async mergeRequestsList() { return { repo, page: 1, hasMore: true, mergeRequests: [] }; },
    }, '/repo')).rejects.toThrow('Invalid Codebase pagination');
  });

  test('a runtime or scope switch stops subsequent page requests', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(loadCodebaseBranchLinks({
      async mergeRequestsList() {
        calls += 1;
        controller.abort();
        return { repo, page: 1, hasMore: true, mergeRequests: [mr] };
      },
    }, '/repo', controller.signal)).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
