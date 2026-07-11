import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";
import type { Session } from "@opencode-ai/sdk/v2/client";
import {
    autoRespondsPermission,
    type PermissionAutoAcceptMap,
} from "./utils/permissionAutoAccept";
import { createDeferredSafeJSONStorage } from "./utils/safeStorage";
import { getAllSyncSessions, getSyncChildStores } from "@/sync/sync-refs";
import { opencodeClient } from "@/lib/opencode/client";
import { respondToPermission } from "@/sync/session-actions";
import { useSessionUIStore } from "@/sync/session-ui-store";
import { runtimeFetch } from "@/lib/runtime-fetch";

interface PermissionState {
    autoAccept: PermissionAutoAcceptMap;
    backgroundAutoAcceptEnabled: boolean;
}

interface PermissionActions {
    isSessionAutoAccepting: (sessionId: string) => boolean;
    shouldClientAutoAccept: (sessionId: string) => boolean;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
    setBackgroundAutoAccept: (enabled: boolean) => Promise<void>;
    hydrateBackgroundAutoAccept: () => Promise<void>;
}

type PermissionStore = PermissionState & PermissionActions;

const coerceAutoAcceptValue = (value: unknown): boolean => {
    if (typeof value === "boolean") {
        return value;
    }

    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        if (normalized === "true") {
            return true;
        }
        if (normalized === "false") {
            return false;
        }
    }

    if (typeof value === "number") {
        return value === 1;
    }

    return false;
};

const isLegacyDirectoryAutoAcceptKey = (key: string): boolean => key.endsWith("/*");

const extractSessionIdFromLegacyKey = (key: string): string | null => {
    const trimmed = key.trim();
    if (!trimmed) {
        return null;
    }
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash === -1 || lastSlash === trimmed.length - 1) {
        return trimmed;
    }
    return trimmed.slice(lastSlash + 1);
};

const resolveSessionScope = (sessionID: string, sessions: Session[]): Set<string> => {
    const map = new Map<string, Session>();
    const children = new Map<string, string[]>();
    for (const session of sessions) {
        map.set(session.id, session);
        if (session.parentID) {
            const list = children.get(session.parentID);
            if (list) {
                list.push(session.id);
            } else {
                children.set(session.parentID, [session.id]);
            }
        }
    }

    if (!map.has(sessionID)) {
        return new Set([sessionID]);
    }

    const result = new Set<string>();
    const seen = new Set<string>();
    const queue = [sessionID];
    while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current)) {
            continue;
        }
        seen.add(current);
        result.add(current);
        const nextChildren = children.get(current);
        if (!nextChildren || nextChildren.length === 0) {
            continue;
        }
        for (const child of nextChildren) {
            if (!seen.has(child)) {
                queue.push(child);
            }
        }
    }

    return result;
};

const normalizeDirectoryCandidate = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
};

const collectPendingFromSyncStores = (): Array<{ id: string; sessionID: string }> => {
    try {
        const stores = getSyncChildStores();
        const pending: Array<{ id: string; sessionID: string }> = [];
        for (const store of stores.children.values()) {
            const permissionMap = store.getState().permission ?? {};
            for (const [sessionId, entries] of Object.entries(permissionMap)) {
                for (const permission of entries ?? []) {
                    if (!permission?.id) continue;
                    pending.push({ id: permission.id, sessionID: permission.sessionID || sessionId });
                }
            }
        }
        return pending;
    } catch {
        return [];
    }
};

const sessionBelongsToScope = async (
    sessionID: string,
    rootSessionID: string,
    knownSessions: Session[],
    directories: string[],
): Promise<boolean> => {
    if (sessionID === rootSessionID) {
        return true;
    }

    const knownById = new Map<string, Session>();
    for (const session of knownSessions) {
        knownById.set(session.id, session);
    }

    const fetchedById = new Map<string, Session>();
    const fetchSession = async (id: string): Promise<Session | null> => {
        const known = knownById.get(id) ?? fetchedById.get(id);
        if (known) return known;

        for (const directory of directories) {
            try {
                const result = await opencodeClient.getScopedSdkClient(directory).session.get({
                    sessionID: id,
                    directory,
                });
                if (result.data) {
                    fetchedById.set(id, result.data);
                    return result.data;
                }
            } catch {
                // Try the next known project directory.
            }
        }

        try {
            const result = await opencodeClient.getSdkClient().session.get({ sessionID: id });
            if (result.data) {
                fetchedById.set(id, result.data);
                return result.data;
            }
        } catch {
            // Missing session metadata means we cannot safely inherit the parent setting.
        }

        return null;
    };

    const seen = new Set<string>();
    let current: string | undefined = sessionID;
    while (current && !seen.has(current)) {
        if (current === rootSessionID) {
            return true;
        }
        seen.add(current);
        const session = await fetchSession(current);
        current = session?.parentID ?? undefined;
    }

    return false;
};

