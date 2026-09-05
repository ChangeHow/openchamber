# @openchamber/sdk — developer API reference

What third-party guest authors import and call. Source of truth: `[packages/sdk/src](https://github.com/openchamber/openchamber/tree/sdk/packages/sdk/src)`. Longer guides live in the [product docs](https://github.com/openchamber/openchamber/tree/sdk/packages/docs/content/docs) (`sdk.mdx`, `sdk/host.mdx`, `sdk/ui.mdx`) and in `[GUEST_AGENTS.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_AGENTS.md)` for local agents.

**Package:** `@openchamber/sdk`  
**API version:** manifest `apiVersion: 1`, wire envelope `v: 1`  
**Runtimes that load guests:** web and desktop. VS Code and mobile mark the catalog `unsupported`.

Two entrypoints:


| Import                | Role                                                           |
| --------------------- | -------------------------------------------------------------- |
| `@openchamber/sdk`    | Manifest parse, iframe protocol, `connectHost`                 |
| `@openchamber/sdk/ui` | Optional DOM drawing kit (issue list, card, PR window, chrome) |


---

## Ship checklist (install fails without these)

`inspectGuestPackage` (Settings → Extensions install) checks the folder or zip **on disk**. Parse alone is not enough. Packaged OpenChamber and `openchamber serve` run on Node and will **not** compile TypeScript. `oc-dev` on Bun may compile `panel/main.ts` when serving; install still wants the built `.js` files present.


| Must exist                                                                       | When                                            | Failure code       |
| -------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------ |
| Semver `version` on `package.json` (`1.0.0`)                                     | Always on install                               | `invalid-manifest` |
| `panel.entry` HTML file                                                          | Always                                          | `invalid-manifest` |
| Every relative `<script src="…">` `.js` from that HTML (usually `panel/main.js`) | Always                                          | `missing-build`    |
| File named by `panel.icon`                                                       | Only when icon ends in `.svg` (e.g. `icon.svg`) | `invalid-manifest` |
| File named by `agent.entry` (e.g. `agent/main.js`)                               | When `contributes.agent` is set                 | `missing-build`    |


**Icon.** Remixicon kebab name (`window`) needs no file. A package SVG path (`icon.svg`) must sit inside the package. URLs and absolute paths fail parse as `invalid-panel-icon`. Missing SVG on disk fails install as `invalid-manifest`.

**Panel JS.** Classic IIFE. The iframe cannot load ESM. Point `panel/index.html` at `./main.js` and ship that file.

**Agent JS.** Same rule as the panel: `agent.entry` must be compiled JS already in the package. `.ts` alone fails as `missing-build`.

Bundle with the SDK helper (repeat for the agent when you have one):

```bash
bun run --filter @openchamber/sdk bundle -- panel/main.ts panel/main.js
bun run --filter @openchamber/sdk bundle -- agent/main.ts agent/main.js
```

Zip or folder for install should include at least: `package.json`, `panel/index.html`, `panel/main.js`, and any declared `icon.svg` / `agent/main.js`. Skip `node_modules` and TypeScript sources. Zip and git installs land in `{dataDir}/extensions/{id}`. See also `[GUEST_AGENTS.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_AGENTS.md)`.

---

## 1. `connectHost` — iframe client

```ts
import { connectHost, HostRequestError } from '@openchamber/sdk';

const host = connectHost();
```

Throws `HOST_UNAVAILABLE` when there is no `window`, or when the page is not in an iframe (`parent === self`). Call `dispose()` on teardown; in-flight RPCs then reject as `HOST_UNAVAILABLE`. Silent host for 20s → `HOST_TIMEOUT`.

### 1.1 Subscriptions (host pushes)

Each returns an unsubscribe function. Late subscribers get the last known value (replay from `ready` or the last dedicated push).


| Method                         | Payload                 | Notes                                                        |
| ------------------------------ | ----------------------- | ------------------------------------------------------------ |
| `onReady(listener)`            | `HostReadyContext`      | First snapshot and later full refreshes                      |
| `onDirectory(listener)`        | `string                 | null`                                                        |
| `onSession(listener)`          | `SessionSnapshot        | null`                                                        |
| `onSessionLifecycle(listener)` | `SessionLifecycleEvent` | `{ sessionId, phase }` — `started` / `completed` / `failure` |
| `onConnection(listener)`       | `GuestConnection`       | `{ connected, account }`                                     |
| `onSettings(listener)`         | `GuestSettings`         | Declared integration fields only (`Record<string, string>`)  |


`HostReadyContext`


| Field          | Type                     | Meaning                                                                                  |
| -------------- | ------------------------ | ---------------------------------------------------------------------------------------- |
| `theme.mode`   | `'light'                 | 'dark'`                                                                                  |
| `theme.tokens` | colors, `font`, `radius` | Pass to `applyHostReady` before mounting UI                                              |
| `locale`       | `string`                 | Host language tag                                                                        |
| `directory`    | `string                  | null`                                                                                    |
| `session`      | snapshot or `null`       | Title falls back to `id`. `busy` is live status. `model` is `providerID/id` when present |
| `surface`      | `'panel'                 | 'dialog'`                                                                                |
| `connection`   | `{ connected, account }` | Integration link state                                                                   |
| `settings`     | `Record<string, string>` | Declared keys only                                                                       |


Access tokens never appear in `ready` or in request results.

**Session lifecycle phases:** live `busy` / `retry` → `started`; `idle` → `completed`; unknown status → `failure` (not abort/crash).

### 1.2 Actions (RPC)


| Method            | Arguments                         | Returns                        | Behavior                                                                              |
| ----------------- | --------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| `toast`           | `{ kind: 'info'                   | 'success'                      | 'error', message }`                                                                   |
| `openUrl`         | `url: string`                     | `Promise<void>`                | Open URL in the host                                                                  |
| `openSurface`     | `surfaceId: string`               | `Promise<void>`                | Switch host chrome to that surface                                                    |
| `writeClipboard`  | `text: string`                    | `Promise<void>`                | Copy in the host (1–32000 chars)                                                      |
| `compose`         | `{ text, mode?: 'append'          | 'replace' }`                   | `Promise<void>`                                                                       |
| `attach`          | `AttachIssueRequest`              | `Promise<void>`                | Composer chip (exclusive with GitHub/Linear)                                          |
| `startSession`    | `StartSessionRequest`             | `Promise<{ sessionId, sent }>` | Create session (+ optional worktree), write snapshot. `text` can become first message |
| `prompt`          | `{ text, send?: boolean }`        | `Promise<{ sent }>`            | Current session: omit/`false` = replace-compose; `send: true` = send                  |
| `sessionLink`     | `AttachIssueRequest`              | `Promise<void>`                | Write snapshot on **current** session. Does not create one                            |
| `close`           | —                                 | `Promise<void>`                | Dismiss attach dialog. No-op on the rail                                              |
| `oauthStart`      | —                                 | `Promise<void>`                | Open provider authorize URL (or first-party Linear)                                   |
| `oauthDisconnect` | —                                 | `Promise<void>`                | Drop guest tokens / Linear connection                                                 |
| `request`         | `{ method, path, query?, body? }` | `Promise<{ status, body }>`    | HTTPS call on declared `apiOrigin`. Host attaches auth                                |
| `agentRequest`    | same shape as `request`           | `Promise<{ status, body }>`    | Proxy to this guest's local agent on loopback                                         |
| `agentStatus`     | —                                 | `Promise<{ status }>`          | `stopped`                                                                             |
| `dispose`         | —                                 | `void`                         | Remove listener, reject pending RPCs                                                  |


`AttachIssueRequest`

```ts
{
  providerId: string;  // usually panel id
  id: string;          // guest identifier, not a GitHub number
  title: string;
  url: string;
  text?: string;       // optional model context
  kind?: 'issue' | 'pull';  // default issue
  author?: string;
  branches?: { head: string; base: string };  // for pull
}
```

`StartSessionRequest` = attach fields + optional `worktree?: boolean`.

`sent` **values** (`startSession` / `prompt`): `sent` | `no-model` | `skipped` | `failed`. After `no-model` / `failed` on `startSession`, the session still exists.

`request` **/** `agentRequest` **rules:** `method` is `GET` | `POST` | `PUT` | `PATCH` | `DELETE`. `path` must start with `/`, no scheme, stay on the declared origin (cloud API or agent loopback). Guest parses `body` as JSON when needed.

### 1.3 Error codes (`HostRequestError.code`)


| Code               | When                                          |
| ------------------ | --------------------------------------------- |
| `HOST_UNAVAILABLE` | No window, not in iframe, or disposed         |
| `HOST_TIMEOUT`     | No answer for 20s                             |
| `HOST_REJECTED`    | Host refusal, or unknown wire code            |
| `DISCONNECTED`     | No token / Linear connection                  |
| `DISABLED`         | Extension paused in Settings                  |
| `BAD_PATH`         | Path left origin or malformed                 |
| `NO_INTEGRATION`   | Manifest has no `integration`                 |
| `NO_SESSION`       | `prompt` / `sessionLink` with no open session |
| `SESSION_BUSY`     | `prompt({ send: true })` while busy           |
| `NO_AGENT`         | No agent, not granted, or not running         |
| `AGENT_FAILED`     | Agent crashed or never became ready           |


### 1.4 Field limits (client clamps before send)


| Field                            | Max       |
| -------------------------------- | --------- |
| Clipboard text                   | 32 000    |
| Compose / prompt / attach `text` | 16 000    |
| Attach `id`                      | 128       |
| Attach `title`                   | 200       |
| Attach `url`                     | 2 000     |
| Attach `author`                  | 80        |
| Branch name                      | 200       |
| Request path                     | 2 000     |
| Request body                     | 64 000    |
| Request response                 | 256 000   |
| Request timeout                  | 20 000 ms |


---

## 2. `@openchamber/sdk/ui` — drawing kit

DOM helpers that match host tracker chrome. They do **not** call the provider or `connectHost`. You pass rows and wire callbacks yourself.

Always call theme first:

```ts
import { applyHostReady, mountIssuePage } from '@openchamber/sdk/ui';

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);
  // then mount…
});
```

Every mount returns `{ update(props), dispose() }`.

### 2.1 Theme


| Function                      | Role                                                      |
| ----------------------------- | --------------------------------------------------------- |
| `applyHostReady(ctx, root)`   | Writes theme tokens + `data-oc-surface` / `data-oc-theme` |
| `applyHostTheme(theme, root)` | Tokens only                                               |


### 2.2 Mount functions


| Function                         | Use for                      | Main props                                                                                                                 |
| -------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `mountIssuePage(root, props)`    | Rail task list               | `items`, `onSelect`, optional `filters`, `busy`, `hasMore` / `onMore`, `toggle`, `session`, `action`                       |
| `mountAttachIssues(root, props)` | + menu / attach picker       | Same shape as issue page. Search stays open. On select → `host.attach` + `host.close`                                      |
| `mountIssueCard(root, props)`    | Issue detail after row click | `item`, `description?`, `status?`, `fields?`, `tags?`, `comments?`, `onBack`, `onAction?`, `onStatusChange?`, `onOpenUrl?` |
| `mountPullRequest(root, props)`  | PR / MR window               | `mode: 'view'                                                                                                              |
| `mountButton(root, props)`       | Shared button                | `label`, `onClick`, `variant?: 'default'                                                                                   |
| `mountTextField(root, props)`    | Label + input                | `label`, `value`, `onChange`, `password?`, `placeholder?`, `disabled?`                                                     |
| `mountEmpty(root, props)`        | Empty / disconnected state   | `title`, `body?`, `action?: { label, onClick }`                                                                            |


### 2.3 Helpers


| Function                                   | Role                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------- |
| `filterIssueTasks(items, query, filters?)` | Same client-side search/filter rules the list uses                          |
| `resolveFilterValue(filter)`               | Effective filter value (`all` when empty)                                   |
| `splitIssueCardMedia(text)`                | Lift `![alt](https://…)` and `[label](https://…)` from description/comments |


### 2.4 Row and filter shape (`IssueTask` / `IssueFilter`)

```ts
type IssueTask = {
  id: string;
  title: string;
  url?: string;
  identifier?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  team?: string;
  badge?: string;     // e.g. owner/repo
  subtitle?: string;  // e.g. feature → main
};

type IssueFilter = {
  id: string;
  label: string;
  field: 'status' | 'priority' | 'assignee' | 'team';
  value: string;              // initial choice; kit keeps live picks across update()
  options: { id: string; label: string }[];
  allValue?: string;          // default 'all'
  slot?: 'start' | 'end';     // omit → first is start, rest end
};
```

`onFilterChange` tells the guest so it can pass `value` again after a remount. The host does not persist guest filters.

**Attach picker extras:** `toggle` (one checkbox, guest owns meaning), `session` (second checkbox, e.g. create-in-worktree → `host.startSession({ worktree: true })`), `action` (page button), `hasMore` / `onMore` (pagination).

`mountPullRequest`**:** view needs `pull`; create needs `create.onSubmit`. Optional `create.branches` turns head/base into pickers. Tabs: Overview, Changes, Checks, Comments. Callbacks (`onAttach`, `onStartSession`, `onReady`, `onMerge`, …) stay off the footer when omitted. The kit never talks to git.

---

## 3. Manifest and host-side parse (`@openchamber/sdk`)

Used by the OpenChamber host and by tools that validate packages. Guests rarely call these from the iframe.

### 3.1 Manifest block (inside `package.json`)

```json
{
  "name": "@acme/hello-panel",
  "version": "1.0.0",
  "openchamber": {
    "apiVersion": 1,
    "engines": { "openchamber": ">=1.22.0" },
    "contributes": {
      "panel": {
        "id": "acme-hello",
        "name": "Hello",
        "icon": "window",
        "entry": "panel/index.html"
      },
      "attach": "dialog",
      "integration": { /* oauth | token | host */ },
      "agent": { /* optional local process */ }
    }
  }
}
```


| Key                   | Rules                                                                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `version`             | Semver required on install (`1.0.0`)                                                                                                                                                 |
| `apiVersion`          | Must be `1`                                                                                                                                                                          |
| `engines.openchamber` | Optional. Only `1.22.0` or `>=1.22.0`. Older host → `host-too-old`                                                                                                                   |
| `panel.id`            | kebab-case                                                                                                                                                                           |
| `panel.icon`          | Remixicon kebab name (`window`) **or** package `.svg` path. Remixicon needs no file. An `.svg` path must exist on disk or install fails (`invalid-manifest`). No URLs/absolute paths |
| `panel.entry`         | Path inside package. No `..`, absolute, or URL. HTML must exist; its relative `.js` scripts must exist (`missing-build` if not)                                                      |
| `attach`              | `true` / `"panel"` → + menu opens rail; `"dialog"` → host window; omit/`false` → off menus                                                                                           |
| `integration`         | Optional. Exactly one of `oauth`, `token`, or `host` (`provider: "linear"` only)                                                                                                     |
| `agent`               | Optional. `entry` must be a built `.js` file on disk. See [GUEST_AGENTS.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_AGENTS.md)                        |


Extra keys are dropped, not forwarded.

### 3.2 Parse / version helpers


| Export                                             | Role                                                      |
| -------------------------------------------------- | --------------------------------------------------------- |
| `parseManifest(document)`                          | Typed document → success/failure (does not throw on junk) |
| `parseManifestJson(json)`                          | String → same result                                      |
| `resolveAttachMode(attach)`                        | Normalize to `'panel'                                     |
| `resolveIntegrationAuth` / `resolveIntegrationApi` | Auth kind and API origin                                  |
| `toPublicIntegration` / `toPublicAgent`            | Catalog-safe public slices                                |
| `isGuestPackageSvgIcon`                            | Whether icon is a package SVG path                        |
| `compareOpenChamberVersions`                       | Semver compare                                            |
| `hostMeetsOpenChamberEngine`                       | Host vs `engines.openchamber` floor                       |
| `openChamberEngineMinimum`                         | Normalize `>=1.22.0` → floor string                       |
| `parseOpenChamberVersion`                          | Parse `x.y.z`                                             |


