import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ComposerEditorHandle } from '../ComposerEditor';
import type { ComposerLanguageContext } from '../../language/tokenize';
import type { ChatDraftIdentity } from '@/lib/chatDraftPersistence';

// Exercise CodeMirror's actual observer and document reader with controlled
// mutation delivery and frames. This models iOS event ordering, not WebKit.
const browser = new Window();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const observers: ManualMutationObserver[] = [];
class ManualMutationObserver extends browser.MutationObserver {
    constructor(private readonly deliver: ConstructorParameters<typeof browser.MutationObserver>[0]) {
        super(deliver);
        observers.push(this);
    }

    flushRecords() {
        const records = this.takeRecords();
        if (records.length) this.deliver(records, this);
    }
}

const iosNavigator = { userAgent: 'Mobile/15E148 Safari/604.1', vendor: 'Apple Computer, Inc.', platform: 'iPhone', maxTouchPoints: 5 };
const globals = {
    window: browser, document: browser.document, navigator: iosNavigator,
    Window: browser.Window,
    localStorage: browser.localStorage,
    HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
    Event: browser.Event, CompositionEvent: browser.CompositionEvent,
    MutationObserver: ManualMutationObserver, ResizeObserver: browser.ResizeObserver,
    requestAnimationFrame: (callback: FrameRequestCallback) => {
        frames.set(++nextFrame, callback);
        return nextFrame;
    },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
};
const descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
Object.defineProperties(browser, {
    requestAnimationFrame: { value: globals.requestAnimationFrame, configurable: true, writable: true },
    cancelAnimationFrame: { value: globals.cancelAnimationFrame, configurable: true, writable: true },
});

// Browser flags are captured on import, so install the iOS predicate first.
const { EditorView } = await import('@codemirror/view');
const { EditorState } = await import('@codemirror/state');
const { ComposerEditor } = await import('../ComposerEditor');
const { ComposerEditorView } = await import('../ComposerEditorView');
const { createComposerEditorViewStore } = await import('../viewStore');
const { useComposerDraft } = await import('../../state/useComposerDraft');
const { readChatDraft, writeChatDraft } = await import('@/lib/chatDraftPersistence');
const { getDeferredSafeStorage } = await import('@/stores/utils/safeStorage');
const { useInputStore } = await import('@/sync/input-store');

const languageContext: ComposerLanguageContext = {
    inputMode: 'normal', knownAgentNames: new Set(), confirmedMentions: new Set(),
    knownSlashNames: new Set(), knownSnippetTriggers: new Set(), attachmentFilenames: [],
};

function deliverMutations() {
    for (const observer of observers) observer.flushRecords();
}

function nextAnimationFrame() {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(0);
}

function nativeParagraph(content: HTMLElement) {
    const paragraph = document.createElement('div');
    paragraph.appendChild(document.createElement('br'));
    content.appendChild(paragraph);
    deliverMutations();
    return paragraph;
}

function nativeText(paragraph: HTMLElement, text: string) {
    paragraph.textContent = text;
    const selection = document.getSelection();
    selection?.collapse(paragraph.firstChild, text.length);
    deliverMutations();
}

