/** Small per-user state (settings, positions, marks, lines). Reads are synchronous from
 *  memory; writes go to the backend in batches: the engine's SQLite in the desktop app,
 *  localStorage in a browser tab. Call `initKV` before anything reads, and `flushKV`
 *  before quitting. */
import { isTauri } from './shell';

const P = 'volumen.';
const mem = new Map<string, string>();
const dirty = new Map<string, string | null>();
let flushT = 0;

interface Backend { load(): Promise<[string, string][]>; put(changes: [string, string | null][]): Promise<void> }

const local: Backend = {
  async load() {
    const out: [string, string][] = [];
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i)!; if (k.startsWith(P)) out.push([k.slice(P.length), localStorage.getItem(k)!]); } } catch { /* storage unavailable */ }
    return out;
  },
  async put(changes) {
    try { for (const [k, v] of changes) v == null ? localStorage.removeItem(P + k) : localStorage.setItem(P + k, v); } catch { /* storage unavailable */ }
  },
};

const sqlite: Backend = {
  async load() {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<[string, string][]>('state_load');
  },
  async put(changes) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('state_put', { changes });
  },
};

let backend: Backend = local;

export async function initKV() {
  backend = isTauri ? sqlite : local;
  let rows = await backend.load().catch(() => [] as [string, string][]);
  // first run of the desktop app after state lived in WebKit's localStorage: bring it over
  if (isTauri && !rows.length) {
    const old = await local.load();
    if (old.length) { await sqlite.put(old); rows = old; }
  }
  for (const [k, v] of rows) mem.set(k, v);
  // a tab closing or going to the background keeps what was changed in its last moments
  // (localStorage writes at once; the desktop also flushes before it quits)
  addEventListener('pagehide', () => { flushKV(); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushKV(); });
}

export function flushKV(): Promise<void> {
  clearTimeout(flushT);
  if (!dirty.size) return Promise.resolve();
  const changes = [...dirty.entries()];
  dirty.clear();
  return backend.put(changes).catch(() => { for (const [k, v] of changes) if (!dirty.has(k)) dirty.set(k, v); });
}

function touch(k: string, v: string | null) {
  dirty.set(k, v);
  clearTimeout(flushT);
  flushT = window.setTimeout(flushKV, 250);
}

export const kv = {
  get<T>(k: string, d: T): T {
    const v = mem.get(k);
    if (v == null) return d;
    try { return JSON.parse(v) as T; } catch { return d; }
  },
  set(k: string, v: unknown): boolean {
    const s = JSON.stringify(v);
    if (mem.get(k) === s) return true;
    mem.set(k, s);
    touch(k, s);
    return true;
  },
  /** Keys starting with `prefix`. */
  keys(prefix: string): string[] {
    const out: string[] = [];
    for (const k of mem.keys()) if (k.startsWith(prefix)) out.push(k);
    return out;
  },
  del(k: string) {
    if (!mem.has(k)) return;
    mem.delete(k);
    touch(k, null);
  },
};
