# Purpose

This handoff describes the Issue/MR-to-worktree integration and sidebar branch association implemented for Codebase. It separates provider data from host operations so maintainers can extend the same flow to GitHub and GitLab without duplicating worktree logic.

# Codebase entry point

Use the browser-safe package facade:

```ts
import { codebaseIntegration } from '@openchamber-plugin/codebase';

const codebase = codebaseIntegration.createClient({
  fetch: runtimeFetch,
  basePath: '/api/codebase',
});

const registryWithCodebase = registry.registerI18nBundle(codebaseIntegration.i18n);
const repositoryPath = codebaseIntegration.parseRemoteUrl(remoteUrl);
const source = codebaseIntegration.getMergeRequestSource(mergeRequest);
```

The facade also exposes the stable provider ID `codebase`. Public domain types are exported from the same package root. Its existing `/web` and `/i18n` exports remain available.

Server registration intentionally uses a separate privileged entry:

```ts
import { createCodebaseHandler } from '@openchamber-plugin/codebase/server';

const handler = createCodebaseHandler({
  dataDirectory,
  resolveRemoteUrl,
  basePath: '/api/codebase',
});
```

The host authenticates incoming requests before calling the Fetch handler. Keeping `/server` separate prevents filesystem and credential-storage code from entering browser bundles. The package does not import OpenChamber UI modules.

# Interfaces in use

| Capability | OpenChamber interface | Codebase interface |
| --- | --- | --- |
| Connection | `RuntimeAPIs.codebase.authStatus/authConnect/authDisconnect` | PAT validation through `GetUser`; server-only credential storage |
| Repository identity | `GitAPI.getRemoteUrl(directory)` and injected `resolveRemoteUrl` | `parseRemoteUrl` followed by `GetRepository` |
| Issue list | `codebase.issuesList(directory, { page, query, status })` | `SearchRepoIssues`, with `RepoId`, `Filter`, pagination, and `Selector.CreatedBy` |
| Issue content | `codebase.issueGet(directory, number)` | `GetIssue`, with `RepoId` and repository-local `Number` |
| MR list | `codebase.mergeRequestsList(directory, { page, query })` | `ListRepoMergeRequests`, with `TargetRepoId`, open status, pagination, title filter, and source repository expansion |
| Source conversion | Host Codebase worktree adapter | `getMergeRequestSource`, returning repository identity, clone URL, and source branch |
| Existing worktree detection | `GitAPI.listGitWorktrees(directory)` via `GET /api/git/worktrees` | No provider network request; the provider adapts its item to the local branch the host will check out |
| Final validation and creation | `validateWorktreeCreate` and `createWorktree`, backed by the Git worktree runtime | Provider adapter supplies branch, source ref, remote provisioning, and upstream inputs |
| Session context | `AttachIssueRequest`, `sessionActions.createSession/setLinkedIssue`, and the session message flow | The Codebase adapter supplies captured Issue/MR JSON, title, URL, and author |
| Sidebar association | `loadCodebaseBranchLinks` and `CodebaseStatusProvider` | A complete open-MR list, matched by exact source repository ID and branch |

Issue content preserves description whitespace. Comments are not fetched separately. Sidebar discovery currently covers open MRs, independently of how the worktree was created.

# Shared worktree capability

The implemented extension point is deliberately small:

```ts
interface WorktreeProviderAdapter<T> {
  getLocalBranch(item: T): string | null;
}
```

Providers must adapt their own data into this interface. GitHub uses the PR head branch. Codebase resolves a usable source repository and branch first. A future GitLab adapter must perform the equivalent mapping; there is no GitLab API implementation in this change.

The host reads the target Git repository's worktree list once per picker scope, indexes occupied local branches, and shares the result across all listed candidates. It exposes `checking`, `available`, `exists`, `error`, and `unavailable` states. An existing worktree includes its path. Both GitHub and Codebase disable selection until the candidate is available.

This is a local Git occupancy check, not a claim that same-named branches on different hosting repositories are identical. The adapter must return the branch that the eventual creation plan will actually use. A plain local branch or an existing directory alone does not mean a worktree occupies it.

Project changes, dialog closure, runtime changes, and newer refreshes invalidate stale results. Failure remains blocked and exposes retry. This preflight does not replace final server validation: a worktree can be created after the list was read, so the server retains its `branch_in_use` guard.

Implementation pointers:

- [Host state and branch index](../../packages/ui/src/lib/worktrees/worktreeAvailability.ts)
- [React lifecycle](../../packages/ui/src/hooks/useWorktreeAvailability.ts)
- [GitHub adapter](../../packages/ui/src/lib/integrations/github.ts)
- [Codebase adapter and creation inputs](../../packages/ui/src/lib/integrations/codebase.ts)
- [Codebase public facade](../../packages/integrations/codebase/src/index.ts)

# What was extracted from GitHub

Existing-worktree detection, loading/error states, stale-result protection, retry, and the availability label are now shared host behavior. GitHub no longer launches a validation request for every PR row or owns a branch-only validation cache. GitHub and Codebase both use `useWorktreeAvailability` with their respective adapters.

# What still needs a common contract

- Provider discovery and runtime registration still need a common registry. GitHub and Codebase remain separately wired runtime capabilities.
- Issue/MR identities, list/detail results, pagination, and provider errors still have separate contracts. Normalize these before attempting one shared picker.
- GitHub's source-ref and remote-provisioning decisions remain in `NewWorktreeDialog`; Codebase has its own host adapter. They should eventually produce one typed creation plan while preserving repository identity, fork handling, existing transport, and remote-name collisions.
- Context capture still has separate GitHub and Codebase paths. A shared context result should retain provider identity, URL, content completeness, and failure behavior without requiring callers to recognize provider-specific payloads.
- Each additional provider, including GitLab, needs both a provider API implementation and a host adapter. A common host method does not remove that mapping work. Authentication and unsupported runtime behavior must stay explicit.

Use `implements` for the normalized provider and host-adapter contracts. Add a base class only after concrete implementations share orchestration worth inheriting. The current change does not introduce a speculative abstract base class.

# Verification boundary

Worktree availability and adapters are tested with local fixtures, including occupied branches, empty success, failures, retries, cross-project isolation, and out-of-order completion. This change does not use a real PAT or query private provider data during validation.
