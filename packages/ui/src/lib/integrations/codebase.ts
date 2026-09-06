import { codebaseIntegration, type CodebaseIssue, type CodebaseMergeRequest } from '@openchamber-plugin/codebase';
import type { AttachIssueRequest } from '@openchamber/sdk';
import type { GitRemote } from '@/lib/api/types';
import type { WorktreeProviderAdapter } from '@/lib/worktrees/worktreeAvailability';

export const codebaseWorktreeAdapter: WorktreeProviderAdapter<CodebaseMergeRequest> = {
  getLocalBranch: (mr) => codebaseIntegration.getMergeRequestSource(mr)?.branch.trim() || null,
};

export function codebaseWorktreeAttachment(item: CodebaseIssue | CodebaseMergeRequest): AttachIssueRequest {
  const kind = 'sourceBranch' in item ? 'pull' : 'issue';
  const attachment: AttachIssueRequest = {
    providerId: 'codebase',
    id: `${kind === 'pull' ? '!' : '#'}${item.number}`,
    title: item.title,
    url: item.url,
    kind,
    text: `Codebase ${kind === 'pull' ? 'merge request' : 'issue'} context (JSON)\n${JSON.stringify(item, null, 2)}`,
  };
  if (item.author) attachment.author = item.author.username;
  if ('sourceBranch' in item) attachment.branches = { head: item.sourceBranch, base: item.targetBranch };
  return attachment;
}

// Only this adapter knows OpenChamber's remote-ref and worktree creation fields.
export function resolveCodebaseMergeRequestWorktreeConfig(
  mergeRequest: CodebaseMergeRequest,
  remotes: GitRemote[],
  remoteBranches: string[],
) {
  const source = codebaseIntegration.getMergeRequestSource(mergeRequest);
  if (!source) throw new Error('Merge request source branch or repository is unavailable.');

  const matchingRemote = remotes.find((remote) => codebaseIntegration.parseRemoteUrl(remote.fetchUrl) === source.repositoryPath);
  const remoteSeed = source.repositoryId.toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const remoteBase = `mr-${remoteSeed}`;
  let remoteName = matchingRemote?.name ?? remoteBase;
  for (let suffix = 2; !matchingRemote && remotes.some((remote) => remote.name === remoteName); suffix += 1) {
    remoteName = `${remoteBase}-${suffix}`;
  }
  const hasBranch = remoteBranches.includes(`${remoteName}/${source.branch}`) && Boolean(matchingRemote);

  return {
    existingBranch: `remotes/${remoteName}/${source.branch}`,
    setUpstream: true,
    upstreamRemote: remoteName,
    upstreamBranch: source.branch,
    ensureRemoteName: hasBranch ? undefined : remoteName,
    ensureRemoteUrl: hasBranch ? undefined : matchingRemote?.fetchUrl ?? source.cloneUrl,
    sourceLabel: `${remoteName}/${source.branch}`,
  };
}
