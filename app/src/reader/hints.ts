import { kv } from '../core/kv';
import { ui, toast } from './reader.svelte';

/** Onboarding without a tour: a short hint at the moment a faster way would help, each
 *  shown once. Never over a sheet, never two within a minute and a half, so reading is
 *  not interrupted by lessons. */
const GAP = 90_000;
let lastAt = -GAP;
/** Off under automation (Playwright, the desktop self-tests): a toast in the middle of a
 *  timing run would be measured too. A test switches them on to check them. */
let on = !navigator.webdriver;
export function setHints(v: boolean) { on = v; lastAt = -GAP; }

export function hint(id: string, text: string, ms = 5600): boolean {
  if (!on) return false;
  // on a touch screen, only the hints made for one (they name gestures, not keys)
  if (document.documentElement.classList.contains('touchui') !== id.startsWith('touch-')) return false;
  const seen = kv.get<string[]>('hints', []);
  if (seen.includes(id)) return false;
  if (ui.sheet || ui.lightbox || (ui.mapOpen && !id.startsWith('map'))) return false;
  const now = performance.now();
  if (now - lastAt < GAP) return false;
  lastAt = now;
  kv.set('hints', [...seen, id]);
  toast(text, ms);
  return true;
}

/** Whether a hint has been shown (for triggers that count towards one). */
export const hinted = (id: string) => kv.get<string[]>('hints', []).includes(id);
