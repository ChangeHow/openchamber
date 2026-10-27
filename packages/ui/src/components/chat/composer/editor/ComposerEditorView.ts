import { EditorView } from '@codemirror/view';

/** The composer avoids CodeMirror EditContext because of the Android IME failure. */
export class ComposerEditorView extends EditorView {
    static EDIT_CONTEXT = false;
    // Opt in to the pinned @codemirror/view patch for native iOS paragraphs.
    static IOS_PARAGRAPH_SYNC = true;

    private capturingPendingInput = false;

    get isCapturingPendingInput() {
        return this.capturingPendingInput;
    }

    /** Capture only the native paragraph this patch still owns, without UI callbacks. */
    capturePendingInput(): string | undefined {
        const previous = this.state.doc;
        this.capturingPendingInput = true;
        try {
            this.flushPendingIOSParagraph();
            return this.state.doc === previous ? undefined : this.state.doc.toString();
        } finally {
            this.capturingPendingInput = false;
        }
    }

    override destroy() {
        this.flushPendingIOSParagraph();
        super.destroy();
    }
}
