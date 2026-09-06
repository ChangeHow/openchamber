# Codebase plugin

`@openchamber-plugin/codebase` is a standalone Codebase package. It exports a portable contract, Fetch handler, browser client, and pure i18n data. The host authenticates requests before dispatching them and supplies its data directory, Git remote lookup, and browser transport.

```ts
import { createCodebaseHandler } from '@openchamber-plugin/codebase/server';
import { codebaseIntegration } from '@openchamber-plugin/codebase';
import { createI18nRegistry } from '@/lib/i18n/registry';

const handler = createCodebaseHandler({ dataDirectory, resolveRemoteUrl, basePath: '/api/codebase' });
const codebase = codebaseIntegration.createClient({ fetch: runtimeFetch, basePath: '/api/codebase' });
const i18n = createI18nRegistry(coreEnglish).registerI18nBundle(codebaseIntegration.i18n);
```

Use `codebaseIntegration` from the package root for browser-safe provider registration, client creation, translations, remote parsing, and source conversion. Public types come from the same root. `/server` remains separate so browser consumers never import credential storage or Node filesystem code. The existing `/web` and `/i18n` exports are still available.

The OpenChamber server adapter runs after host authentication. It parses JSON with a 16 KiB limit and returns parser errors without echoing the submitted PAT. A different host can call the Fetch handler directly.

# Install and package

From this package directory, run `npm install` and `npm run build`. Create a tarball with `npm pack`, then install that tarball in the target host with `npm install ./openchamber-plugin-codebase-0.1.0.tgz`. The published exports load compiled JavaScript and declarations, not TypeScript source.

From the OpenChamber workspace, use `bun run build:integrations` after changing plugin source. `bun install`, the root build, and the Web build also compile it before consumers run. Publish the plugin before publishing a Web package that depends on its version.

# Host adapters

Edit upstream request and response handling in this package. Edit host adapters in `packages/web/server/lib/integrations/codebase.js`, `packages/web/src/integrations/codebase.ts`, and `packages/ui/src/lib/integrations/codebase.ts`. The host i18n registry registers `codebaseIntegration.i18n`.

# Read issues

The client reads issues from the Codebase repository resolved from the supplied directory. It uses the existing PAT connection. The repository must have Issues enabled.

```ts
const page = await codebase.issuesList(directory, {
  page: 1,
  query: 'login',
  status: 'todo',
});
const { issue } = await codebase.issueGet(directory, 42);
```

List options are optional. Omitting `status` includes all statuses: `backlog`, `todo`, `in_progress`, `done`, and `canceled`. Search matches issue numbers, titles, or descriptions. Results are ordered by most recently updated, with 50 issues per page and `hasMore` indicating another page.

Both operations return repository metadata. Issues include their number, title, URL, status, author when supplied, timestamps, and full `description`. Description whitespace and empty bodies are preserved. Comments and attachments are not fetched separately.

The Fetch handler exposes `GET <basePath>/issues?directory=...&page=...&query=...&status=...` and `GET <basePath>/issue?directory=...&number=...`. Missing credentials, disabled Issues, invalid queries, and upstream failures reject the client call; they do not become successful empty results. These methods do not create or edit issues, or automatically associate branches with issues or merge requests.
