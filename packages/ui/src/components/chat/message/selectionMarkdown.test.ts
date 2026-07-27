import { describe, expect, test } from 'bun:test';

import {
  formatCodeSelectionMarkdown,
  selectionNodesToMarkdown,
  trimSelectionValue,
  wrapMarkdownSelectionForChat,
} from './selectionMarkdown';

type TestNode =
  | { type: 'text'; value: string }
  | {
      type: 'element';
      tag: string;
      className: string;
      href: string;
      component: string;
      isCodeLines: boolean;
      isCodeLineNumber: boolean;
      children: TestNode[];
    };

const text = (value: string): TestNode => ({ type: 'text', value });
const element = (
  tag: string,
  children: TestNode[],
  options: Partial<Omit<Extract<TestNode, { type: 'element' }>, 'type' | 'tag' | 'children'>> = {},
): TestNode => ({
  type: 'element',
  tag,
  className: '',
  href: '',
  component: '',
  isCodeLines: false,
  isCodeLineNumber: false,
  children,
  ...options,
});

const codeLine = (number: number, content: string): TestNode => element('span', [
  element('span', [text(String(number))], { isCodeLineNumber: true }),
  element('span', [text(content)]),
]);

const codeWrapper = (lines: string[], language = 'ts'): TestNode => element('div', [
  element('div', [text(language)]),
  element('div', [
    element('pre', [
      element('code', lines.flatMap((line, index) => [
        codeLine(index + 12, line),
        ...(index < lines.length - 1 ? [element('span', [text('\n')])] : []),
      ]), { className: `language-${language}`, isCodeLines: true }),
    ]),
  ]),
], { component: 'markdown-code' });

describe('selectionNodesToMarkdown', () => {
  test('serializes a complete grid code block without its header or line numbers', () => {
    expect(selectionNodesToMarkdown([codeWrapper(['range.cloneContents()', 'next()'])], '')).toBe(
      '```ts\nrange.cloneContents()\nnext()\n```',
    );
  });

  test('preserves a partial code block selected after prose', () => {
    const nodes = [
      element('p', [
        text('原生'),
        element('code', [text('Selection.toString()')]),
        text('通常不会包含行号，但 Add to Chat 不直接使用它。'),
      ]),
      element('p', [text('它还会执行：')]),
      codeWrapper(['range.cloneContents()']),
    ];

    expect(selectionNodesToMarkdown(nodes, '')).toBe(
      '原生`Selection.toString()`通常不会包含行号，但 Add to Chat 不直接使用它。\n\n它还会执行：\n\n```ts\nrange.cloneContents()\n```',
    );
  });

  test('preserves a partial code block selected before prose', () => {
    expect(selectionNodesToMarkdown([
      codeWrapper(['range.cloneContents()']),
      element('p', [text('后续说明')]),
    ], '')).toBe('```ts\nrange.cloneContents()\n```\n\n后续说明');
  });
});

describe('formatCodeSelectionMarkdown', () => {
  test('preserves indentation and blank lines', () => {
    expect(formatCodeSelectionMarkdown('if (ready) {\n  run();\n\n  stop();\n}', 'ts')).toBe(
      '```ts\nif (ready) {\n  run();\n\n  stop();\n}\n```',
    );
  });

  test('normalizes line endings without duplicating a trailing newline', () => {
    expect(formatCodeSelectionMarkdown('first\r\nsecond\r\n', 'text')).toBe(
      '```text\nfirst\nsecond\n```',
    );
  });

  test('uses a longer fence when selected code contains backtick fences', () => {
    expect(formatCodeSelectionMarkdown('before\n```\nafter', 'md')).toBe(
      '````md\nbefore\n```\nafter\n````',
    );
  });

  test('preserves punctuation in language identifiers', () => {
    expect(selectionNodesToMarkdown([codeWrapper(['std::vector<int> values;'], 'c++')], '')).toBe(
      '```c++\nstd::vector<int> values;\n```',
    );
  });
});

describe('trimSelectionValue', () => {
  test('normalizes line endings before trimming the selection', () => {
    expect(trimSelectionValue('  first\r\nsecond  ')).toBe('first\nsecond');
  });
});

describe('wrapMarkdownSelectionForChat', () => {
  test('uses a longer outer fence when the selection contains fenced code', () => {
    expect(wrapMarkdownSelectionForChat('```ts\nrun();\n```')).toBe(
      '````md\n```ts\nrun();\n```\n````',
    );
  });
});
