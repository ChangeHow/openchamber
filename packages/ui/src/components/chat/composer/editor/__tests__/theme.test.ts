import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';

import {
    COMPOSER_EDITOR_THEME_SPEC,
    NATIVE_SELECTION_THEME_SPEC,
    composerEditorTheme,
    composerNativeSelectionExtension,
    isIOSNavigator,
} from '../theme';

const selectors = Object.keys(COMPOSER_EDITOR_THEME_SPEC);
const declarations = JSON.stringify(COMPOSER_EDITOR_THEME_SPEC);

describe('composerEditorTheme', () => {
    /**
     * EditorView.theme compiles its selectors when this module is imported and
     * throws RangeError on a scope it was not given — `&light` and `&dark`
     * among them, despite both appearing throughout CodeMirror's own base
     * theme. A build and a type-check both pass happily on that mistake; it
     * surfaces only in the running app, where it takes the composer down.
     */
    test('its selectors compile and the theme can be installed', () => {
        let failure: unknown = null;
        try {
            EditorState.create({ extensions: [composerEditorTheme] });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeNull();
    });

    /**
     * The composer runs `drawSelection()`, which hides the native caret with
     * `caret-color: transparent !important` and draws a `.cm-cursor` element
     * instead. Styling `caret-color` looks correct and does nothing, leaving
     * CodeMirror's hard-coded black cursor on dark themes.
     */
    test('the caret is coloured where it is drawn, not on the native caret', () => {
        expect(selectors.some((selector) => selector.includes('.cm-cursor'))).toBe(true);
        expect(declarations.includes('caretColor')).toBe(false);
    });

    test('the drawn caret follows the theme rather than a fixed colour', () => {
        const cursorRule = selectors.find((selector) => selector.includes('.cm-cursor'));
        const rule = (COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>)[cursorRule!];
        expect(rule.borderLeftColor.startsWith('var(--')).toBe(true);
    });

    test('the drawn caret is wide enough to remain prominent', () => {
        const cursorRule = selectors.find((selector) => selector.includes('.cm-cursor'));
        const rule = (COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>)[cursorRule!];
        expect(rule.borderLeftWidth).toBe('2px');
        expect(rule.transform).toBe('scaleY(1.15)');
        expect(rule.transformOrigin).toBe('center');
    });

    /**
     * CodeMirror's own `.cm-cursor` rule and its `&dark` override are one and
     * two classes deep respectively; a bare `.cm-cursor` selector loses to the
     * latter. `&.cm-editor` matches it.
     */
    test('the caret rule is specific enough to beat the base theme', () => {
        const cursorRule = selectors.find((selector) => selector.includes('.cm-cursor'));
        expect(cursorRule!.startsWith('&.cm-editor')).toBe(true);
    });

    /**
     * Same trap as the caret, one layer over: `drawSelection()` paints its own
     * selection and CodeMirror styles the focused case through a six-class
     * selector. A shorter rule silently loses and the selection renders in
     * CodeMirror's stock lavender, which buries the token colours.
     */
    test('the focused selection is styled at the depth CodeMirror uses', () => {
        const focusedRule = selectors.find((selector) =>
            selector.includes('.cm-focused') && selector.includes('.cm-selectionBackground'));
        expect(focusedRule).toBeDefined();
        expect(focusedRule!.includes('.cm-scroller')).toBe(true);
        expect(focusedRule!.includes('.cm-selectionLayer')).toBe(true);
    });

    /**
     * An unknown custom property makes the whole declaration invalid rather
     * than falling back to something visible, so a misspelled token reads as
     * "this element was never styled". `color` inherits, which is how a
     * camelCased `--surface-mutedForeground` left the placeholder at full text
     * brightness while looking perfectly correct in the source.
     */
    test('every theme token is kebab-case, as the theme emits them', () => {
        const tokens = [...declarations.matchAll(/var\((--[A-Za-z-]+)/g)].map((m) => m[1]);
        expect(tokens.length > 0).toBe(true);
        expect(tokens.filter((token) => /[A-Z]/.test(token))).toEqual([]);
    });

    test('the selection is translucent so token colours survive it', () => {
        const rules = selectors
            .filter((selector) => selector.includes('.cm-selectionBackground'))
            .map((selector) =>
                (COMPOSER_EDITOR_THEME_SPEC as Record<string, Record<string, string>>)[selector]);
        expect(rules.length > 0).toBe(true);
        for (const rule of rules) {
            expect(rule.background.includes('transparent')).toBe(true);
        }
    });
});

describe('composerNativeSelectionTheme', () => {
    const nativeSelectors = Object.keys(NATIVE_SELECTION_THEME_SPEC);
    const nativeDeclarations = JSON.stringify(NATIVE_SELECTION_THEME_SPEC);

    /**
     * Non-iOS devices layer this over `drawSelection()` so the native selection
     * paints over token backgrounds. iOS instead uses the handles drawn by
     * CodeMirror 6.39.17 and skips this workaround entirely.
     */
    test('it compiles and can be installed', () => {
        let failure: unknown = null;
        try {
            EditorState.create({ extensions: [composerNativeSelectionExtension] });
        } catch (error) {
            failure = error;
        }
        expect(failure).toBeNull();
    });

    test('iOS uses CodeMirror selection handles instead of the native workaround', () => {
        expect(isIOSNavigator(
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Mobile/15E148 Safari/604.1',
            'iPhone',
            5,
        )).toBe(true);
        expect(isIOSNavigator(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
            'MacIntel',
            5,
        )).toBe(true);
    });

    test('non-iOS platforms keep the native selection workaround', () => {
        expect(isIOSNavigator(
            'Mozilla/5.0 (Linux; Android 15)',
            'Linux armv8l',
            5,
        )).toBe(false);
        expect(isIOSNavigator(
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)',
            'MacIntel',
            0,
        )).toBe(false);
    });

    /**
     * `drawSelection()` hides the native selection through a `Prec.highest`
     * theme with `!important` on `.cm-line ::selection`. Winning that back
     * needs both `!important` and strictly more specificity, because the
     * mount order of two highest-precedence themes is not something to bet
     * on.
     */
    test('the native selection is re-shown with enough weight to win', () => {
        const rule = nativeSelectors.find((selector) => selector.includes('::selection'));
        expect(rule).toBeDefined();
        expect(rule!.includes('.cm-content')).toBe(true);
        expect(rule!.includes('.cm-line')).toBe(true);
        const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[rule!];
        expect(value.backgroundColor.includes('!important')).toBe(true);
        expect(value.backgroundColor.includes('transparent')).toBe(true);
    });

    test('the painted selection layer is hidden so highlights do not stack', () => {
        const rule = nativeSelectors.find((selector) => selector.includes('.cm-selectionLayer'));
        expect(rule).toBeDefined();
        const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[rule!];
        expect(value.display).toBe('none');
    });

    /**
     * Native selection handles may take their colour from the caret. With
     * `drawSelection()`'s `caret-color: transparent !important` in effect the
     * handles can be drawn invisibly. The native caret therefore comes back
     * only for a range, and the drawn cursor layer goes away at the same time.
     */
    test('the native caret is re-enabled, since the handles take its colour', () => {
        const rule = nativeSelectors.find((selector) =>
            selector.includes('.cm-content')
            && (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[selector].caretColor);
        expect(rule).toBeDefined();
        const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[rule!];
        expect(value.caretColor.startsWith('var(--')).toBe(true);
        expect(value.caretColor.includes('!important')).toBe(true);
        expect(rule!.includes('&.cm-editor')).toBe(true);
    });

    test('the native caret shows only while a range is selected', () => {
        for (const selector of nativeSelectors) {
            const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[selector];
            if (value.caretColor) {
                expect(selector.includes('.oc-native-range')).toBe(true);
            }
        }
    });

    test('the drawn cursor layer is hidden so there are not two carets', () => {
        const rule = nativeSelectors.find((selector) => selector.includes('.cm-cursorLayer'));
        expect(rule).toBeDefined();
        expect(rule!.includes('.oc-native-range')).toBe(true);
        const value = (NATIVE_SELECTION_THEME_SPEC as Record<string, Record<string, string>>)[rule!];
        expect(value.display).toBe('none');
    });

    test('every theme token is kebab-case, as the theme emits them', () => {
        const tokens = [...nativeDeclarations.matchAll(/var\((--[A-Za-z-]+)/g)].map((m) => m[1]);
        expect(tokens.length > 0).toBe(true);
        expect(tokens.filter((token) => /[A-Z]/.test(token))).toEqual([]);
    });
});
