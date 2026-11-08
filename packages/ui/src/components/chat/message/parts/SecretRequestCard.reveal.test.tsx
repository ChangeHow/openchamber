import { afterAll, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';

import type { ToolPart } from '@/lib/opencode/model';
import type { RequestedSecret } from '@/lib/opencode/tools';
import type { answerSecretRequest } from '@/lib/secretRequestAnswer';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event,
  MutationObserver: browser.MutationObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

mock.module('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
mock.module('@/sync/sync-context', () => ({ useSessionDirectory: () => '/project' }));
const answers: Parameters<typeof answerSecretRequest>[0][] = [];
mock.module('@/lib/secretRequestAnswer', () => ({ answerSecretRequest: async (answer: Parameters<typeof answerSecretRequest>[0]) => { answers.push(answer); } }));
mock.module('@/components/ui', () => ({ toast: { error: () => undefined } }));
mock.module('@/components/chat/lib/scroll/timelineScrollIntent', () => ({ dispatchPageWaiting: () => undefined }));

const { createRoot } = await import('react-dom/client');
const { SecretRequestCard } = await import('./SecretRequestCard');
afterAll(() => browser.close());

test('the eye reveals the typed value and hides it again', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const part: ToolPart = {
    id: 'part-1',
    sessionID: 'ses-1',
    messageID: 'msg-1',
    type: 'tool',
    tool: 'openchamber_secret',
    callID: 'call-1',
    state: { status: 'pending', input: {}, raw: '' },
  };
  const request: RequestedSecret = { inputs: [{ env: 'TOKEN', label: 'API key' }] };

  try {
    await act(async () => root.render(<SecretRequestCard part={part} request={request} />));
    const input = () => container.querySelector<HTMLInputElement>('input')!;
    const toggle = () => container.querySelector<HTMLButtonElement>('button[aria-pressed]')!;

    expect(input().type).toBe('password');
    expect(toggle().getAttribute('aria-label')).toBe('chat.secretRequest.showSecret');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');

    await act(async () => {
      Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')!.set!.call(input(), 'sk-test-value');
      input().dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(input().value).toBe('sk-test-value');
    expect(container.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);

    await act(async () => toggle().click());
    expect(input().type).toBe('text');
    expect(input().value).toBe('sk-test-value');
    expect(toggle().getAttribute('aria-label')).toBe('chat.secretRequest.hideSecret');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    await act(async () => toggle().click());
    expect(input().type).toBe('password');
    expect(input().value).toBe('sk-test-value');
    expect(toggle().getAttribute('aria-label')).toBe('chat.secretRequest.showSecret');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test('multiple fields submit atomically and clear the local draft after submission', async () => {
  answers.length = 0;
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const part: ToolPart = {
    id: 'part-2', sessionID: 'ses-2', messageID: 'msg-2', type: 'tool', tool: 'openchamber_secret', callID: 'call-2',
    state: { status: 'running', input: {}, time: { start: 1 } },
  };
  const request: RequestedSecret = { inputs: [{ env: 'PASSWORD', label: 'Password' }, { env: 'OTP', label: 'Code' }] };
  try {
    await act(async () => root.render(<SecretRequestCard part={part} request={request} />));
    const fill = async (env: string, value: string) => act(async () => {
      const input = container.querySelector<HTMLInputElement>(`input[id="part-2-${env}"]`)!;
      Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submit = () => container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect([...container.querySelectorAll('input')].every((input) => input.type === 'password')).toBe(true);
    await fill('PASSWORD', 'synthetic-password');
    expect(submit().disabled).toBe(true);
    expect(answers).toEqual([]);
    await fill('OTP', 'synthetic-code');
    expect(submit().disabled).toBe(false);
    await act(async () => submit().click());
    expect(answers).toEqual([{ sessionId: 'ses-2', callId: 'call-2', values: { PASSWORD: 'synthetic-password', OTP: 'synthetic-code' } }]);
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('[data-secret-request-status="submitted"]')).not.toBeNull();
    expect(container.innerHTML.includes('synthetic-password')).toBe(false);
    expect(container.innerHTML.includes('synthetic-code')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