const autoRespondsPermissionBySession = (
    autoAccept: PermissionAutoAcceptMap,
    sessions: Session[],
    sessionID: string,
): boolean => {
    return autoRespondsPermission({
        autoAccept,
        sessionID,
        sessions,
    });
};

const getStorage = () => createDeferredSafeJSONStorage();

type BackgroundAutoAcceptState = { enabled: boolean; sessions: PermissionAutoAcceptMap };
let backgroundUpdateQueue = Promise.resolve();

const serializeBackgroundUpdate = <T,>(update: () => Promise<T>): Promise<T> => {
    const result = backgroundUpdateQueue.then(update, update);
    backgroundUpdateQueue = result.then(() => undefined, () => undefined);
    return result;
};

const putBackgroundAutoAccept = async (state: BackgroundAutoAcceptState): Promise<BackgroundAutoAcceptState> => {
    const response = await runtimeFetch('/api/openchamber/background-auto-accept', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(state),
    });
    if (!response.ok) throw new Error('Failed to update background auto accept');
    return response.json() as Promise<BackgroundAutoAcceptState>;
};

const mirrorNotificationAutoAccept = (sessionIds: Iterable<string>, enabled: boolean): void => {
    for (const sessionId of sessionIds) {
        void runtimeFetch('/api/notifications/auto-accept', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled }),
        }).catch(() => undefined);
    }
};

