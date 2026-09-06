# Codebase plugin

## Ownership

`src/contract.ts` owns shared schemas and domain types. `src/index.ts` exports public types plus Codebase remote parsing and merge request source conversion. `src/web.ts` owns browser request serialization and response parsing. `src/server.ts` owns Fetch routes, the stable upstream interface, request body limits, and credential mutation ordering. `src/server/openapi.ts` is the only Codebase Action adapter. `src/server/storage.ts` owns `codebase-auth.json`. `src/i18n.ts` owns the pure `codebaseMessages` data bundle exported as `@openchamber-plugin/codebase/i18n`.

## Invariants

`codebaseIntegration` in `src/index.ts` is the browser-safe public facade for client creation, translations, remote parsing, and MR source conversion. Host browser consumers register through this object. The privileged Fetch handler remains a separate `/server` import.

The root entry has no Node imports or credential storage. The server receives its data directory and remote resolver from the host. Hosts authenticate before dispatching to the handler. The package does not read host environment variables or choose a host path.

The i18n export has no host, React, Zustand, Node, or server imports. It exports `{ id: 'codebase', messages }`; host `composition.ts` registers the same bundle through `codebaseIntegration.i18n`.

Credential reads return disconnected only when `codebase-auth.json` is absent. Malformed or unreadable files fail safely. Writes use a unique `0600` temporary file and atomic rename, preserving the old credential on failure. Connect and disconnect share one handler-local queue.

The upstream adapter uses the fixed Codebase Action URL, a bearer PAT, `redirect: 'error'`, and a ten-second timeout. It parses each envelope and fails malformed complete responses instead of returning an empty list.

Issue reads use `SearchRepoIssues` with `RepoId`, `Filter.Query`/`Filter.Status`, numbered pagination, and `Selector.CreatedBy`. Details use `GetIssue` with `RepoId` and the repository-local `Number`. The protocol follows the official `@vecode-fe/codebase-api` `SearchRepoIssuesRequest`, `GetIssueRequest`, and `Issue` types. `Issue.Description` is required but may be empty; its whitespace is preserved. Returned repository IDs and detail numbers must match the requested identity.

The repository's optional `IssueEnabled` field is exposed as `issuesEnabled`. As in the Codebase CLI, issue reads require it to be explicitly true. The handler returns 409 otherwise and never enables the feature itself. The browser client and existing host adapter expose `issuesList` and `issueGet` without adding upstream protocol logic to the host. Web, Electron, hosted mobile, and Capacitor share this transport; VS Code still has no Codebase runtime capability.

## Adapters to edit

Change host SDK or filesystem behavior in `packages/web/server/lib/integrations/codebase.js`, `packages/web/src/integrations/codebase.ts`, or `packages/ui/src/lib/integrations/codebase.ts`. Change the Codebase Action protocol only in `src/server/openapi.ts`. Do not move either concern into contracts, web code, storage, or i18n.

The host's New Worktree picker displays Issues and MRs. Issue selection fetches full content before confirmation; MR selection resolves the source remote and branch. `codebaseWorktreeAttachment` adapts either result to the existing host `AttachIssueRequest` flow with provider ID `codebase`. The host creates a session, persists a guest-thread snapshot, and sends the captured JSON context. This does not install a model provider or grant an iframe privileges. Context-send failure keeps the created worktree/session and reports an error. The work-status panel opens the stored URL and uses the GitLab icon for Codebase snapshots.

Sidebar association is read-only and independent of whether a worktree was created through the picker. The host's `loadCodebaseBranchLinks` consumes a complete paginated open-MR list and indexes exact source branches from that repository. Closed/merged historical MRs are not shown by this open-MR discovery path.

The Codebase and GitHub pickers share the host's `WorktreeProviderAdapter` contract and `useWorktreeAvailability` lifecycle. Providers supply the intended local checkout branch; the host reads local worktrees once, blocks occupied/unknown/failed candidates, and displays existing paths. This does not replace final Git runtime validation. See the repository's `docs/references/scm-integration-contract.md` for the maintainer handoff and remaining adapter work.
