import type { Core, LayoutParams } from '../core/types';

/** Does this webview position glyphs on whole pixels? The press can model either; we
 *  ask it for both widths of a few probe strings and compare with what the DOM draws. */
/** Probe widths come back from the engine as [exact, whole px, 1/60 px] per string. */
const PROBES = [
  'and the mysterious mixture behaves under the varying experiments of Time',
  'Her flame quickly burned up that light fuel; and, fed from within, soared',
  'WAVY AVA Tokyo affinity office, “quoted” — 1908 minimum illumination',
  // pairs some faces kern across the space, on one side or both
  'T A Y V. “W” L’ A T, Yo To Wy y. f r A Ty ’T',
];
/** `round`: glyph advances on whole px (Chromium on Linux); `appUnits`: on 1/60 px
 *  (Firefox); neither: exact (WebKit, Chromium with subpixel positioning). */
export interface Calibration { round: boolean; appUnits: boolean; spaceKern: 0 | 1 | 2; linkRuns: boolean; err: number }
const cache = new Map<string, Calibration>();
/** (benches: what is known) */
export const calCache = cache;

/** `host` must carry the reader's type (its CSS variables), as the lines do. */
export async function calibrate(core: Core, host: HTMLElement, p: LayoutParams): Promise<Calibration> {
  const key = JSON.stringify({ ...p, measure: 0, rows: 0, headRows: 0, round: false, appUnits: false, spaceKern: 0, linkRuns: false });
  const hit = cache.get(key);
  if (hit) return hit;
  // models of the webview's text: glyph advances rounded or not, and kerning around word
  // spaces not at all, on their left, or on both sides; whichever matches what it draws wins
  const modes = [0, 1, 2] as const;
  const ws = await Promise.all(modes.map(spaceKern => core.probe({ ...p, spaceKern }, PROBES)));
  const probe = document.createElement('div');
  probe.className = 'ln';
  probe.style.cssText = `visibility:hidden;left:0;top:0;width:auto;--o:${Math.min(144, Math.max(6, p.size))};font-size:${p.size}px`;
  host.append(probe);
  // errors for each space-kerning mode × [exact, whole px, 1/60 px]
  const e = Array(9).fill(0);
  PROBES.forEach((t, i) => {
    probe.textContent = t;
    const b = probe.getBoundingClientRect().width;
    ws.forEach((w, m) => { for (let q = 0; q < 3; q++) e[3 * m + q] += Math.abs(b - w[3 * i + q]); });
  });
  // does kerning survive an element's edge? the same kerned pairs, whole and cut by spans
  const KERNED = 'AVAWATo”, “TyLTP.';
  probe.textContent = KERNED;
  const whole = probe.getBoundingClientRect().width;
  probe.innerHTML = [...KERNED].map(c => `<span>${c}</span>`).join('');
  const cut = probe.getBoundingClientRect().width;
  const linkRuns = Math.abs(cut - whole) > 0.3;
  probe.remove();
  // ties keep the simpler model (no space kerning, then exact)
  let best = 0;
  for (let j = 1; j < e.length; j++) if (e[j] < e[best] - 1e-3) best = j;
  const res: Calibration = { round: best % 3 === 1, appUnits: best % 3 === 2, spaceKern: modes[Math.floor(best / 3)], linkRuns, err: e[best] / PROBES.length };
  cache.set(key, res);
  return res;
}
