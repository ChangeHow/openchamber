import { unified, type Plugin } from 'unified';
import remarkParse from 'remark-parse';
import { defaultRemarkPlugins } from 'streamdown';
import type { Root, RootContent } from 'mdast';

export type SelectedConversationMessage = {
    key: string;
    role: 'user' | 'assistant';
    segments: readonly string[];
    attachments?: readonly { name: string; url?: string }[];
};

// Match the parser already used by chatQuoteAnchor and the shared renderer.
// SAFETY: Streamdown exports [remarkGfm, options] but types it as Pluggable.
const gfm = defaultRemarkPlugins.gfm as [Plugin<[{ singleTilde?: boolean }?], Root>, { singleTilde?: boolean }];
const parser = unified().use(remarkParse).use(gfm[0], { singleTilde: false });
type Edit = { start: number; end: number; text: string };

function visit(node: Root | RootContent, callback: (node: RootContent) => void): void {
    if (node.type !== 'root') callback(node);
    if ('children' in node) for (const child of node.children) visit(child, callback);
}

function applyEdits(source: string, edits: Edit[]): string {
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    }
    return source;
}

function closeFences(source: string): string {
    const edits: Edit[] = [];
    visit(parser.parse(source), (node) => {
        if (node.type !== 'code') return;
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return;
        const raw = source.slice(start, end);
        const opener = /^( {0,3})(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)/.exec(raw);
        if (!opener) return;
        const fence = opener[2];
        const lineStart = source.lastIndexOf('\n', start - 1) + 1;
        const prefix = source.slice(lineStart, start).replace(/(?:[-+*]|\d+[.)])([ \t]+)/g, (marker) => ' '.repeat(marker.length));
        const lines = raw.replace(/\r?\n$/, '').split(/\r?\n/);
        const last = lines.at(-1) ?? '';
        // The parser excludes the closing line from value. Container prefixes
        // can use equivalent whitespace, including tabs and compact quote marks.
        const contentLines = node.value ? node.value.split(/\r?\n/).length : 0;
        if (lines.length > contentLines + 1 && new RegExp(`^[ >\\t]*${fence[0]}{${fence.length},}[ \\t]*$`).test(last)) return;
        edits.push({ start: end, end, text: `${source[end - 1] === '\n' ? '' : '\n'}${prefix}${opener[1]}${fence}\n` });
    });
    return applyEdits(source, edits);
}

function namespaceReferences(source: string, index: number, definitions: string): string {
    const local = new Set<string>();
    const namespace = (identifier: string) => `oc-${index + 1}-${encodeURIComponent(identifier)}`;
    visit(parser.parse(source), (node) => {
        if (node.type === 'definition' || node.type === 'footnoteDefinition') local.add(`${node.type}:${node.identifier}`);
    });
    // Let the existing parser identify references that could bind to another
    // message after joining. Undefined footnotes must remain literal too.
    const footnotes = [...source.matchAll(/\[\^([^\]\r\n]+)\]/g)].map((match) => `[^${match[1]}]: unused`).join('\n\n');
    const edits: Edit[] = [];
    visit(parser.parse(`${source}\n\n${definitions}\n\n${footnotes}`), (node) => {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined || end > source.length) return;
        const raw = source.slice(start, end);
        if (node.type === 'definition' || node.type === 'footnoteDefinition') {
            const label = /^\[(\^?)((?:\\[\s\S]|[^\]\\])+)\]:/.exec(raw);
            if (label) edits.push({ start: start + 1 + label[1].length, end: start + label[0].length - 2, text: namespace(node.identifier) });
        } else if (node.type === 'footnoteReference') {
            edits.push(local.has(`footnoteDefinition:${node.identifier}`)
                ? { start: start + 2, end: end - 1, text: namespace(node.identifier) }
                : { start, end: start, text: '\\' });
        } else if (node.type === 'linkReference' || node.type === 'imageReference') {
            if (!local.has(`definition:${node.identifier}`)) {
                edits.push({ start: start + (node.type === 'imageReference' ? 1 : 0), end: start + (node.type === 'imageReference' ? 1 : 0), text: '\\' });
                return;
            }
            const label = namespace(node.identifier);
            edits.push(node.referenceType === 'shortcut'
                ? { start: end, end, text: `[${label}]` }
                : { start: start + raw.lastIndexOf('[') + 1, end: end - 1, text: label });
        }
    });
    return applyEdits(source, edits);
}

function escapeLabel(label: string): string {
    return label.replace(/\\/g, '\\\\').replace(/([*_[\]`<>])/g, '\\$1').replace(/[\r\n]/g, ' ');
}

function publicAttachmentUrl(value: string | undefined): string | undefined {
    if (!value) return undefined;
    if (/^data:[^,\s]+,/i.test(value)) return value;
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase();
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
        if (host.startsWith('[') || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return undefined;
        if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
            const [a, b] = host.split('.').map(Number);
            if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return undefined;
        }
        if (/\/(?:api|auth)(?:\/|$)/i.test(url.pathname)) return undefined;
        return url.href;
    } catch {
        return undefined;
    }
}

export function formatSelectedConversationMarkdown(
    messages: readonly SelectedConversationMessage[],
    labels: { user: string; assistant: string; attachment: string },
): string {
    const sources = messages.map((message) => message.segments.map(closeFences).join('\n\n'));
    const definitions: string[] = [];
    for (const source of sources) visit(parser.parse(source), (node) => {
        if (node.type === 'definition' || node.type === 'footnoteDefinition') definitions.push(source.slice(node.position?.start.offset, node.position?.end.offset));
    });
    return messages.map((message, index) => {
        const parts = [namespaceReferences(sources[index], index, definitions.join('\n\n'))];
        for (const attachment of message.attachments ?? []) {
            const name = escapeLabel(attachment.name);
            const url = publicAttachmentUrl(attachment.url);
            const destination = url?.replace(/[<>\\\s]/g, (character) => encodeURIComponent(character));
            parts.push(destination ? `[${name}](<${destination}>)` : `${escapeLabel(labels.attachment)}: ${name}`);
        }
        return `**${escapeLabel(labels[message.role])}**\n\n${parts.filter((part) => part.length > 0).join('\n\n')}`;
    }).join('\n\n---\n\n');
}
