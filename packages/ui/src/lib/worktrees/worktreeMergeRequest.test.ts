import { describe, expect, test } from 'bun:test';

import {
  getWorktreeMergeRequestProvider,
} from './worktreeMergeRequest';
import { resolveCodebaseMergeRequestWorktreeConfig } from '../integrations/codebase';
import { getCodebaseMergeRequestSource } from '@openchamber-plugin/codebase';

const mergeRequest = {
  id: 'repo-42',
  number: 12,
  title: 'Fix the picker',
  url: 'https://code.byted.org/team/repo/merge_requests/12',
  sourceBranch: 'fix/picker',
  targetBranch: 'main',
  sourceRepo: {
    id: 'repo-42',
    path: 'team/repo',
    url: 'https://code.byted.org/team/repo',
    cloneUrl: 'https://code.byted.org/team/repo.git',
    sshUrl: 'git@code.byted.org:team/repo.git',
  },
  draft: false,
  updatedAt: '2026-09-06T00:00:00Z',
} as const;

describe('worktree merge request routing', () => {
  test('routes only exact GitHub and Codebase remote hosts', () => {
    expect(getWorktreeMergeRequestProvider('git@github.com:openchamber/openchamber.git')).toBe('github');
    expect(getWorktreeMergeRequestProvider('https://code.byted.org/team/repo.git')).toBe('codebase');
    expect(getWorktreeMergeRequestProvider('https://code.byted.org.evil.example/team/repo.git')).toBeNull();
    expect(getWorktreeMergeRequestProvider('https://notgithub.com/openchamber/openchamber.git')).toBeNull();
    expect(getWorktreeMergeRequestProvider('ftp://code.byted.org/team/repo.git')).toBeNull();
    expect(getWorktreeMergeRequestProvider('https://code.byted.org/team/repo.git?token=nope')).toBeNull();
  });

  test('uses only a source repository remote with the merge request branch', () => {
    const config = resolveCodebaseMergeRequestWorktreeConfig(mergeRequest, [
      { name: 'origin', fetchUrl: 'https://code.byted.org/other/repo.git', pushUrl: 'https://code.byted.org/other/repo.git' },
      { name: 'source', fetchUrl: 'git@code.byted.org:team/repo.git', pushUrl: 'git@code.byted.org:team/repo.git' },
    ], ['origin/fix/picker', 'source/fix/picker']);

    expect(config.existingBranch).toBe('remotes/source/fix/picker');
    expect(config.upstreamRemote).toBe('source');
    expect(config.upstreamBranch).toBe('fix/picker');
    expect(config.ensureRemoteUrl).toBe(undefined);
  });

  test('adds a dedicated remote rather than using a same-named branch from another repository', () => {
    const config = resolveCodebaseMergeRequestWorktreeConfig(mergeRequest, [
      { name: 'origin', fetchUrl: 'https://code.byted.org/other/repo.git', pushUrl: 'https://code.byted.org/other/repo.git' },
    ], ['origin/fix/picker']);

    expect(config.existingBranch).toBe('remotes/mr-repo-42/fix/picker');
    expect(config.ensureRemoteName).toBe('mr-repo-42');
    expect(config.ensureRemoteUrl).toBe('https://code.byted.org/team/repo.git');
  });

  test('refreshes a matching source remote when its branch has not been fetched', () => {
    const config = resolveCodebaseMergeRequestWorktreeConfig(mergeRequest, [{
      name: 'source',
      fetchUrl: 'https://code.byted.org/team/repo.git',
      pushUrl: 'https://code.byted.org/team/repo.git',
    }], []);

    expect(config.existingBranch).toBe('remotes/source/fix/picker');
    expect(config.ensureRemoteName).toBe('source');
    expect(config.ensureRemoteUrl).toBe('https://code.byted.org/team/repo.git');
  });

  test('does not overwrite a different repository using the generated remote name', () => {
    const config = resolveCodebaseMergeRequestWorktreeConfig(mergeRequest, [{
      name: 'mr-repo-42',
      fetchUrl: 'https://code.byted.org/other/repo.git',
      pushUrl: 'https://code.byted.org/other/repo.git',
    }], []);
    expect(config.ensureRemoteName).toBe('mr-repo-42-2');
    expect(config.existingBranch).toBe('remotes/mr-repo-42-2/fix/picker');
  });

  test('preserves an existing SSH transport when fetching the source branch', () => {
    const config = resolveCodebaseMergeRequestWorktreeConfig(mergeRequest, [{
      name: 'source',
      fetchUrl: 'git@code.byted.org:team/repo.git',
      pushUrl: 'git@code.byted.org:team/repo.git',
    }], []);
    expect(config.ensureRemoteName).toBe('source');
    expect(config.ensureRemoteUrl).toBe('git@code.byted.org:team/repo.git');
  });

  test('uses only the fetch identity and preserves an SSH clone username', () => {
    const config = resolveCodebaseMergeRequestWorktreeConfig({
      ...mergeRequest,
      sourceRepo: { ...mergeRequest.sourceRepo, cloneUrl: '', sshUrl: 'git@code.byted.org:Team/Repo.git' },
    }, [{
      name: 'origin',
      fetchUrl: 'git@code.byted.org:other/repo.git',
      pushUrl: 'git@code.byted.org:Team/Repo.git',
    }], ['origin/fix/picker']);

    expect(config.ensureRemoteUrl).toBe('git@code.byted.org:Team/Repo.git');
    expect(config.existingBranch).toBe('remotes/mr-repo-42/fix/picker');
  });

  test('keeps Codebase repository path casing when matching a fetch remote', () => {
    const config = resolveCodebaseMergeRequestWorktreeConfig({
      ...mergeRequest,
      sourceRepo: { ...mergeRequest.sourceRepo, cloneUrl: 'https://code.byted.org/Team/Repo.git' },
    }, [{
      name: 'source',
      fetchUrl: 'https://code.byted.org/Team/Repo.git',
      pushUrl: 'https://code.byted.org/Team/Repo.git',
    }], ['source/fix/picker']);

    expect(config.existingBranch).toBe('remotes/source/fix/picker');
  });

  test('rejects merge requests without a usable Codebase source branch and repository', () => {
    expect(getCodebaseMergeRequestSource({ ...mergeRequest, sourceBranch: '' })).toBeNull();
    expect(getCodebaseMergeRequestSource({ ...mergeRequest, sourceRepo: null })).toBeNull();
    expect(getCodebaseMergeRequestSource({
      ...mergeRequest,
      sourceRepo: { ...mergeRequest.sourceRepo, cloneUrl: 'https://code.byted.org.evil.example/team/repo.git', sshUrl: '' },
    })).toBeNull();
    expect(getCodebaseMergeRequestSource({
      ...mergeRequest,
      sourceRepo: { ...mergeRequest.sourceRepo, cloneUrl: 'https://code.byted.org/team/repo.git#token', sshUrl: '' },
    })).toBeNull();
    expect(getCodebaseMergeRequestSource({
      ...mergeRequest,
      sourceRepo: { ...mergeRequest.sourceRepo, cloneUrl: 'https://token@code.byted.org/team/repo.git', sshUrl: '' },
    })).toBeNull();
  });
});
