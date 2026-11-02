const DEFAULT_TTL_MS = 10 * 60 * 1000;
const SESSION_CAP_MS = 30 * 60 * 1000;

/** Private process-local credentials. Only fresh submissions can start a new window. */
export const createSecretLeases = ({ now = Date.now, ttlMs = DEFAULT_TTL_MS } = {}) => {
  const sessions = new Map();
  const lifetime = Math.min(ttlMs, SESSION_CAP_MS);
  const sweep = () => {
    const time = now();
    for (const [id, session] of sessions) {
      if (session.expiresAt <= time) sessions.delete(id);
      else for (const [env, entry] of session.bindings) {
        if (entry.expiresAt <= time) session.bindings.delete(env);
      }
    }
  };
  const resolve = (sessionId, inputs) => {
    sweep();
    const session = sessions.get(sessionId);
    return Object.fromEntries(inputs.flatMap((input) => {
      const entry = input.reuse && !input.refresh ? session?.bindings.get(input.env) : undefined;
      return entry ? [[input.env, entry.value]] : [];
    }));
  };
  const remember = (sessionId, inputs, values) => {
    sweep();
    const reusable = inputs.filter((input) => input.reuse);
    if (!reusable.length) return;
    const time = now();
    const session = sessions.get(sessionId) ?? { expiresAt: time + SESSION_CAP_MS, bindings: new Map() };
    for (const input of reusable) {
      session.bindings.set(input.env, { value: values[input.env], expiresAt: Math.min(time + lifetime, session.expiresAt) });
    }
    sessions.set(sessionId, session);
  };
  const revoke = (sessionId) => { sessions.delete(sessionId); };
  return { resolve, remember, revoke, sweep };
};
