import { createStore } from 'zustand/vanilla';

type SelectionState = {
    active: boolean;
    selected: ReadonlySet<string>;
    saveImage: ((source: HTMLElement, width: number) => Promise<void>) | null;
    begin: (key: string, saveImage: (source: HTMLElement, width: number) => Promise<void>) => void;
    toggle: (key: string) => void;
    cancel: () => void;
};

/** Local to one chat column and one runtime/directory/session selection. */
export const createConversationSelectionStore = () => createStore<SelectionState>((set) => ({
    active: false,
    selected: new Set(),
    saveImage: null,
    begin: (key, saveImage) => set({ active: true, selected: new Set([key]), saveImage }),
    toggle: (key) => set((state) => {
        if (!state.active) return state;
        const selected = new Set(state.selected);
        if (selected.has(key)) selected.delete(key);
        else selected.add(key);
        return { selected };
    }),
    cancel: () => set({ active: false, selected: new Set(), saveImage: null }),
}));

export type ConversationSelectionStore = ReturnType<typeof createConversationSelectionStore>;

export const conversationSelectionKey = (role: 'user' | 'assistant', id: string): string => `${role}:${id}`;
