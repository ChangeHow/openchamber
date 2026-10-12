import type { DecorateContext } from '../markdown/decorate';
import type { VSCodeAPI } from '@/lib/api/types';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorMobileApp } from '@/apps/mobileNativeChrome';
import { shareFileFromNativeApp } from '@/lib/nativeFileShare';
import { z } from 'zod';

export const MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE = 'data-message-image-export-exclude';

export const cloneMessageImageExportSource = (source: HTMLElement): HTMLElement => {
    // SAFETY: cloneNode preserves the concrete type of an HTMLElement source.
    const clone = source.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(`[${MESSAGE_IMAGE_EXPORT_EXCLUDE_ATTRIBUTE}="true"]`).forEach((element) => {
        element.remove();
    });
    return clone;
};

const imageSaveResult = z.object({ saved: z.boolean().optional(), canceled: z.boolean().optional(), error: z.string().optional() });

/** Single-answer and conversation exports share the same capture and runtime save path. */
export const saveMessageImageExport = async (
    source: HTMLElement,
    fileName: string,
    vscodeApi: VSCodeAPI | undefined,
): Promise<'saved' | 'canceled'> => {
    const { toPng } = await import('html-to-image');
    const computedStyle = window.getComputedStyle(source);
    const rootStyle = window.getComputedStyle(document.documentElement);
    const backgroundColor = rootStyle.getPropertyValue('--surface-background').trim()
        || computedStyle.backgroundColor || window.getComputedStyle(document.body).backgroundColor;
    const wrapper = document.createElement('div');
    wrapper.setAttribute('data-message-image-export', 'true');
    wrapper.style.cssText = `padding: 24px; background-color: ${backgroundColor}; display: inline-block; position: fixed; inset-inline-start: 0; top: 0; z-index: -1; pointer-events: none;`;
    const clone = cloneMessageImageExportSource(source);
    // Keep explicit export widths and syntax variables supplied by generated sources.
    clone.style.transform = 'none';
    clone.style.contain = 'none';
    clone.querySelectorAll<HTMLElement>('[data-message-actions="true"], [data-message-action-group="true"]').forEach((row) => {
        row.style.display = 'none';
    });
    const adjustedFooters = new Set<HTMLElement>();
    clone.querySelectorAll<HTMLElement>('[aria-label^="Message time:"]').forEach((element) => {
        const timestamp = element.getAttribute('aria-label')?.replace('Message time:', '').trim();
        if (!timestamp || element.textContent?.includes(timestamp)) return;
        const text = document.createElement('span');
        text.style.marginInlineStart = '4px';
        text.textContent = timestamp;
        element.appendChild(text);
        const footer = element.parentElement?.parentElement;
        if (footer && !adjustedFooters.has(footer)) {
            footer.style.justifyContent = 'flex-start';
            adjustedFooters.add(footer);
        }
    });
    wrapper.appendChild(clone);
    document.body.appendChild(wrapper);
    try {
        const dataUrl = await toPng(wrapper, { quality: 1, pixelRatio: 2, backgroundColor });
        if (isVSCodeRuntime()) {
            const result = imageSaveResult.parse(await vscodeApi?.saveImage?.({ fileName, dataUrl }));
            if (!result.saved) {
                if (result.canceled) return 'canceled';
                throw new Error(result.error || 'Failed to save image in VS Code');
            }
        } else if (isCapacitorMobileApp()) {
            const blob = await fetch(dataUrl).then((response) => response.blob());
            await shareFileFromNativeApp(new File([blob], fileName, { type: blob.type || 'image/png' }));
        } else {
            const link = document.createElement('a');
            link.download = fileName;
            link.href = dataUrl;
            document.body.appendChild(link);
            try { link.click(); } finally { link.remove(); }
        }
        return 'saved';
    } finally {
        wrapper.remove();
    }
};

// An image has no buttons to label and no settings to toggle: the decoration
// only has to draw code blocks and tables the way the chat does.
const IMAGE_DECORATE_CONTEXT: DecorateContext = {
    labels: {
        copy: '',
        copied: '',
        enableCodeWrap: '',
        disableCodeWrap: '',
        enableTableWrap: '',
        disableTableWrap: '',
        copyTable: '',
        downloadTable: '',
        copyDiagram: '',
        downloadDiagram: '',
        zoomInDiagram: '',
        zoomOutDiagram: '',
        resetDiagramView: '',
        previewLabel: '',
        previewTitle: '',
    },
    mermaidControls: { download: false, copy: false, showPanZoomControls: false },
    codeBlockLineWrap: false,
    tableCellWrap: false,
    renderMermaid: () => ({}),
};

/** Renders assistant Markdown to sanitized, highlighted HTML the way the chat does. */
const renderAssistantMarkdownHtml = async (text: string): Promise<string> => {
    const { renderMarkdownBlocks } = await import('../markdown/markdownCore');
    const blocks = await renderMarkdownBlocks(text, false, 'label');
    return blocks.map((block) => block.html).join('');
};

/**
 * The image source for a whole turn: every text part its assistant messages
 * wrote, in order. Earlier steps may be folded away or not mounted, and part of
 * the last message can sit in Activity, so the text is rendered here from
 * Markdown with the classes and decoration the chat uses. `syntaxStyle` carries
 * the code colour variables the chat sets inline on its Markdown roots.
 */
export const buildTurnImageExportSource = async (
    segments: readonly string[],
    syntaxStyle: string | null,
    renderMarkdownHtml: (text: string) => Promise<string> = renderAssistantMarkdownHtml,
): Promise<HTMLElement> => {
    const { decorateMarkdown } = await import('../markdown/decorate');
    const source = document.createElement('div');

    for (const text of segments) {
        const html = await renderMarkdownHtml(text);
        const segment = document.createElement('div');
        segment.className = 'relative break-words my-1';
        const markdown = document.createElement('div');
        markdown.className = 'markdown-content leading-relaxed';
        if (syntaxStyle) markdown.setAttribute('style', syntaxStyle);
        markdown.innerHTML = html;
        decorateMarkdown(markdown, IMAGE_DECORATE_CONTEXT);
        segment.appendChild(markdown);
        source.appendChild(segment);
    }
    return source;
};
