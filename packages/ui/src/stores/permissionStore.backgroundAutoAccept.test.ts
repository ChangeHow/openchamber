import { beforeEach, describe, expect, mock, test } from "bun:test";

let serverState = { enabled: false, sessions: {} as Record<string, boolean> };
let failPut = false;

mock.module("@/lib/runtime-fetch", () => ({
  runtimeFetch: mock(async (_path: string, init?: RequestInit) => {
    if (init?.method === "PUT") {
      if (failPut) return new Response("failed", { status: 500 });
      serverState = JSON.parse(String(init.body));
    }
    return Response.json(serverState);
  }),
}));
mock.module("@/sync/sync-refs", () => ({ getAllSyncSessions: () => [], getSyncChildStores: () => ({ children: new Map() }) }));
mock.module("@/lib/opencode/client", () => ({ opencodeClient: { getDirectory: () => "", listPendingPermissions: async () => [] } }));
mock.module("@/sync/session-actions", () => ({ respondToPermission: async () => undefined }));
mock.module("@/sync/session-ui-store", () => ({ useSessionUIStore: { getState: () => ({ getDirectoryForSession: () => undefined }) } }));

const { usePermissionStore } = await import("./permissionStore");

describe("permissionStore background auto accept", () => {
  beforeEach(() => {
    serverState = { enabled: false, sessions: {} };
    failPut = false;
    usePermissionStore.setState({ autoAccept: {}, backgroundAutoAcceptEnabled: false });
  });

  test("enables only after the daemon accepts the complete map", async () => {
    usePermissionStore.setState({ autoAccept: { a: true } });
    await usePermissionStore.getState().setBackgroundAutoAccept(true);
    expect(serverState).toEqual({ enabled: true, sessions: { a: true } });
    expect(usePermissionStore.getState().backgroundAutoAcceptEnabled).toBe(true);
  });

  test("leaves ownership unchanged when enabling fails", async () => {
    failPut = true;
    await expect(usePermissionStore.getState().setBackgroundAutoAccept(true)).rejects.toThrow();
    expect(usePermissionStore.getState().backgroundAutoAcceptEnabled).toBe(false);
  });

  test("updates an enabled daemon before changing the displayed session state", async () => {
    usePermissionStore.setState({ backgroundAutoAcceptEnabled: true, autoAccept: { a: true } });
    await usePermissionStore.getState().setSessionAutoAccept("b", true);
    expect(serverState.sessions).toEqual({ a: true, b: true });
    expect(usePermissionStore.getState().autoAccept).toEqual({ a: true, b: true });

    failPut = true;
    await expect(usePermissionStore.getState().setSessionAutoAccept("a", false)).rejects.toThrow();
    expect(usePermissionStore.getState().autoAccept).toEqual({ a: true, b: true });
  });

  test("hydrates daemon sessions only when daemon ownership is enabled", async () => {
    usePermissionStore.setState({ autoAccept: { local: true } });
    serverState = { enabled: true, sessions: { remote: true } };
    await usePermissionStore.getState().hydrateBackgroundAutoAccept();
    expect(usePermissionStore.getState().autoAccept).toEqual({ remote: true });

    usePermissionStore.setState({ autoAccept: { local: true } });
    serverState = { enabled: false, sessions: { stale: true } };
    await usePermissionStore.getState().hydrateBackgroundAutoAccept();
    expect(usePermissionStore.getState().autoAccept).toEqual({ local: true });
  });

  test("keeps display policy while daemon ownership disables client replies", () => {
    usePermissionStore.setState({ autoAccept: { a: true }, backgroundAutoAcceptEnabled: true });
    expect(usePermissionStore.getState().isSessionAutoAccepting("a")).toBe(true);
    expect(usePermissionStore.getState().shouldClientAutoAccept("a")).toBe(false);
  });
});
