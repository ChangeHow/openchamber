import { afterAll, afterEach, expect, spyOn, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { RuntimeAPIs } from '@/lib/api/types';
import { createConversationSelectionStore } from './selectionStore';
import type { ChatMessageEntry } from '../lib/turns/types';

const browser = new Window();
Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator,
    localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
    HTMLElement: browser.HTMLElement, Element: browser.Element,
    HTMLAnchorElement: browser.HTMLAnchorElement,
    Node: browser.Node, Text: browser.Text, SVGElement: browser.SVGElement,
    Event: browser.Event, CustomEvent: browser.CustomEvent,
    MutationObserver: browser.MutationObserver, DOMParser: browser.DOMParser,
    DOMRect: browser.DOMRect, XMLSerializer: browser.XMLSerializer,
    IntersectionObserver: browser.IntersectionObserver, ResizeObserver: browser.ResizeObserver,
    customElements: browser.customElements,
    KeyboardEvent: browser.KeyboardEvent,
    getComputedStyle: browser.getComputedStyle.bind(browser),
    requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
    IS_REACT_ACT_ENVIRONMENT: true,
});
const { ConversationExportComposer } = await import('./ConversationExportComposer');
const { ConversationSelectionContext } = await import('./selectionContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { I18nProvider } = await import('@/lib/i18n');
const fetchBoundary = spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    const pathname = new URL(url, browser.location.href).pathname;
    if (pathname === '/api/fs/home') return Response.json({ home: '/project' });
    if (pathname === '/api/location') return Response.json({ directory: '/project', project: { directory: '/project' } });
    if (pathname === '/api/session-folders') return new Response(null, { status: 404 });
    if (pathname === '/api/config/settings') return Response.json({});
    throw new Error(`Unexpected export request: ${url}`);
});
const unavailable = (): never => { throw new Error('Rendering selection must not call runtime APIs'); };
const apis: RuntimeAPIs = {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    get terminal() { return unavailable(); },
    get git() { return unavailable(); },
    get files() { return unavailable(); },
    get settings() { return unavailable(); },
    get permissions() { return unavailable(); },
    get notifications() { return unavailable(); },
    get sourceControl() { return unavailable(); },
};
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); document.body.replaceChildren(); });
afterAll(() => { fetchBoundary.mockRestore(); browser.close(); });

const verifyComposerSelection = async (surface: 'desktop' | 'mobile') => {
    browser.location.href = `http://localhost/?surface=${surface}`;
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const composer = <form><textarea defaultValue="Draft and attachments stay here" /></form>;
    const store = createConversationSelectionStore();
    await act(async () => root?.render(
        <I18nProvider>
            <RuntimeAPIContext.Provider value={apis}>
                <ConversationSelectionContext.Provider value={store}>
                    <ConversationExportComposer getMessages={() => []} columnRef={{ current: container }}>{composer}</ConversationExportComposer>
                </ConversationSelectionContext.Provider>
            </RuntimeAPIContext.Provider>
        </I18nProvider>,
    ));
    const editor = container.querySelector('textarea');
    const editorSlot = container.querySelector<HTMLElement>('[data-conversation-export-composer]');
    expect(editorSlot?.style.visibility).toBe('');
    expect(container.querySelector('[role="toolbar"]')).toBeNull();
    await act(async () => store.getState().begin('assistant:one', async () => {}));
    expect(container.querySelector('textarea')).toBe(editor);
    expect(editorSlot?.style.visibility).toBe('hidden');
    expect(editorSlot?.hasAttribute('inert')).toBe(true);
    const toolbar = document.querySelector('[role="toolbar"]');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.closest('[inert]')).toBeNull();
    expect(container.contains(toolbar)).toBe(surface === 'desktop');
    expect(toolbar?.getAttribute('data-slot')).toBe('text-selection-toolbar');
    expect(toolbar?.classList.contains('oc-glass-popover')).toBe(true);
    expect(toolbar?.classList.contains('oc-glass-floating')).toBe(true);
    expect(toolbar?.querySelector('svg')).toBeNull();
    expect(toolbar?.textContent).toContain('Save as image');
    expect(toolbar?.textContent).toContain('Copy Markdown');
    await act(async () => store.getState().toggle('assistant:one'));
    expect(toolbar?.querySelector('[role="status"]')?.textContent).toContain('0');
    const buttons = toolbar?.querySelectorAll('button');
    expect(buttons?.[1]?.disabled).toBe(true);
    expect(buttons?.[2]?.disabled).toBe(true);
    await act(async () => store.getState().cancel());
    expect(container.querySelector('textarea')).toBe(editor);
    expect(editor?.value).toBe('Draft and attachments stay here');
    expect(editorSlot?.style.visibility).toBe('');
    expect(editorSlot?.hasAttribute('inert')).toBe(false);
    expect(document.querySelector('[role="toolbar"]')).toBeNull();
    await act(async () => store.getState().begin('assistant:one', async () => {}));
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('textarea')).toBe(editor);
    expect(editorSlot?.style.visibility).toBe('');
};

for (const surface of ['desktop', 'mobile'] as const) {
    test(`${surface} selection preserves the editor and disables hidden controls`, () => verifyComposerSelection(surface));
}

test('image export passes record content and live column width without a mounted initiating message', async () => {
    browser.location.href = 'http://localhost/';
    const container = document.createElement('div');
    container.getBoundingClientRect = () => new DOMRect(0, 0, 640, 500);
    document.body.append(container);
    root = createRoot(container);
    const messages: ChatMessageEntry[] = [{
        info: { id: 'prompt', sessionID: 'session', role: 'user', time: { created: 1 } },
        parts: [{ id: 'text', messageID: 'prompt', sessionID: 'session', type: 'text', text: 'Unmounted prompt' }],
    }];
    const store = createConversationSelectionStore();
    let savedSource: HTMLElement | undefined;
    let savedWidth = 0;
    let finishSave!: () => void;
    const saved = new Promise<void>((resolve) => { finishSave = resolve; });
    store.getState().begin('user:prompt', async (source, width) => {
        savedSource = source;
        savedWidth = width;
        finishSave();
    });
    await act(async () => root?.render(
        <I18nProvider><ConversationSelectionContext.Provider value={store}>
            <ConversationExportComposer getMessages={() => messages} columnRef={{ current: container }}><textarea /></ConversationExportComposer>
        </ConversationSelectionContext.Provider></I18nProvider>,
    ));
    const button = [...container.querySelectorAll('button')].find((element) => element.textContent === 'Save as image');
    expect(button).toBeDefined();
    await act(async () => { button?.click(); await saved; });
    expect(savedSource?.textContent).toContain('Unmounted prompt');
    expect(savedSource?.querySelector('[data-markdown-content]')).not.toBeNull();
    expect(savedWidth).toBe(640);
    expect(store.getState().active).toBe(true);
});
