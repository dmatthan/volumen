import type { Core } from './types';
import { isTauri } from './shell';
import { webCore } from './web';

/** The desktop app talks to the native engine; a browser tab runs it as WASM (the sample
 *  book is added once the library shows: `App.svelte`). */
export async function makeCore(): Promise<Core> {
  if (isTauri) {
    const { tauriCore } = await import('./tauri');
    return tauriCore();
  }
  return webCore();
}
