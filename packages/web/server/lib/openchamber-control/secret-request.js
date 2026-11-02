import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isRecord, isString } from '../shared/guards.js';
import { OpenChamberControlError } from './error.js';
import { createPageAnswers } from './render-page.js';
import { normalizeSecretExecution, runSecret, validateSecretValues } from './secret-execution.js';

export const SECRET_REQUEST_MAX_LABEL_LENGTH = 120;
export const SECRET_REQUEST_MAX_REASON_LENGTH = 1000;
export const SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH = 80;
// A token, a key or a password: the card's field is one line.
const SECRET_MAX_VALUE_LENGTH = 16_000;
export const SECRET_FILE_LIFETIME_MS = 24 * 60 * 60 * 1000;

const SAVED_NOTE = "The user saved the secret to file, which only this user can read. Read it inside the command that needs it, such as TOKEN=\"$(cat <file>)\" some-cli ...; never print, echo or log it, and never copy it into the project. The file is deleted 24 hours after it was saved.";
const DECLINED_NOTE = "The user declined to give this secret. Continue without it or say what it blocks; ask again only if they want to.";
const CHAT_SENT_EARLIER_NOTE = "The card did not wait: the user had already written in the chat before it appeared, and that message follows this result. Continue from that message; ask for the secret again only if it still fits.";

/**
 * What the agent reads when the user wrote in the chat instead of answering
 * the card. The plugin builds that result itself (see ../agent-tool/runtime.js),
 * because the wait ends there, before this server hears of it.
 */
export const SECRET_REQUEST_CLOSED_IN_CHAT_NOTE = "The user did not give the secret and wrote in the chat instead; their message follows this result. If they pasted a secret there, tell them to rotate it, since the chat keeps it.";

const NOT_WAITING_MESSAGE = 'This request is no longer waiting for a secret';

const readText = (value) => (isString(value) ? value.trim() : '');

/**
 * Where saved secrets live: one file per secret, readable only by this user,
 * deleted 24 hours after it was written. The file is the only copy; the value
 * never enters the tool call, its result or the chat.
 */
