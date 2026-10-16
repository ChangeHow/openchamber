import { afterEach, describe, expect, test } from 'bun:test';
import type { SyncEvent } from '@/lib/opencode/events';
import type { Part } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ChildStoreManager, publishDirectoryTextDelta, subscribeDirectoryTextDeltas } from './child-store';
import { createEventRoutingIndex, handleEvent } from './sync-context';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const fixture = () => {
  const manager = new ChildStoreManager();
  const child = manager.ensureChild('/repo', { bootstrap: false });
  const other = manager.ensureChild('/other', { bootstrap: false });
  const routing = createEventRoutingIndex();
  const parts: Part[] = [
    { id: 'text', type: 'text', sessionID: 's', messageID: 'a', text: '' },
    { id: 'reasoning', type: 'reasoning', sessionID: 's', messageID: 'a', text: '', time: { start: 0 } },
    { id: 'tool', type: 'tool', sessionID: 's', messageID: 'a', tool: 'bash', callID: 'c', state: { status: 'pending', input: {}, raw: '' } },
  ];
  const state = { session_status: { s: { type: 'busy' as const } }, message: { s: [
    { id: 'a', sessionID: 's', role: 'assistant' as const, time: { created: 0 }, providerID: 'p', modelID: 'm', agent: 'build' },
  ] }, part: { a: parts } };
  child.setState(state);
  other.setState(state);
  cleanups.push(() => manager.disposeAll());
  const received: string[] = [];
  const unsubscribe = subscribeDirectoryTextDeltas(child, 's', (text) => received.push(text));
  cleanups.push(unsubscribe);
  return {
    child, other, received, unsubscribe,
    receive: (event: SyncEvent, directory = '/repo', runtime = getRuntimeKey()) => handleEvent(directory, event, manager, routing, runtime),
    delta: (text: string, partID = 'text', field: 'text' | 'raw' = 'text', sessionID = 's', directory = '/repo') => handleEvent(directory, {
      type: 'message.part.delta', properties: { sessionID, messageID: 'a', partID, field, delta: text },
    }, manager, routing, getRuntimeKey()),
  };
};

describe('live text delta delivery', () => {
  test('publishes only appended live text for the subscribed directory and session', () => {
    const f = fixture();
    f.delta('abcd');
    expect(f.received).toEqual(['abcd']);
    f.delta('thought', 'reasoning');
    f.delta('command', 'tool', 'raw');
    f.delta('', 'text');
    f.delta('other session', 'text', 'text', 'other');
    f.delta('other directory', 'text', 'text', 's', '/other');
    expect(f.received).toEqual(['abcd']);
    f.unsubscribe();
    f.delta('after unmount');
    expect(f.received).toEqual(['abcd']);
  });

  test('snapshots and reconnect overlap do not count as new arrivals', () => {
    const f = fixture();
    f.child.setState({ part: { a: [{ id: 'text', type: 'text', sessionID: 's', messageID: 'a', text: 'already ' }] } });
    f.receive({ type: 'message.part.updated', properties: { sessionID: 's', part: {
      id: 'text', type: 'text', sessionID: 's', messageID: 'a', text: 'already loaded',
    } } });
    expect(f.received).toEqual([]);
    f.delta('already loaded');
    expect(f.received).toEqual([]);
    f.receive({ type: 'message.part.updated', properties: { sessionID: 's', part: {
      id: 'text', type: 'text', sessionID: 's', messageID: 'a', text: 'already loaded', time: { start: 1 },
    } } });
    f.delta('loaded new');
    expect(f.received).toEqual([' new']);
    f.receive({ type: 'message.parts.replaced', properties: { sessionID: 's', messageID: 'a', parts: [
      { id: 'text', type: 'text', sessionID: 's', messageID: 'a', text: 'whole snapshot' },
    ] } });
    expect(f.received).toEqual([' new']);
  });

  test('idle, retry and missing status cannot publish a live rate', () => {
    const f = fixture();
    for (const status of [{ type: 'idle' }, { type: 'retry', attempt: 1, message: 'retry', next: 0 }] as const) {
      f.child.setState({ session_status: { s: status } });
      f.delta('ignored');
    }
    f.child.setState({ session_status: {} });
    f.delta('unknown');
    expect(f.received).toEqual([]);
    f.child.setState({ session_status: { s: { type: 'busy' } } });
    f.delta('observed');
    expect(f.received).toEqual(['observed']);
  });

  test('stale-runtime events and orphan deltas cannot become samples', () => {
    const f = fixture();
    f.receive({ type: 'message.part.delta', properties: { sessionID: 's', messageID: 'a', partID: 'text', field: 'text', delta: 'stale' } }, '/repo', 'obsolete-runtime');
    f.delta('missing', 'missing');
    expect(f.received).toEqual([]);
  });

  test('unsubscribed streams never read part text for telemetry', () => {
    const f = fixture();
    f.unsubscribe();
    const text = f.child.getState().part.a[0];
    if (text.type !== 'text') throw new Error('Expected text part');
    let reads = 0;
    const previous = [{ ...text, get text() { reads += 1; return ''; } }];
    // Imported publisher is exercised separately so the reducer's own reads
    // are not mistaken for telemetry work.
    for (let i = 0; i < 100; i += 1) {
      publishDirectoryTextDelta(f.child, f.child.getState(), { sessionID: 's', messageID: 'a', partID: 'text', field: 'text', delta: 'abcd' }, previous);
    }
    expect(reads).toBe(0);
    // Positive control: a subscribed stream reads the appended text.
    const stop = subscribeDirectoryTextDeltas(f.child, 's', () => undefined);
    f.child.setState({ part: { a: [{ ...text, text: 'abcd' }] } });
    publishDirectoryTextDelta(f.child, f.child.getState(), { sessionID: 's', messageID: 'a', partID: 'text', field: 'text', delta: 'abcd' }, previous);
    expect(reads).toBe(1);
    stop();
  });
});