describe('iOS composer native paragraph batches', () => {
    let view: InstanceType<typeof ComposerEditorView>;
    let edits: string[];

    beforeEach(() => {
        edits = [];
        view = new ComposerEditorView({
            parent: document.body,
            state: EditorState.create({ doc: 'old draft', extensions: [EditorView.updateListener.of((update) => {
                if (update.docChanged) edits.push(update.state.doc.toString());
            })] }),
        });
    });

    afterEach(() => { view.destroy(); frames.clear(); });

    test('keeps native line nodes until every batch reaches the document exactly once', () => {
        // The IME deletes its old dictation, then commits independent text and
        // paragraph batches while retaining references to native DIV nodes.
        for (let length = 'old draft'.length - 1; length >= 0; length--) {
            view.contentDOM.firstChild!.textContent = 'old draft'.slice(0, length);
            deliverMutations();
        }
        expect(view.state.doc.length).toBe(0);
        edits.length = 0;
        view.contentDOM.firstChild!.textContent = '整理后的第一段';
        deliverMutations();
        expect(view.state.doc.toString()).toBe('整理后的第一段');

        const second = nativeParagraph(view.contentDOM);
        expect(second.isConnected).toBe(true);
        nativeText(second, '第二段');
        nativeParagraph(view.contentDOM);
        const third = nativeParagraph(view.contentDOM);
        nativeText(third, '第三段');
        nativeText(third, '第三段的后续文字');
        expect(view.state.doc.toString()).toBe('整理后的第一段');
        expect(second.isConnected).toBe(true);
        expect(third.isConnected).toBe(true);

        nextAnimationFrame();
        const expected = '整理后的第一段\n第二段\n\n第三段的后续文字';
        expect(view.state.doc.toString()).toBe(expected);
        expect(view.contentDOM.textContent).toBe(expected.replaceAll('\n', ''));
        expect(edits).toEqual(['整理后的第一段', expected]);
        nextAnimationFrame();
        deliverMutations();
        expect(view.state.doc.toString()).toBe(expected);
        expect(edits).toHaveLength(2);
    });

    test('generic editors retain immediate iOS paragraph reconciliation', () => {
        const generic = new EditorView({ parent: document.body, doc: 'first' });
        try {
            nativeParagraph(generic.contentDOM);
            expect(generic.state.doc.toString()).toBe('first\n');
        } finally { generic.destroy(); }
    });

    test('retains the upstream composition deletion delay', () => {
        view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        view.contentDOM.firstChild!.textContent = '候选';
        deliverMutations();
        expect(view.composing).toBe(true);
        expect(view.state.doc.toString()).toBe('候选');
        view.contentDOM.firstChild!.textContent = '';
        deliverMutations();
        view.flushPendingIOSParagraph();
        expect(view.state.doc.toString()).toBe('候选');
        view.contentDOM.firstChild!.textContent = '已提交';
        deliverMutations();
        nextAnimationFrame();
        expect(view.state.doc.toString()).toBe('已提交');
    });

    test('destroy reports the final batch before canceling its frame', () => {
        const paragraph = nativeParagraph(view.contentDOM);
        nativeText(paragraph, 'last batch');
        view.destroy();
        expect(edits).toEqual(['old draft\nlast batch']);
        nextAnimationFrame();
        expect(edits).toHaveLength(1);
    });

    test('does not force an upstream delay after compositionend with queued paragraphs', () => {
        const generic = new EditorView({ parent: document.body, doc: 'old draft' });
        const finishComposition = (target: InstanceType<typeof EditorView>) => {
            target.contentDOM.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
            target.contentDOM.firstChild!.textContent = '候选';
            deliverMutations();
            target.contentDOM.firstChild!.textContent = '';
            const paragraph = nativeParagraph(target.contentDOM);
            target.contentDOM.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
            expect(target.compositionStarted).toBe(false);
            target.flushPendingIOSParagraph();
            expect(target.state.doc.toString()).toBe('候选');
            nativeText(paragraph, '已提交');
            nextAnimationFrame();
            return target.state.doc.toString();
        };
        try {
            // Upstream normalizes the cleared composition line away. Both
            // views must keep the deletion pending and deliver the same text.
            expect(finishComposition(view)).toBe(finishComposition(generic));
            expect(view.state.doc.toString()).toBe('已提交');
        } finally { generic.destroy(); }
    });

    test('a focus notification waits for the native paragraph frame and is still delivered', async () => {
        const focusEvents: boolean[] = [];
        const focused = new ComposerEditorView({
            parent: document.body,
            doc: 'first',
            extensions: [EditorView.updateListener.of((update) => {
                if (update.focusChanged) focusEvents.push(update.view.hasFocus);
            })],
        });
        try {
            focused.contentDOM.focus();
            expect(focused.hasFocus).toBe(true);
            const paragraph = nativeParagraph(focused.contentDOM);
            nativeText(paragraph, 'last batch');
            // Frames stay held while CodeMirror's real 10 ms focus timer runs.
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
            expect(focused.state.doc.toString()).toBe('first');
            expect(paragraph.isConnected).toBe(true);
            expect(focusEvents).toEqual([]);
            nativeText(paragraph, 'last batch completed');
            nextAnimationFrame();
            expect(focused.state.doc.toString()).toBe('first\nlast batch completed');
            expect(focusEvents).toEqual([true]);
            focused.contentDOM.blur();
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
            expect(focused.hasFocus).toBe(false);
            expect(focusEvents).toEqual([true, false]);
        } finally { focused.destroy(); }
    });
});

