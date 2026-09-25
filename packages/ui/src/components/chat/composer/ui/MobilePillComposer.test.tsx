import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { OpenCode } from '@opencode/client';
import { SyncProvider } from '@/sync/sync-context';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { I18nProvider } from '@/lib/i18n';

import { MobilePillComposer } from './MobilePillComposer';

const renderPill = async (options: { hasContent: boolean; newSessionDraftOpen: boolean; canAbort?: boolean }) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    const container = document.createElement('div');
    const root = createRoot(container);
    let primaryActions = 0;
    let queued = 0;
    let aborted = 0;
    try {
        await act(async () => root.render(
        <SyncProvider directory="/fixture" sdk={OpenCode.make({ baseUrl: "http://opencode.test", fetch: async () => new Response("[]", { headers: { "content-type": "application/json" } }) })}>
        <ThemeSystemProvider>
        <I18nProvider>
            <MobilePillComposer
                directory="/fixture"
                message={options.hasContent ? 'Draft message' : ''}
                sessionId={options.newSessionDraftOpen ? null : 'session-1'}
                newSessionDraftOpen={options.newSessionDraftOpen}
                hasContent={options.hasContent}
                isVSCode={false}
                canAbort={options.canAbort ?? false}
                footerIconButtonClass="icon-button"
                iconSizeClass="icon-size"
                sendIconSizeClass="send-icon-size"
                stopIconSizeClass="stop-icon-size"
                onExpand={() => {}}
                onPrimaryAction={() => { primaryActions += 1; }}
                onQueueMessage={() => { queued += 1; }}
                onPickLocalFiles={() => {}}
                onOpenIssuePicker={() => {}}
                onOpenPrPicker={() => {}}
                onOpenAttachSheet={() => {}}
                onStartDictation={() => {}}
                onAbort={() => { aborted += 1; }}
            />
        </I18nProvider>
        </ThemeSystemProvider>
        </SyncProvider>));
        if (options.hasContent && options.canAbort) {
            // While a turn runs the draft can only be queued, never sent past it.
            const queue = container.querySelector<HTMLButtonElement>('[aria-label="Queue message"]');
            expect(queue).not.toBeNull();
            await act(async () => { queue?.click(); });
            expect(queued).toBe(1);
            expect(primaryActions).toBe(0);
        } else if (options.hasContent) {
            const send = container.querySelector<HTMLButtonElement>('[aria-label="Send message"]');
            expect(send).not.toBeNull();
            await act(async () => { send?.click(); });
            expect(primaryActions).toBe(1);
            expect(queued).toBe(0);
        }
        if (options.canAbort) {
            const stop = container.querySelector<HTMLButtonElement>('[aria-label="Stop generating"]');
            expect(stop).not.toBeNull();
            const pill = container.querySelector('[data-mobile-composer-pill]');
            const actions = container.querySelector('[data-mobile-composer-actions]');
            expect(actions).not.toBeNull();
            expect(actions?.previousElementSibling).toBe(pill);
            expect(stop?.parentElement).toBe(actions);
            expect(actions?.lastElementChild).toBe(stop);
            expect(actions?.children).toHaveLength(options.hasContent ? 3 : 1);
            if (options.hasContent) {
                const divider = stop?.previousElementSibling;
                expect(divider?.getAttribute('aria-hidden')).toBe('true');
                expect(divider?.className).toContain('w-6');
                expect(divider?.previousElementSibling?.getAttribute('aria-label')).toBe('Queue message');
                expect(stop?.querySelector('svg')?.classList.contains('size-5')).toBe(true);
            }
            await act(async () => { stop?.click(); });
            expect(aborted).toBe(1);
        }
        return container.innerHTML;
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

describe('MobilePillComposer', () => {
    test('uses the inline action to send content while the session is idle', async () => {
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: false });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).not.toContain('data-mobile-composer-actions="true"');
    });

    test('uses the trailing action to queue content while the session is running', async () => {
        // The expanded composer shows a rotated send icon labelled "Queue
        // message" in this state; the collapsed pill must read the same.
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: false, canAbort: true });

        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).toContain('aria-label="Queue message"');
        expect(markup).toContain('-rotate-90');
        expect(markup).not.toContain('aria-label="Send message"');
        expect(markup).toContain('data-mobile-composer-actions="true"');
        expect(markup.indexOf('aria-label="Queue message"')).toBeLessThan(markup.indexOf('aria-label="Stop generating"'));
    });

    test('uses the inline send action for content in a new-session draft', async () => {
        const markup = await renderPill({ hasContent: true, newSessionDraftOpen: true });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).not.toContain('data-mobile-composer-actions="true"');
    });

    test('hides the action pill for an empty existing session', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: false });

        expect(markup).not.toContain('data-mobile-composer-actions="true"');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('hides the action pill for an empty new-session draft', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: true });

        expect(markup).not.toContain('data-mobile-composer-actions="true"');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('keeps only abort while a session runs without content', async () => {
        const markup = await renderPill({ hasContent: false, newSessionDraftOpen: false, canAbort: true });

        expect(markup).toContain('aria-label="Stop generating"');
        expect(markup).toContain('data-mobile-composer-actions="true"');
        expect(markup).not.toContain('aria-label="Queue message"');
        expect(markup).not.toContain('aria-label="Send message"');
    });
});