### 3.3 Protocol helpers (host + guest tooling)


| Export                                                                                                            | Role                               |
| ----------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `parseHostMessage` / `parseGuestMessage`                                                                          | Typed envelope builders            |
| `hostMessageSchema` / `guestMessageSchema`                                                                        | Zod schemas for `postMessage` data |
| `clampAttachRequest` / `clampStartSessionRequest` / `clampPromptRequest`                                          | Enforce field max lengths          |
| `isGuestRequestPath` / `isGuestRequestResult` / `isStartSessionResult` / `isPromptResult` / `isAgentStatusResult` | Narrow result payloads             |
| `isHostRequestErrorCode` / `resolveHostRequestErrorCode`                                                          | Error code validation              |


Constants: `OPENCHAMBER_SDK_CHANNEL`, `OPENCHAMBER_SDK_API_VERSION`, `HOST_LINEAR_API_ORIGIN`, `GUEST_*_MAX`, `GUEST_REQUEST_TIMEOUT_MS`, `HOST_REQUEST_ERROR_CODES`, `AGENT_STATUS_VALUES`, `SESSION_LIFECYCLE_PHASES`, `START_SESSION_SENT`.

---

## 4. Local agents (`contributes.agent`)

For Docker sockets, CLI binaries, kubectl, and similar. The sandboxed iframe cannot dial Unix sockets; the host spawns a package entry and proxies HTTP.