describe('non-iOS composer observers', () => {
    for (const platform of ['desktop', 'android']) {
        test(`${platform} retains immediate paragraph reconciliation with the opt-in`, () => {
            // Browser flags are module constants. A separate process tests the
            // installed package with each navigator, without changing its code.
            const result = spawnSync(process.execPath, ['--eval', `
                import { Window } from 'happy-dom';
                import assert from 'node:assert/strict';
                const browser = new Window();
                const observers = [];
                class ManualObserver extends browser.MutationObserver {
                    constructor(callback) { super(callback); this.callback = callback; observers.push(this); }
                }
                Object.assign(globalThis, {
                    window: browser, document: browser.document,
                    MutationObserver: ManualObserver, getComputedStyle: browser.getComputedStyle.bind(browser),
                });
                Object.defineProperty(globalThis, 'navigator', { value: {
                    userAgent: ${JSON.stringify(platform === 'android' ? 'Mozilla/5.0 (Linux; Android 14) Chrome/130.0' : 'Mozilla/5.0 Chrome/130.0')},
                    vendor: 'Google Inc.', platform: 'Linux', maxTouchPoints: 5,
                }, configurable: true });
                const { ComposerEditorView } = await import('../ComposerEditorView');
                const view = new ComposerEditorView({ parent: document.body, doc: 'first' });
                try {
                    const paragraph = document.createElement('div');
                    paragraph.appendChild(document.createElement('br'));
                    view.contentDOM.appendChild(paragraph);
                    for (const observer of observers) {
                        const records = observer.takeRecords();
                        if (records.length) observer.callback(records, observer);
                    }
                    assert.equal(view.state.doc.toString(), 'first\\n');
                    view.flushPendingIOSParagraph();
                    assert.equal(view.state.doc.toString(), 'first\\n');
                } finally { view.destroy(); browser.close(); }
            `], { cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' });
            expect(result.stderr).toBe('');
            expect(result.status).toBe(0);
        });
    }
});

describe('composer reads before the deferred frame', () => {
    let root: Root;
    const editor = React.createRef<ComposerEditorHandle>();
    let latest: string;
    let blurredValue: string | undefined;
    let view: NonNullable<ReturnType<typeof createComposerEditorViewStore>['view']>;

    beforeEach(async () => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        const store = createComposerEditorViewStore();
        latest = 'first';
        blurredValue = undefined;
        await act(async () => root.render(<ComposerEditor ref={editor} value={latest}
            viewStore={store} languageContext={languageContext}
            onChange={(change) => { latest = change.value; }}
            onBlur={() => { blurredValue = latest; }} />));
        if (!store.view) throw new Error('Composer view missing');
        view = store.view;
        const paragraph = nativeParagraph(view.contentDOM);
        nativeText(paragraph, 'last batch');
        expect(view.state.doc.toString()).toBe('first');
    });

    afterEach(async () => { await act(async () => root.unmount()); view.destroy(); frames.clear(); });

    test('getValue returns the complete immediate send snapshot', () => {
        expect(editor.current?.getValue()).toBe('first\nlast batch');
        expect(latest).toBe('first\nlast batch');
        nextAnimationFrame();
        expect(editor.current?.getValue()).toBe('first\nlast batch');
    });

    test('native blur reports the complete text before the caller stashes a draft', async () => {
        await act(async () => {
            view.contentDOM.focus();
            view.contentDOM.blur();
        });
        expect(latest).toBe('first\nlast batch');
        expect(blurredValue).toBe('first\nlast batch');
    });

    test('detach reports pending input before callbacks can belong to another mount', async () => {
        await act(async () => root.unmount());
        expect(latest).toBe('first\nlast batch');
        expect(view.state.doc.toString()).toBe('first\nlast batch');
    });
});

describe('native input at draft boundaries', () => {
    const source: ChatDraftIdentity = { runtimeKey: 'dictation-test', directory: '/repo', sessionId: 'A' };
    const destination: ChatDraftIdentity = { ...source, sessionId: 'B' };
    const expected = 'A start\n尾批文字';
    let root: Root;
    let host: HTMLDivElement;
    let view: InstanceType<typeof ComposerEditorView>;
    let changes: { owner: string | null; value: string }[];
    let clearDraft: () => void;
    let render: (identity: ChatDraftIdentity) => Promise<void>;
    const editor = React.createRef<ComposerEditorHandle>();

    beforeEach(async () => {
        getDeferredSafeStorage().removeItem('openchamber.chatDrafts.v2');
        useInputStore.setState({ pendingComposerRestore: null, attachmentDraftKey: null, attachmentDrafts: new Map() });
        writeChatDraft(destination, 'B untouched', []);
        const store = createComposerEditorViewStore();
        changes = [];
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
        function Probe({ identity }: { identity: ChatDraftIdentity }) {
            const [message, setMessage] = React.useState('A start');
            const messageRef = React.useRef(message);
            const confirmedMentionsRef = React.useRef(new Set<string>());
            const draftLanguageContext = React.useMemo(() => ({
                ...languageContext, attachmentFilenames: identity.sessionId === 'B' ? ['b.txt'] : [],
            }), [identity]);
            React.useEffect(() => { messageRef.current = message; }, [message]);
            useComposerDraft({
                message, messageRef, setMessage, confirmedMentionsRef, identity,
                initialDraft: { text: '', identity: source },
                capturePendingInput: () => store.view?.capturePendingInput(),
            });
            clearDraft = () => { messageRef.current = ''; setMessage(''); };
            return <ComposerEditor ref={editor} value={message} viewStore={store}
                languageContext={draftLanguageContext} onChange={(change) => {
                    changes.push({ owner: identity.sessionId, value: change.value });
                    // ChatInput updates the draft ref in the native callback,
                    // before a same-tick persistence event can read it.
                    messageRef.current = change.value;
                    setMessage(change.value);
                }} />;
        }
        render = (identity) => act(async () => root.render(<Probe identity={identity} />));
        await render(source);
        if (!store.view) throw new Error('Composer view missing');
        view = store.view;
        const paragraph = nativeParagraph(view.contentDOM);
        nativeText(paragraph, '尾批文字');
        expect(view.state.doc.toString()).toBe('A start');
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        view.destroy();
        host.remove();
        frames.clear();
    });

    test('pagehide persists the pending batch without waiting for a frame or an onChange', async () => {
        await act(async () => { window.dispatchEvent(new Event('pagehide')); });
        expect(readChatDraft(source).text).toBe(expected);
        expect(view.state.doc.toString()).toBe(expected);
        expect(changes).toEqual([]);
        await act(async () => { nextAnimationFrame(); });
        expect(changes).toEqual([]);
    });

    test('a mounted A to B to A switch keeps the outgoing batch and its callback ownership', async () => {
        await render(destination);
        await act(async () => { nextAnimationFrame(); });
        expect(readChatDraft(source).text).toBe(expected);
        expect(view.state.doc.toString()).toBe('B untouched');
        expect(changes.some((change) => change.owner === 'B' && change.value === expected)).toBe(false);
        await render(source);
        expect(view.state.doc.toString()).toBe(expected);
        expect(readChatDraft(destination).text).toBe('B untouched');
    });

    test('a send snapshot followed by an app clear cannot resurrect the old editor document', async () => {
        await act(async () => {
            expect(editor.current?.getValue()).toBe(expected);
            clearDraft();
            window.dispatchEvent(new Event('pagehide'));
        });
        expect(readChatDraft(source).text).toBe('');
        await act(async () => { nextAnimationFrame(); });
        expect(editor.current?.getValue()).toBe('');
        expect(readChatDraft(source).text).toBe('');
    });
});

afterAll(() => {
    browser.close();
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
});
