import { describe, expect, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Streamdown } from 'streamdown';
import { formatSelectedConversationMarkdown, type SelectedConversationMessage } from './selectionMarkdown';

const labels = { user: '用户', assistant: '助手', attachment: '附件' };
const message = (segments: readonly string[], role: 'user' | 'assistant' = 'assistant'): SelectedConversationMessage => ({ key: 'same-key', role, segments });
const format = (...messages: SelectedConversationMessage[]) => formatSelectedConversationMarkdown(messages, labels);
const render = (source: string) => renderToStaticMarkup(React.createElement(Streamdown, {
    mode: 'static', children: source,
    components: { a: ({ href, children }) => React.createElement('a', { href }, children) },
}));

describe('selected conversation Markdown', () => {
    test('preserves raw block structure and localized roles in selection order', () => {
        const source = '# Heading\n\n- first\n- second\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n> quote\n\n[link](https://example.com)\n\n```ts\nconst a = 1;\n```';
        expect(format(message([source], 'user'), message(['answer']))).toBe(`**用户**\n\n${source}\n\n---\n\n**助手**\n\nanswer`);
        expect(format()).toBe('');
    });
    test('preserves initial indentation, blank lines, Unicode and segments', () => {
        const source = '    const value = "用户";\n\n    [ref]\n';
        expect(format(message([source, '尾段']))).toBe(`**助手**\n\n${source}\n\n尾段`);
    });
    test('isolates full, collapsed, shortcut and image references across segments', () => {
        const result = format(message(['[text][Docs] [Docs][] [Docs] ![image][Docs]', '[Docs]: https://one.example/docs "First"']), message(['[text][Docs] [Docs][] [Docs]\n\n[Docs]: https://two.example/docs "Second"']));
        expect(result).toContain('[text][oc-1-docs] [Docs][oc-1-docs] [Docs][oc-1-docs] ![image][oc-1-docs]');
        expect(result).toContain('[oc-1-docs]: https://one.example/docs "First"');
        expect(result).toContain('[oc-2-docs]: https://two.example/docs "Second"');
        expect(render(result)).toContain('href="https://one.example/docs"');
        expect(render(result)).toContain('href="https://two.example/docs"');
    });
    test('preserves nested reference images and multiline quote prefixes', () => {
        const source = '[![image][img]][page]\n\n> [a\n> b][page]\n\n[img]: https://example.com/image\n[page]: https://example.com/page';
        const result = format(message([source]));
        expect(result).toContain('[![image][oc-1-img]][oc-1-page]');
        expect(result).toContain('> [a\n> b][oc-1-page]');
        expect(render(result)).toContain('src="https://example.com/image"');
    });
    test('keeps reference labels with entities and escapes linked after joining', () => {
        for (const [reference, definition] of [
            ['A&amp;B', '[A&amp;B]: https://example.com/docs'],
            ['a\\*b', '[a\\*b]: https://example.com/docs'],
            ['a b', '> [a\n> b]: https://example.com/docs'],
        ]) {
            const source = `[x][${reference}]\n\n${definition}`;
            expect(render(format(message([source]), message([source])))).toContain('href="https://example.com/docs"');
        }
    });
    test('unresolved references cannot bind to another message', () => {
        const result = format(message(['Use [missing] literally.']), message(['[missing]: https://example.com']));
        expect(render(result)).toContain('Use [missing] literally.');
        expect(render(result)).not.toContain('href="https://example.com"');
    });
    test('isolates footnotes, undefined footnotes and multiline definitions', () => {
        const source = 'Text[^n] and [^missing].\n\n[^n]: First line\n    continuation';
        const result = format(message([source]), message([source]));
        expect(result).toContain('Text[^oc-1-n] and \\[^missing].');
        expect(result).toContain('[^oc-1-n]: First line\n    continuation');
        expect(result).toContain('[^oc-2-n]: First line');
        const unresolved = format(message(['Text[^missing].']), message(['[^missing]: Other message note']));
        expect(unresolved).toContain('Text\\[^missing].');
        expect(render(unresolved)).toContain('Text[^missing].');
    });
    test('leaves fenced, inline and indented code unchanged', () => {
        const code = '````md\n[x] [^n]\n```\n````\n\n~~~md\n[x] [^n]\n~~~\n\n    [x] [^n]\n\n`[x] [^n]` and `` `[x]` [^n] ``';
        const result = format(message([code, '[x] [^n]\n\n[x]: https://example.com\n[^n]: note']));
        expect(result).toContain(code);
        expect(result).toContain('[x][oc-1-x] [^oc-1-n]');
    });
    test('preserves CRLF and tab-indented code inside lists', () => {
        const source = '- item\r\n\r\n\t\t[^n]\r\n\r\n[^n]: note';
        const result = format(message([source]));
        expect(result).toContain('- item\r\n\r\n\t\t[^n]');
        expect(result).toContain('[^oc-1-n]: note');
    });
    test('preserves code containing escaped table pipes', () => {
        const source = '| x |\n| - |\n| `a \\| [^n]` |\n\n[^n]: note';
        expect(format(message([source]))).toContain('| `a \\| [^n]` |');
    });
    test('handles nested lists, blockquotes and tables', () => {
        const source = '> - ~~~~md\n>   [x] [^n]\n>   ~~~~\n>\n> [x] [^n]\n\n- outer\n  - inner\n\n        [x] [^n]\n\n| code | prose |\n| --- | --- |\n| `[x] [^n]` | [x] |\n\n[x]: https://example.com\n[^n]: note';
        const result = format(message([source]));
        expect(result).toContain('>   [x] [^n]\n>   ~~~~');
        expect(result).toContain('        [x] [^n]');
        expect(result).toContain('| `[x] [^n]` | [x][oc-1-x] |');
        expect(result).toContain('> [x][oc-1-x] [^oc-1-n]');
    });
    test('preserves closed fences with equivalent quote and list indentation', () => {
        for (const source of ['> ```\n> code\n>```\n> after', '- item\n\n  ```\n  code\n\t```\n\n  after']) {
            expect(format(message([source]))).toBe(`**助手**\n\n${source}`);
        }
        expect(render(format(message(['```\n> ```', '# next'])))).toContain('data-streamdown="heading-1"');
    });
    for (const opening of ['```ts', '~~~~~js', '> ```ts', '- ```ts', '> - ~~~~js']) test(`closes unfinished ${opening} before later segments`, () => {
        const prefix = opening.startsWith('> -') ? '>   ' : opening.startsWith('>') ? '> ' : opening.startsWith('-') ? '  ' : '';
        const fence = opening === '~~~~~js' ? '~~~~~' : opening.includes('~') ? '~~~~' : '```';
        const result = format(message([`${opening}\n${prefix}const value = 1;`, '# next']), message(['final']));
        expect(result).toContain(`const value = 1;\n${prefix}${fence}\n\n\n# next`);
        expect(render(result)).toContain('data-streamdown="heading-1"');
        expect(render(result)).toContain('>final</p>');
    });
    test('preserves escaped syntax and inline destinations/titles', () => {
        const source = '\\[x] \\[^n] [label](https://example.com/[x] "[^n]")\n\n[x]: https://example.com "[x] [^n]"';
        const result = format(message([source]));
        expect(result).toContain('\\[x] \\[^n] [label](https://example.com/[x] "[^n]")');
        expect(result).toContain('[oc-1-x]: https://example.com "[x] [^n]"');
    });
    test('links public/data attachments and escapes filenames', () => {
        const result = format({ ...message([]), attachments: [{ name: 'a [b]*.png', url: 'https://example.com/image.png' }, { name: 'data.png', url: 'data:image/png;base64,AAAA' }] });
        expect(result).toContain('[a \\[b\\]\\*.png](<https://example.com/image.png>)');
        expect(result).toContain('[data.png](<data:image/png;base64,AAAA>)');
    });
    for (const url of ['blob:https://example.com/id', 'file:///private/image.png', '/api/fs/raw?token=secret', 'https://example.com/api/fs/raw', 'https://example.com/image?token=secret', 'https://user:secret@example.com/image', 'http://localhost/image', 'http://127.0.0.1/image', 'http://10.0.0.1/image', 'http://172.16.0.1/image', 'http://192.168.1.1/image', 'http://169.254.169.254/image', 'http://[::1]/image', 'http://[::ffff:127.0.0.1]/image', 'https://machine.internal/image', 'https://example.com/image#secret']) test(`omits inaccessible URL ${url}`, () => {
        expect(format({ ...message([]), attachments: [{ name: 'image.png', url }] })).toBe('**助手**\n\n附件: image.png');
    });
});
