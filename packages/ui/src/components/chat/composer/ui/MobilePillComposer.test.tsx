import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { I18nProvider } from '@/lib/i18n';
import { getDefaultTheme } from '@/lib/theme/themes';

mock.module('@/components/chat/SessionGoalRow', () => ({
    SessionGoalRow: () => null,
}));
mock.module('@/components/chat/SessionSuggestionChip', () => ({
    SessionSuggestionChip: () => null,
}));
mock.module('./ComposerAttachmentControls', () => ({
    ComposerAttachmentControls: () => null,
}));

const { MobilePillComposer } = await import('./MobilePillComposer');

const renderPill = (options: { hasContent: boolean; newSessionDraftOpen: boolean }) => renderToStaticMarkup(
    <I18nProvider>
        <MobilePillComposer
            message={options.hasContent ? 'Draft message' : ''}
            sessionId={options.newSessionDraftOpen ? null : 'session-1'}
            newSessionDraftOpen={options.newSessionDraftOpen}
            hasContent={options.hasContent}
            isVSCode={false}
            canAbort={false}
            footerIconButtonClass="icon-button"
            iconSizeClass="icon-size"
            sendIconSizeClass="send-icon-size"
            stopIconSizeClass="stop-icon-size"
            theme={getDefaultTheme(false)}
            onExpand={() => {}}
            onApplySuggestion={() => {}}
            onPrimaryAction={() => {}}
            onNewSession={() => {}}
            onPickLocalFiles={() => {}}
            onOpenIssuePicker={() => {}}
            onOpenPrPicker={() => {}}
            onOpenAttachSheet={() => {}}
            onStartDictation={() => {}}
            onAbort={() => {}}
        />
    </I18nProvider>,
);

describe('MobilePillComposer', () => {
    test('shows the send action for content in an existing session', () => {
        const markup = renderPill({ hasContent: true, newSessionDraftOpen: false });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).not.toContain('aria-label="New chat"');
    });

    test('shows the send action for content in a new-session draft', () => {
        const markup = renderPill({ hasContent: true, newSessionDraftOpen: true });

        expect(markup).toContain('aria-label="Send message"');
        expect(markup).not.toContain('aria-label="New chat"');
    });

    test('keeps the new-session action for an empty existing session', () => {
        const markup = renderPill({ hasContent: false, newSessionDraftOpen: false });

        expect(markup).toContain('aria-label="New chat"');
        expect(markup).not.toContain('aria-label="Send message"');
    });

    test('keeps the trailing action collapsed for an empty new-session draft', () => {
        const markup = renderPill({ hasContent: false, newSessionDraftOpen: true });

        expect(markup).toContain('w-0 opacity-0 overflow-hidden');
        expect(markup).not.toContain('aria-label="Send message"');
    });
});
