import React from 'react';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';

import { ComposerActionButtons } from './ComposerActionButtons';

const renderActions = (isMobile: boolean) => {
    const win = new Window();
    win.document.body.innerHTML = renderToStaticMarkup(
        <I18nProvider>
            <ComposerActionButtons
                isMobile={isMobile}
                footerIconButtonClass="icon-button"
                sendIconSizeClass="send-icon"
                stopIconSizeClass="stop-icon"
                canSend
                canAbort
                hasContent
                currentSessionId="session-1"
                newSessionDraftOpen={false}
                onPrimaryAction={() => {}}
                onQueueMessage={() => {}}
                onAbort={() => {}}
            />
        </I18nProvider>,
    );
    return { win, actions: win.document.body.firstElementChild };
};

describe('ComposerActionButtons', () => {
    test('reserves footer space for queue above stop on mobile', async () => {
        const { win, actions } = renderActions(true);
        try {
            const queue = actions?.querySelector('[aria-label="Queue message"]');
            const stop = actions?.querySelector('[aria-label="Stop generating"]');

            expect(actions?.classList.contains('flex-col')).toBe(true);
            expect(actions?.firstElementChild).toBe(queue);
            expect(actions?.lastElementChild).toBe(stop);
            expect(queue?.classList.contains('absolute')).toBe(false);
            expect(queue?.querySelector('svg')?.classList.contains('size-5')).toBe(true);
        } finally {
            await win.happyDOM.close();
        }
    });

    test('retains the floating queue action on desktop', async () => {
        const { win, actions } = renderActions(false);
        try {
            const queue = actions?.querySelector('[aria-label="Queue message"]');
            expect(queue?.classList.contains('absolute')).toBe(true);
            expect(queue?.querySelector('svg')?.classList.contains('send-icon')).toBe(true);
        } finally {
            await win.happyDOM.close();
        }
    });
});
