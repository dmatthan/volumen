/** Window-level actions that differ between the desktop app and a browser tab. */
export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export const shell = {
  async toggleFullscreen() {
    if (isTauri) {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const w = getCurrentWindow();
      await w.setFullscreen(!(await w.isFullscreen()));
      return;
    }
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
    else await document.documentElement.requestFullscreen?.().catch(() => {});
  },
  /** Offers text as a file to save. Returns false if the reader cancelled. */
  async saveText(name: string, text: string, ext: 'md' | 'json' | 'vnotes' = 'md'): Promise<boolean> {
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<boolean>('save_text', { name, text, ext });
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: ext === 'md' ? 'text/markdown' : 'application/json' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  },
  /** Offers bytes as a file to save (a sealed book). Returns false if cancelled. */
  async saveBytes(name: string, bytes: Uint8Array): Promise<boolean> {
    if (isTauri) {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<boolean>('save_bytes', bytes, { headers: { 'x-name': encodeURIComponent(name) } });
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return true;
  },
  /** Saves and releases resources before the app exits (set by the app). */
  beforeQuit: async () => {},
  async quit() {
    if (!isTauri) return;
    await shell.beforeQuit();
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('quit_now');
  },
  /** Routes the window's close button through `quit`. */
  async watchClose() {
    if (!isTauri) return;
    const { listen } = await import('@tauri-apps/api/event');
    await listen('volumen://closing', () => shell.quit());
  },
};