export const createSecretFiles = ({ directory, now = Date.now, fsPromises = fs }) => {
  const write = async (value) => {
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    // `mkdir` applies the mode only to a directory it creates.
    await fsPromises.chmod(directory, 0o700);
    const file = path.join(directory, crypto.randomBytes(16).toString('hex'));
    try {
      await fsPromises.writeFile(file, value, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      // `wx` creates the file before writing, so a failed write can leave part of the secret.
      await fsPromises.rm(file, { force: true }).catch(() => {});
      throw error;
    }
    return file;
  };

  const remove = (file) => fsPromises.rm(file, { force: true });

  const sweep = async () => {
    const names = await fsPromises.readdir(directory).catch(() => []);
    const cutoff = now() - SECRET_FILE_LIFETIME_MS;
    await Promise.all(names.map(async (name) => {
      const file = path.join(directory, name);
      const stat = await fsPromises.stat(file).catch(() => null);
      if (stat && stat.mtimeMs < cutoff) await remove(file).catch(() => {});
    }));
  };

  return { write, remove, sweep };
};

/**
 * `secret.request`: the chat shows a card for the call, and the call waits
 * until the user saves a value or declines. The wait is a page wait
 * (`createPageAnswers`), so the session shows as waiting for the user the way
 * it does for a page, with the same pending list, events and notification.
 * Its answer carries `saved` or `declined` as the summary and the file path
 * as the data; the value itself never reaches the call.
 *
 * Like a page, the card does not wait when `hasUnreadChat` finds a message
 * the user sent before it appeared: OpenCode delivers that message only once
 * this call returns, so waiting would hold it back.
 */
export const createSecretRequests = ({ isEnabled, files, onWaitChange, hasUnreadChat = async () => false }) => {
  const waits = createPageAnswers({ onWaitChange });
  // Only execution waits have an entry here. Values never enter page answers,
  // wait events, tool results or files.
  const executions = new Map();
  const keyFor = (sessionId, callId) => `${sessionId}\0${callId}`;

  const run = async (input, { sessionId, callId, directory, signal = new AbortController().signal } = {}) => {
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
    const entry = { execution, values: null };
    executions.set(key, entry);
    try {
      const answer = await waits.wait({ sessionId, callId, title: execution.inputs[0].label, directory, signal });
      if (answer.summary !== 'submitted' || signal.aborted) return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
      return await runSecret(execution, entry.values, signal);
    } catch {
      if (signal.aborted) return { status: 'cancelled', exitCode: null, stdout: '', stderr: '' };
      // Never forward an exception that could contain private process state.
      throw new OpenChamberControlError('Private-input execution failed. Sensitive error details were omitted.', 500);
    } finally {
      executions.delete(key);
      entry.values = null;
    }
  };

  const request = async (input, { sessionId, callId, directory, signal } = {}) => {
    if (!await isEnabled()) {
      throw new OpenChamberControlError('The secret tool is turned off in OpenChamber settings', 403);
    }
    if (!files) {
      throw new OpenChamberControlError('This server cannot store secrets', 503);
    }
    const label = readText(input.label);
    const reason = readText(input.reason);
    const placeholder = readText(input.placeholder);
    if (!label || !reason) {
      throw new OpenChamberControlError('label and reason are required: what the secret is, and what you will do with it', 400);
    }
    if (label.length > SECRET_REQUEST_MAX_LABEL_LENGTH) {
      throw new OpenChamberControlError(`label is ${label.length} characters; the limit is ${SECRET_REQUEST_MAX_LABEL_LENGTH}`, 400);
    }
    if (reason.length > SECRET_REQUEST_MAX_REASON_LENGTH) {
      throw new OpenChamberControlError(`reason is ${reason.length} characters; the limit is ${SECRET_REQUEST_MAX_REASON_LENGTH}`, 400);
    }
    if (placeholder.length > SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH) {
      throw new OpenChamberControlError(`placeholder is ${placeholder.length} characters; the limit is ${SECRET_REQUEST_MAX_PLACEHOLDER_LENGTH}`, 400);
    }
    // A plugin generated before secrets could wait sends no call id.
    if (!sessionId || !callId) {
      throw new OpenChamberControlError('This connection cannot wait for a secret', 400);
    }
    if (await hasUnreadChat(sessionId)) {
      return { answer: { answered: false, reason: 'chat-sent-earlier' }, note: CHAT_SENT_EARLIER_NOTE };
    }
    const answer = await waits.wait({ sessionId, callId, title: label, directory, signal });
    const file = isString(answer.data?.file) ? answer.data.file : null;
    // The answer can settle the wait just as the call ends (Stop, a chat
    // message): nobody will read the path, so the file goes too.
    if (signal?.aborted) {
      if (file) await files.remove(file).catch(() => {});
      throw new OpenChamberControlError('The card stopped waiting before the user answered', 499);
    }
    if (answer.summary === 'saved' && file) {
      return { answer: { status: 'saved', file }, note: SAVED_NOTE };
    }
    return { answer: { status: 'declined' }, note: DECLINED_NOTE };
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

  /**
   * The chat's side. The value goes straight to its file, and only the path
   * reaches the waiting call. When the call stopped waiting in the meantime
   * the file is removed again, so no secret outlives a request nobody reads.
   */
  const answer = async (input = {}) => {
    const sessionId = readText(input.sessionId);
    const callId = readText(input.callId);
    if (!sessionId || !callId) {
      throw new OpenChamberControlError('sessionId and callId are required', 400);
    }
    const key = keyFor(sessionId, callId);
    const execution = executions.get(key);
    if (execution) {
      if (input.declined === true) {
        settle(sessionId, callId, 'declined', null);
        executions.delete(key);
        return { status: 'declined' };
      }
      let values;
      try {
        values = validateSecretValues(execution.execution, input.values);
      } catch {
        throw new OpenChamberControlError('Supply every private input together, without empty values or NUL characters, at most 16000 characters each', 400);
      }
      settle(sessionId, callId, 'submitted', null);
      execution.values = values;
      executions.delete(key);
      return { status: 'submitted' };
    }
    // A stale execution answer must never fall through to file mode.
    if (input.values !== undefined) throw new OpenChamberControlError(NOT_WAITING_MESSAGE, 404);
    if (input.declined === true) {
      settle(sessionId, callId, 'declined', null);
      return { status: 'declined' };
    }
    const value = isString(input.value) ? input.value : '';
    if (!value.trim()) {
      throw new OpenChamberControlError('value is required', 400);
    }
    if (value.length > SECRET_MAX_VALUE_LENGTH) {
      throw new OpenChamberControlError(`The secret is ${value.length} characters; the limit is ${SECRET_MAX_VALUE_LENGTH}`, 413);
    }
    if (!files) {
      throw new OpenChamberControlError('This server cannot store secrets', 503);
    }
    const file = await files.write(value);
    try {
      settle(sessionId, callId, 'saved', { file });
    } catch (error) {
      await files.remove(file).catch(() => {});
      throw error;
    }
    return { status: 'saved' };
  };

  return { request, run, answer, release: waits.release };
};