export const usePermissionStore = create<PermissionStore>()(
    devtools(
        persist(
            (set, get) => ({
                autoAccept: {},
                backgroundAutoAcceptEnabled: false,

                isSessionAutoAccepting: (sessionId: string) => {
                    if (!sessionId) {
                        return false;
                    }

                    const sessions = getAllSyncSessions();
                    return autoRespondsPermissionBySession(get().autoAccept, sessions, sessionId);
                },

                shouldClientAutoAccept: (sessionId: string) => {
                    return !get().backgroundAutoAcceptEnabled && get().isSessionAutoAccepting(sessionId);
                },

                hydrateBackgroundAutoAccept: () => serializeBackgroundUpdate(async () => {
                    const response = await runtimeFetch('/api/openchamber/background-auto-accept');
                    if (!response.ok) throw new Error('Failed to load background auto accept');
                    const state = await response.json() as BackgroundAutoAcceptState;
                    set(state.enabled
                        ? { backgroundAutoAcceptEnabled: true, autoAccept: state.sessions }
                        : { backgroundAutoAcceptEnabled: false });
                    if (!state.enabled) {
                        mirrorNotificationAutoAccept(
                            Object.entries(get().autoAccept).filter(([, enabled]) => enabled).map(([sessionId]) => sessionId),
                            true,
                        );
                    }
                }),

                setBackgroundAutoAccept: (enabled: boolean) => serializeBackgroundUpdate(async () => {
                    const sessions = get().autoAccept;
                    await putBackgroundAutoAccept({ enabled, sessions });
                    set({ backgroundAutoAcceptEnabled: enabled });
                    if (!enabled) {
                        await Promise.all(Object.entries(sessions)
                            .filter(([, autoAccept]) => autoAccept)
                            .map(([sessionId]) => get().setSessionAutoAccept(sessionId, true)));
                    }
                }),

                setSessionAutoAccept: async (sessionId: string, enabled: boolean) => {
                    if (!sessionId) {
                        return;
                    }

                    const sessions = getAllSyncSessions();

                    if (get().backgroundAutoAcceptEnabled) {
                        return serializeBackgroundUpdate(async () => {
                            const autoAccept = { ...get().autoAccept, [sessionId]: enabled };
                            await putBackgroundAutoAccept({ enabled: true, sessions: autoAccept });
                            set({ autoAccept });
                        });
                    }

                    set((state) => {
                        const autoAccept = { ...state.autoAccept };
                        autoAccept[sessionId] = enabled;
                        return { autoAccept };
                    });

                    const sessionScope = resolveSessionScope(sessionId, sessions);
                    mirrorNotificationAutoAccept(sessionScope, enabled);

                    if (!enabled) {
                        return;
                    }

                    const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId);
                    const directories = new Set<string>();
                    const currentDirectory = normalizeDirectoryCandidate(opencodeClient.getDirectory());
                    if (currentDirectory) {
                        directories.add(currentDirectory);
                    }
                    const mappedSessionDirectory = normalizeDirectoryCandidate(sessionDirectory);
                    if (mappedSessionDirectory) {
                        directories.add(mappedSessionDirectory);
                    }
                    for (const scopedSessionId of sessionScope) {
                        const mapped = normalizeDirectoryCandidate(useSessionUIStore.getState().getDirectoryForSession(scopedSessionId));
                        if (mapped) {
                            directories.add(mapped);
                        }
                    }

                    const directoryList = Array.from(directories);
                    const pendingFromStores = collectPendingFromSyncStores();
                    // Best-effort: if listPendingPermissions throws (transient fetch failure),
                    // proceed with whatever sync-store snapshots gave us. The next SSE event
                    // or reconnect resync will auto-accept anything we missed.
                    const pendingFromApi = await opencodeClient
                      .listPendingPermissions({ directories: Array.from(directories) })
                      .catch(() => []);
                    const mergedPending = new Map<string, { id: string; sessionID: string }>();

                    for (const permission of pendingFromStores) {
                        if (sessionScope.has(permission.sessionID)) {
                            mergedPending.set(permission.id, permission);
                            continue;
                        }
                        if (await sessionBelongsToScope(permission.sessionID, sessionId, sessions, directoryList)) {
                            mergedPending.set(permission.id, permission);
                        }
                    }
                    for (const permission of pendingFromApi) {
                        if (!permission?.id || !permission?.sessionID) {
                            continue;
                        }
                        if (!sessionScope.has(permission.sessionID)) {
                            const belongsToScope = await sessionBelongsToScope(permission.sessionID, sessionId, sessions, directoryList);
                            if (!belongsToScope) {
                                continue;
                            }
                        }
                        mergedPending.set(permission.id, { id: permission.id, sessionID: permission.sessionID });
                    }

                    await Promise.all(
                        Array.from(mergedPending.values())
                            .map((permission) => respondToPermission(permission.sessionID, permission.id, "once").catch(() => undefined)),
                    );
                },
            }),
            {
                name: "permission-store",
                storage: getStorage(),
                partialize: (state) => ({
                    autoAccept: state.autoAccept,
                    backgroundAutoAcceptEnabled: state.backgroundAutoAcceptEnabled,
                }),
                merge: (persistedState, currentState) => {
                    const merged = {
                        ...currentState,
                        ...(persistedState as Partial<PermissionStore>),
                    };

                    const persisted = Object.entries(merged.autoAccept || {});
                    const nextAutoAccept: PermissionAutoAcceptMap = {};

                    for (const [rawKey, rawEnabled] of persisted) {
                        if (rawKey.includes("/") || isLegacyDirectoryAutoAcceptKey(rawKey)) {
                            continue;
                        }
                        nextAutoAccept[rawKey] = coerceAutoAcceptValue(rawEnabled);
                    }

                    for (const [rawKey, rawEnabled] of persisted) {
                        if (isLegacyDirectoryAutoAcceptKey(rawKey)) {
                            continue;
                        }
                        if (!rawKey.includes("/")) {
                            continue;
                        }

                        const sessionId = extractSessionIdFromLegacyKey(rawKey);
                        if (!sessionId) {
                            continue;
                        }
                        if (Object.prototype.hasOwnProperty.call(nextAutoAccept, sessionId)) {
                            continue;
                        }

                        const normalized = coerceAutoAcceptValue(rawEnabled);
                        const existing = nextAutoAccept[sessionId];
                        nextAutoAccept[sessionId] = existing === true ? true : normalized;
                    }

                    return {
                        ...merged,
                        autoAccept: nextAutoAccept,
                    };
                },
                onRehydrateStorage: () => (state) => {
                    if (!state) return;
                    void state.hydrateBackgroundAutoAccept().catch(() => undefined);
                },
            }
        ),
        { name: "permission-store" }
    )
);
