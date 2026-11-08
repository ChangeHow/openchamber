import path from 'node:path';
import { isRecord, isString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';
import { createPageAnswers } from './render-page.js';
import { createSecretLeases } from './secret-leases.js';
import { normalizeSecretExecution, runSecret, validateSecretValues } from './secret-execution.js';

const NOT_WAITING_MESSAGE = 'This request is no longer waiting for a secret';

const readText = (value) => (isString(value) ? value.trim() : '');

/** Restore transient tool progress on an ordinary OpenCode message page. */
const restoreSecretMessagePage = (payload, progressForCall) => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) return payload;
  let changed = false;
  const data = payload.data.map((message) => {
    if (!isRecord(message) || !Array.isArray(message.content)) return message;
    let messageChanged = false;
    const content = message.content.map((tool) => {
      if (tool?.type !== 'tool' || tool.name !== 'openchamber_secret' || tool.state?.status !== 'running') return tool;
      const progress = progressForCall(tool.id);
      if (!progress) return tool;
      messageChanged = true;
      const metadata = isRecord(tool.state.metadata) ? tool.state.metadata : {};
      const previous = isRecord(metadata.openchamber_secret) ? metadata.openchamber_secret : {};
      return { ...tool, state: { ...tool.state, metadata: { ...metadata, openchamber_secret: { ...previous, ...progress } } } };
    });
    if (!messageChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...payload, data } : payload;
};

/** Collect missing inputs in memory for one authorized execution. */
export const createSecretRequests = ({ isEnabled, onWaitChange, hasUnreadChat = async () => false, leases = createSecretLeases() }) => {
  const waits = createPageAnswers({ onWaitChange });
  // Values never enter page answers,
  // wait events, tool results or files.
  const executions = new Map();
  const keyFor = (sessionId, callId) => `${sessionId}\0${callId}`;
  const publicInputs = (inputs) => inputs.map(({ env, label }) => ({ env, label }));

  // Snapshot recovery reads the same public progress as the live callback.
  // Never return an execution entry: it also holds submitted private values.
  const executionProgress = (sessionId, callId) => {
    const entry = executions.get(keyFor(sessionId, callId));
    return entry ? { secretExecution: true, secretInputs: publicInputs(entry.pendingInputs), revision: entry.revision } : undefined;
  };
  const hasSessionExecution = (sessionId) => {
    const prefix = `${sessionId}\0`;
    for (const key of executions.keys()) if (key.startsWith(prefix)) return true;
    return false;
  };
  const messageProgress = (sessionId) => {
    if (!hasSessionExecution(sessionId)) return null;
    // Read after the upstream response arrives, not when its request starts.
    return (payload) => restoreSecretMessagePage(payload, (callId) => executionProgress(sessionId, callId));
  };

  const run = async (input, { sessionId, callId, directory, signal = new AbortController().signal, onInputs = () => {} } = {}) => {
    if (!await isEnabled()) throw new OpenChamberControlError('The secret tool is turned off in OpenChamber settings', 403);
    if (process.platform === 'win32') throw new OpenChamberControlError('Private-input execution requires macOS or Linux', 501);
    if (!sessionId || !callId || !directory) throw new OpenChamberControlError('Execution requires a calling session, call id and directory', 400);
    let execution;
    try {
      execution = normalizeSecretExecution(input, directory, { ...path, isString, isRecord });
    } catch {
      throw new OpenChamberControlError('Invalid program, arguments, input bindings, environment, working directory, or timeout', 400);
    }
    if (await hasUnreadChat(sessionId)) return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
    const key = keyFor(sessionId, callId);
    if (executions.has(key)) throw new OpenChamberControlError('This call already waits for private inputs', 409);
    const entry = { pendingInputs: [], values: {}, submitted: new Set(), revision: 0 };
    executions.set(key, entry);
    try {
      while (!signal.aborted) {
        // Re-resolve after a card wait: a lease may expire or be revoked while
        // another input is being entered. Fresh one-shot values stay call-local.
        let missing;
        {
          const leased = leases.resolve(sessionId, execution.inputs.map((binding) =>
            entry.submitted.has(binding.env) ? { ...binding, refresh: false } : binding));
          const values = { ...leased, ...entry.values };
          missing = execution.inputs.filter((binding) => !Object.hasOwn(values, binding.env));
          if (!missing.length) {
            entry.pendingInputs = [];
            onInputs([], ++entry.revision);
            const reused = Object.keys(leased).filter((env) => !entry.submitted.has(env));
            const result = await runSecret(execution, values, signal);
            return reused.length ? { ...result, reused } : result;
          }
        }
        entry.pendingInputs = missing;
        entry.revision++;
        const pending = waits.wait({ sessionId, callId, title: missing[0].label, directory, signal });
        onInputs(publicInputs(missing), entry.revision);
        const answer = await pending;
        if (answer.summary !== 'submitted') break;
      }
      return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
    } catch {
      if (signal.aborted) return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
      // Never forward an exception that could contain private process state.
      throw new OpenChamberControlError('Private-input execution failed. Sensitive error details were omitted.', 500);
    } finally {
      executions.delete(key);
      entry.values = null;
    }
  };

  // A request that stopped waiting answers 404 with words the user reads in
  // the card, never a silent success.
  const settle = (sessionId, callId, summary, data) => {
    try {
      waits.answer({ sessionId, callId, summary, data });
    } catch (error) {
      if (error?.statusCode === 404) throw new OpenChamberControlError(NOT_WAITING_MESSAGE, 404);
      throw error;
    }
  };

  /** The answer route keeps private values out of the waiting callback. */
  const answer = async (input = {}) => {
    const sessionId = readText(input.sessionId);
    const callId = readText(input.callId);
    if (!sessionId || !callId) {
      throw new OpenChamberControlError('sessionId and callId are required', 400);
    }
    const key = keyFor(sessionId, callId);
    const execution = executions.get(key);
    if (!execution?.pendingInputs.length) throw new OpenChamberControlError(NOT_WAITING_MESSAGE, 404);
    if (input.declined === true) {
      settle(sessionId, callId, 'declined', null);
      execution.pendingInputs = [];
      return { status: 'declined' };
    }
    let values;
    try {
      values = validateSecretValues({ inputs: execution.pendingInputs }, input.values);
    } catch {
      throw new OpenChamberControlError('Supply every private input together, without empty values or NUL characters, at most 16000 characters each', 400);
    }
    settle(sessionId, callId, 'submitted', null);
    leases.remember(sessionId, execution.pendingInputs, values);
    for (const binding of execution.pendingInputs) {
      execution.submitted.add(binding.env);
      if (!binding.reuse) execution.values[binding.env] = values[binding.env];
    }
    execution.pendingInputs = [];
    return { status: 'submitted' };
  };

  const revoke = (sessionId) => {
    if (!sessionId) throw new OpenChamberControlError('Revocation requires a calling session', 400);
    leases.revoke(sessionId);
    return { status: 'revoked' };
  };

  return { run, answer, revoke, messageProgress, release: waits.release };
};
