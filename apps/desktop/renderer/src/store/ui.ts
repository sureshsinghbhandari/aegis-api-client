import { create } from 'zustand';

export type ModalId = 'settings' | 'environments' | 'import' | 'export' | 'runner' | 'search' | 'about' | 'workspaces' | 'collection-edit' | 'backup';

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  confirmLabel?: string;
}

interface UiState {
  modal: { id: ModalId; props?: Record<string, unknown> } | null;
  confirmDialog: (ConfirmOptions & { resolve(v: boolean): void }) | null;
  promptDialog: (PromptOptions & { resolve(v: string | null): void }) | null;
  openModal(id: ModalId, props?: Record<string, unknown>): void;
  closeModal(): void;
  confirm(options: ConfirmOptions): Promise<boolean>;
  prompt(options: PromptOptions): Promise<string | null>;
}

export const useUi = create<UiState>((set, get) => ({
  modal: null,
  confirmDialog: null,
  promptDialog: null,
  openModal: (id, props) => set({ modal: { id, ...(props ? { props } : {}) } }),
  closeModal: () => set({ modal: null }),
  confirm: (options) =>
    new Promise<boolean>((resolve) => {
      get().confirmDialog?.resolve(false);
      set({
        confirmDialog: {
          ...options,
          resolve: (v) => {
            set({ confirmDialog: null });
            resolve(v);
          },
        },
      });
    }),
  prompt: (options) =>
    new Promise<string | null>((resolve) => {
      get().promptDialog?.resolve(null);
      set({
        promptDialog: {
          ...options,
          resolve: (v) => {
            set({ promptDialog: null });
            resolve(v);
          },
        },
      });
    }),
}));
