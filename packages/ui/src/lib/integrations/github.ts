import type { GitHubPullRequestSummary } from '@/lib/api/types';
import type { WorktreeProviderAdapter } from '@/lib/worktrees/worktreeAvailability';

export const githubWorktreeAdapter: WorktreeProviderAdapter<GitHubPullRequestSummary> = {
  getLocalBranch: (pr) => pr.head?.trim() || null,
};
