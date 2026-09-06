import type { CodebaseAPI, CodebaseMergeRequest } from '@openchamber-plugin/codebase';

// One complete repository read serves every visible worktree in that project.
export async function loadCodebaseBranchLinks(api: Pick<CodebaseAPI, 'mergeRequestsList'>, directory: string, signal?: AbortSignal): Promise<Map<string, CodebaseMergeRequest>> {
  const links = new Map<string, CodebaseMergeRequest>();
  for (let page = 1; ; page += 1) {
    signal?.throwIfAborted();
    const result = await api.mergeRequestsList(directory, { page });
    signal?.throwIfAborted();
    if (result.page !== page) throw new Error('Invalid Codebase pagination');
    for (const mr of result.mergeRequests) {
      if (mr.sourceRepo?.id !== result.repo.id || !mr.sourceBranch || links.has(mr.sourceBranch)) continue;
      links.set(mr.sourceBranch, mr);
    }
    if (!result.hasMore) return links;
  }
}