Panel → `agentRequest` → host → `127.0.0.1:port` → agent process → socket/CLI.


| Panel call                                      | Role                             |
| ----------------------------------------------- | -------------------------------- |
| `agentRequest({ method, path, query?, body? })` | Proxy to this guest's agent only |
| `agentStatus()`                                 | Lifecycle state                  |


Manifest sketch: `agent.entry` (path to **built** JS, e.g. `agent/main.js`), `runtime: "host"`, `permissions.sockets` and/or `permissions.exec`. Install refuses with `missing-build` when that file is absent. Non-empty permissions need **Allow local agent** in Settings → Extensions before the first request.

Bundle the agent the same way as the panel:

```bash
bun run --filter @openchamber/sdk bundle -- agent/main.ts agent/main.js
```

Full contract (env vars, `/health`, grants, socket overrides): `[GUEST_AGENTS.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_AGENTS.md)`.

---

## 5. What this package does not provide

Frozen on `apiVersion` 1 — named in docs, no host hole yet:

- Host-side `issues.search` / `issues.get` (guest draws the list; chip is `attach`)
- Public OAuth broker
- Commands, shortcuts, raw git remotes, magic prompts
- Second `host.provider` beyond Linear
- Filesystem, terminal, pairing, or host React components from the guest

Do not go around the guest contract through `RuntimeAPIs`.

