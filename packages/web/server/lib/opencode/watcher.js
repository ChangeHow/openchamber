import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';

export const createOpenCodeWatcherRuntime = (deps) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onPayload,
    fetchImpl = fetch,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs = 1000,
    globalEventHub = null,
  } = deps;

  let abortController = null;
  let reader = null;
  let unsubscribeEvent = null;
  let unsubscribeStatus = null;
  let permissionAutoAcceptState = { enabled: false, sessions: {} };
  const sessionParents = new Map();

  const setPermissionAutoAcceptState = (state) => {
    const sessions = state?.sessions && typeof state.sessions === 'object' && !Array.isArray(state.sessions)
      ? Object.fromEntries(Object.entries(state.sessions).filter(([id, enabled]) => id && typeof enabled === 'boolean'))
      : {};
    permissionAutoAcceptState = {
      enabled: state?.enabled === true,
      sessions,
    };
  };

  const fetchSessionParent = async (sessionId, directory) => {
    try {
      const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
      const response = await fetchImpl(buildOpenCodeUrl(`/session/${encodeURIComponent(sessionId)}${query}`), {
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
      });
      if (!response.ok) return undefined;
      const session = await response.json().catch(() => null);
      const parentID = typeof session?.parentID === 'string' ? session.parentID : undefined;
      if (parentID) sessionParents.set(sessionId, parentID);
      return parentID;
    } catch {
      return undefined;
    }
  };

  const isSessionAutoAccepted = async (sessionId, directory) => {
    const seen = new Set();
    let current = sessionId;
    while (current && !seen.has(current)) {
      if (Object.hasOwn(permissionAutoAcceptState.sessions, current)) {
        return permissionAutoAcceptState.sessions[current] === true;
      }
      seen.add(current);
      current = sessionParents.get(current) ?? await fetchSessionParent(current, directory);
    }
    return false;
  };

  const processEnvelope = async (event) => {
    const payload = unwrapGlobalEventPayload(event?.payload);
    if (!payload || typeof payload !== 'object') return;

    const properties = payload.properties && typeof payload.properties === 'object' ? payload.properties : {};
    if (payload.type === 'session.created' || payload.type === 'session.updated') {
      const info = properties.info && typeof properties.info === 'object' ? properties.info : properties;
      if (typeof info.id === 'string' && typeof info.parentID === 'string') {
        sessionParents.set(info.id, info.parentID);
      }
    }
    onPayload(payload);

    if (payload.type === 'permission.asked' && permissionAutoAcceptState.enabled) {
      const permissionId = typeof properties.id === 'string' ? properties.id : '';
      const sessionId = typeof properties.sessionID === 'string' ? properties.sessionID : '';
      const directory = typeof event?.directory === 'string' ? event.directory : '';
      if (permissionId && directory && await isSessionAutoAccepted(sessionId, directory)) {
        try {
          const response = await fetchImpl(buildOpenCodeUrl(`/permission/${encodeURIComponent(permissionId)}/reply?directory=${encodeURIComponent(directory)}`), {
            method: 'POST',
            headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...getOpenCodeAuthHeaders() },
            body: JSON.stringify({ reply: 'once' }),
          });
          if (!response.ok) console.warn(`[PushWatcher] permission reply failed (${response.status})`);
        } catch (error) {
          console.warn('[PushWatcher] permission reply failed', error);
        }
      }
    }
  };

  const unwrapGlobalEventPayload = (eventData) => {
    if (!eventData || typeof eventData !== 'object') {
      return null;
    }

    if (eventData.payload && typeof eventData.payload === 'object') {
      return eventData.payload;
    }

    return eventData;
  };

  const start = async () => {
    if (abortController) {
      return;
    }

    await waitForOpenCodePort();

    abortController = new AbortController();
    const signal = abortController.signal;

    if (globalEventHub) {
      unsubscribeEvent = globalEventHub.subscribeEvent(processEnvelope);
      unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
        if (signal.aborted) {
          return;
        }
        if (status.type === 'connect') {
          console.log('[PushWatcher] connected');
          return;
        }
        if (status.type === 'error' || status.type === 'initial-error') {
          console.warn('[PushWatcher] disconnected', status.error?.error?.message ?? status.error?.message ?? status.error);
        }
      });
      globalEventHub.start();
      return;
    }

    reader = createUpstreamSseReader({
      signal,
      buildUrl: () => buildOpenCodeUrl('/global/event', ''),
      getHeaders: getOpenCodeAuthHeaders,
      fetchImpl,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      onConnect() {
        console.log('[PushWatcher] connected');
      },
      onEvent(event) {
        void processEnvelope(event);
      },
      onError(error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[PushWatcher] disconnected', error?.error?.message ?? error?.message ?? error);
      },
    });

    void reader.start();
  };

  const stop = () => {
    if (!abortController) {
      return;
    }
    try {
      abortController.abort();
      reader?.stop();
      unsubscribeEvent?.();
      unsubscribeStatus?.();
    } catch {
    }
    reader = null;
    unsubscribeEvent = null;
    unsubscribeStatus = null;
    abortController = null;
  };

  return {
    start,
    stop,
    getPermissionAutoAcceptState: () => ({
      enabled: permissionAutoAcceptState.enabled,
      sessions: { ...permissionAutoAcceptState.sessions },
    }),
    setPermissionAutoAcceptState,
  };
};
