import { expect, test } from 'bun:test';
import { createWebGitAPI } from '../api/git';
import { getRemoteUrl } from '@openchamber/ui/lib/gitApiHttp';
import { getWorktreeMergeRequestProvider } from '@openchamber/ui/lib/worktrees/worktreeMergeRequest';

test('the Web runtime exposes the real remote lookup required by Codebase entry routing', () => {
  expect(createWebGitAPI().getRemoteUrl).toBe(getRemoteUrl);
  expect(getWorktreeMergeRequestProvider('git@code.byted.org:ad/touchstone.git')).toBe('codebase');
  expect(getWorktreeMergeRequestProvider('git@github.com:openchamber/openchamber.git')).toBe('github');
});