---

## 6. Minimal panel sketch

```ts
import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady, mountIssuePage, mountEmpty } from '@openchamber/sdk/ui';

const host = connectHost();
const root = document.querySelector('#root')!;

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement);

  if (!ctx.connection.connected) {
    mountEmpty(root, {
      title: 'Connect Acme',
      action: { label: 'Sign in', onClick: () => { void host.oauthStart(); } },
    });
    return;
  }

  mountIssuePage(root, {
    items: [], // fill from host.request
    onSelect: (item) => {
      void host.attach({
        providerId: 'acme-hello',
        id: item.id,
        title: item.title,
        url: item.url ?? '',
      });
    },
  });
});

host.onConnection(async (connection) => {
  if (!connection.connected) return;
  try {
    const res = await host.request({ method: 'GET', path: '/api/v2/tasks' });
    // parse res.body, then remount / update the list
  } catch (error) {
    if (error instanceof HostRequestError && error.code === 'DISCONNECTED') {
      await host.oauthStart();
    }
  }
});
```

---

## Related files


| File                                                                                                                                                                                                                                                                                                                      | Audience                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| [README.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/README.md)                                                                                                                                                                                                                                   | Package overview and first hole   |
| [DOCUMENTATION.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/DOCUMENTATION.md)                                                                                                                                                                                                                     | Agent / maintainer invariants     |
| [GUEST_AGENTS.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/GUEST_AGENTS.md)                                                                                                                                                                                                                       | Local agent contract              |
| [src/ui/DOCUMENTATION.md](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/src/ui/DOCUMENTATION.md)                                                                                                                                                                                                       | UI kit invariants                 |
| [sdk.mdx](https://github.com/openchamber/openchamber/blob/sdk/packages/docs/content/docs/sdk.mdx) / [sdk/host.mdx](https://github.com/openchamber/openchamber/blob/sdk/packages/docs/content/docs/sdk/host.mdx) / [sdk/ui.mdx](https://github.com/openchamber/openchamber/blob/sdk/packages/docs/content/docs/sdk/ui.mdx) | Author-facing website pages       |
| [docs/index.html](https://github.com/openchamber/openchamber/blob/sdk/packages/sdk/docs/index.html)                                                                                                                                                                                                                       | Same pages as one local HTML file |


