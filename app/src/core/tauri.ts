import { invoke } from '@tauri-apps/api/core';
import type { BookData, Core, FamilyLoad, LayoutParams, LibEntry } from './types';

/** The native engine in the desktop shell (src-tauri). Layout tables arrive as raw
 *  bytes, not JSON. */
export function tauriCore(): Core {
  return {
    importFile: (bytes, name) => invoke<LibEntry>('import_bytes', bytes, { headers: { 'x-name': encodeURIComponent(name) } }),
    pick: async () => {
      const p = await invoke<({ kind: 'book' } & LibEntry) | { kind: 'notes'; text: string } | { kind: 'backup' } | null>('pick_book');
      if (!p) return null;
      if (p.kind === 'notes') return p;
      if (p.kind === 'backup') return { kind: 'backup', file: new Blob([await invoke<ArrayBuffer>('picked_bytes')]) };
      const { kind: _, ...entry } = p;
      return { kind: 'book', entry: entry as LibEntry };
    },
    open: async id => JSON.parse(await invoke<string>('open_book', { id })) as BookData,
    layout: (id, sections, p: LayoutParams) => invoke<ArrayBuffer>('layout', { id, sections, p }),
    remove: id => invoke<void>('remove_book', { id }),
    find: async (id, query, limit) => new Uint32Array(await invoke<ArrayBuffer>('find', { id, query, limit })),
    searchLibrary: async query => JSON.parse(await invoke<string>('search_library', { query })),
    place: (id, anchors) => invoke('place_notes', { id, anchors }),
    fontNeeds: async (id, family) => JSON.parse(await invoke<string>('font_needs', { id, family })),
    library: () => invoke<LibEntry[]>('library'),
    cover: id => invoke<ArrayBuffer>('cover', { id }),
    setImageSizes: (id, sizes) => invoke<void>('set_image_sizes', { id, sizes }),
    reimport: id => invoke<LibEntry>('reimport', { id }),
    source: async id => {
      const name = await invoke<string | null>('source_name', { id });
      return name ? { name, bytes: new Uint8Array(await invoke<ArrayBuffer>('source_bytes', { id })) } : null;
    },
    imageBytes: (id, idx) => invoke<ArrayBuffer>('image_bytes', { id, idx }),
    setCover: (id, bytes) => invoke<void>('set_cover', new Uint8Array(bytes), { headers: { 'x-id': id } }),
    // served by the shell's volimg: scheme (Windows' webview reaches custom schemes as http://<scheme>.localhost)
    imageURL: (id, idx) => (navigator.userAgent.includes('Windows') ? `http://volimg.localhost/${id}/${idx}` : `volimg://localhost/${id}/${idx}`),
    probe: (p, texts) => invoke<number[]>('probe', { p, texts }),
    loadFamily: name => invoke<FamilyLoad>('load_family', { name }),
    fontFile: (name, index) => invoke<ArrayBuffer>('font_file', { name, index }),
    systemFamilies: () => invoke<string[]>('system_families'),
    desktopPalette: () => invoke<Record<string, string> | null>('desktop_palette'),
  };
}
