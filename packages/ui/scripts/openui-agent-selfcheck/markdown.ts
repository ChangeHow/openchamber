import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Code, Nodes } from 'mdast';
import { createHash } from 'node:crypto';
import { blockNode, blockProps, parseUiBlock, type BlockValue } from '../../src/components/chat/uiBlocks/catalog';

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

function codeNodes(node: Nodes): Code[] {
  if (node.type === 'code') return [node];
  return 'children' in node ? node.children.flatMap(codeNodes) : [];
}

function checkCode(markdown: string, node: Code) {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  const fragment = start === undefined || end === undefined ? '' : markdown.slice(start, end);
  const lines = fragment.split(/\r?\n/);
  const opening = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(lines[0] ?? '');
  const errors: string[] = [];
  if (!opening) errors.push('Use a Markdown code fence around the complete program');
  if (node.lang !== 'openui-lang' || node.meta || opening?.[2].trim() !== 'openui-lang') {
    errors.push('The opening fence language must be exactly openui-lang');
  }
  if (opening) {
    const close = new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ \\t]*$`);
    if (lines.length < 3 || !close.test(lines.at(-1) ?? '')) errors.push('The Markdown code fence is not closed');
  }
  const parsed = parseUiBlock(node.value, true);
  if (parsed.kind !== 'ready') errors.push(...(parsed.kind === 'invalid' ? parsed.errors : ['The program has no Stack root']));
  if (parsed.kind === 'ready') {
    tablesIn(parsed.root).forEach((table, tableIndex) => table.rows.forEach((row, rowIndex) => {
      if (row.length !== table.columns.length) errors.push(
        `Table ${tableIndex + 1} row ${rowIndex + 1} has ${row.length} cells; expected ${table.columns.length} columns. Check the row values and string quoting; preserve all intended data.`,
      );
    }));
  }
  return { ok: errors.length === 0, errors, fragment, fragmentSha256: sha256(fragment),
    root: parsed.kind === 'ready' ? parsed.root : null };
}

/** Checks the whole candidate envelope. It never adds a fence or rewrites DSL. */
export function validateCandidate(markdown: string) {
  const tree = fromMarkdown(markdown);
  if (tree.children.length !== 1 || tree.children[0].type !== 'code') {
    return { ok: false, errors: ['The candidate must contain exactly one complete fenced openui-lang block, without surrounding prose'],
      fileSha256: sha256(markdown), fragment: null, fragmentSha256: null, root: null };
  }
  return { ...checkCode(markdown, tree.children[0]), fileSha256: sha256(markdown) };
}

/** Independently finds the final answer's real Markdown code nodes and checks each envelope. */
export function inspectFinal(markdown: string, lastSuccessfulFragment?: string) {
  const tree = fromMarkdown(markdown);
  const nodes = codeNodes(tree);
  const ui = nodes.filter(node => node.lang === 'openui-lang' || node.lang === 'openui' || /^\s*root\s*=/m.test(node.value));
  const fragments = ui.map(node => checkCode(markdown, node));
  const alternateUi = (node: Nodes): boolean => node.type === 'html'
    ? (node.position?.start.column ?? 1) <= 4 && /^ {0,3}<openui-lang>/m.test(node.value)
    : 'children' in node && node.children.some(alternateUi);
  const hasAlternateUiEnvelope = alternateUi(tree);
  const outside = (node: Nodes): string => node.type === 'code' ? '' : node.type === 'text' ? node.value
    : 'children' in node ? node.children.map(outside).join('\n') : '';
  const bareProgram = /^\s*root\s*=/m.test(outside(tree));
  return { formatAndDslPass: fragments.length > 0 && !bareProgram && !hasAlternateUiEnvelope && fragments.every(fragment => fragment.ok),
    bareProgram, hasAlternateUiEnvelope, fragments,
    matchesLastSuccessfulCandidate: lastSuccessfulFragment !== undefined && !bareProgram && !hasAlternateUiEnvelope && fragments.length === 1
      && fragments[0].fragment === lastSuccessfulFragment };
}

export function tablesIn(value: BlockValue | null): { columns: string[]; rows: BlockValue[][] }[] {
  if (Array.isArray(value)) return value.flatMap(tablesIn);
  const node = blockNode.safeParse(value);
  if (!node.success) return [];
  const table = node.data.typeName === 'Table' ? blockProps.Table.safeParse(node.data.props) : null;
  const tables = table?.success ? [table.data] : [];
  return [...tables, ...Object.values(node.data.props).flatMap(tablesIn)];
}
