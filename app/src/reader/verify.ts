/** The page's guarantee that no line crosses its margin.
 *
 *  The press breaks lines from a model of how the webview draws text, and the model is
 *  very good (see calibrate.ts), but no model covers every font, renderer and version a
 *  reader may bring. So each column is checked as it is built (ahead of any motion, one
 *  column per frame) and a line that came out wider than its box is brought back inside
 *  by the smallest change that cannot be seen: its word spaces a little tighter, then its
 *  letters a hair closer, and only past both limits a horizontal squeeze. Lines are read
 *  in one pass and written in another, and columns are layout-contained, so the check
 *  costs one layout of one column.
 *
 *  Every correction is counted (`fitStats`): the tests read it, and a model that needs
 *  correcting often is a model with a gap. */

/** Word spaces may tighten by up to this many em each (justification varies them more). */
const MAX_WS_EM = 0.12;
/** Letters may close up by up to this many em each. */
const MAX_LS_EM = 0.025;

export const fitStats = { columns: 0, lines: 0, fixed: 0, subpx: 0, squeezed: 0, maxPx: 0, shrunk: 0, samples: [] as string[] };
export function resetFitStats() { Object.assign(fitStats, { columns: 0, lines: 0, fixed: 0, subpx: 0, squeezed: 0, maxPx: 0, shrunk: 0, samples: [] }); counted.clear(); }
/** Lines already counted: a column rebuilt is not a new miss. */
const counted = new Set<string>();

/** Off only to measure what the check costs (self-test). */
export const fitControl = { on: true };

export function fitColumn(col: HTMLElement, fs: number) {
  if (!fitControl.on) return;
  const lines = col.querySelectorAll<HTMLElement>('.ln:not(.brk)');
  fitStats.columns++;
  fitStats.lines += lines.length;
  // read: which lines are wider than their box, and by how much
  const over: [HTMLElement, number][] = [];
  for (const ln of lines) {
    // scrollWidth is whole px (rounded up): a candidate is measured exactly
    // (both are whole px; at a fractional display scale the box itself is not, so the
    // exact comparison is with the width the line was given, not clientWidth)
    if (ln.scrollWidth > ln.clientWidth) {
      const r = document.createRange();
      r.selectNodeContents(ln);
      const box = parseFloat(ln.style.width) || ln.getBoundingClientRect().width;
      const d = r.getBoundingClientRect().width + (ln.classList.contains('hy') ? hyphenWidth(ln) : 0) - box;
      if (d > 0) over.push([ln, d]);
    }
  }
  // display type (chapter heads, title pages, leaves) wraps on its own, but a single word
  // can still be wider than the column: it is set smaller until its text lies within the
  // column's edges (rare: the read below runs only for display type, once per column)
  const disp = col.querySelectorAll<HTMLElement>('.chead .title, .chead .label, .chead .part, .leaf .tl-title, .leaf .tl-sub, .leaf .rc-title, .leaf .el-text, .leaf .co-finis, .leaf .co-title');
  if (disp.length) {
    const box = col.getBoundingClientRect();
    const outside = (el: HTMLElement) => {
      const r = document.createRange();
      r.selectNodeContents(el);
      const t = r.getBoundingClientRect();
      return t.width > 0 && (t.left < box.left - 0.5 || t.right > box.right + 0.5);
    };
    for (const el of disp) {
      for (let i = 0; i < 16 && outside(el); i++) {
        el.style.fontSize = parseFloat(getComputedStyle(el).fontSize) * 0.95 + 'px';
        fitStats.shrunk++;
      }
    }
  }
  // write: spacing first
  const tight: HTMLElement[] = [];
  for (const [ln, d0] of over) {
    // a little more than the deficit, so the line ends inside its box, never on its edge
    const d = d0 + 0.25;
    // an overrun under a quarter pixel cannot be seen: corrected, but not counted as a miss
    const id = `${col.dataset.k}/${ln.dataset.b}/${ln.dataset.s}`;
    const fresh = !counted.has(id);
    counted.add(id);
    if (fresh) { if (d0 < 0.25) fitStats.subpx++; else fitStats.fixed++; }
    fitStats.maxPx = Math.max(fitStats.maxPx, +d0.toFixed(2));
    // a few of the lines the model missed, for diagnosis
    const text = ln.textContent || '';
    if (fresh && d0 >= 0.25 && fitStats.samples.length < 12) fitStats.samples.push(`${d0.toFixed(2)}px w=${ln.clientWidth} fit=${ln.style.getPropertyValue("--fit") || 0} spaces=${(text.match(/[ \u00a0]/g) || []).length} ${ln.className}: ${ln.innerHTML.slice(0, 160)}`);
    const spaces = (text.match(/[ \u00a0]/g) || []).length;
    const chars = [...text].length;
    let left = d;
    if (spaces) {
      const was = parseFloat(ln.style.getPropertyValue('--fit')) || 0;
      const take = Math.min(left, spaces * MAX_WS_EM * fs);
      ln.style.setProperty('--fit', `${(was - take / spaces).toFixed(3)}px`);
      left -= take;
    }
    if (left > 0.01 && chars > 1) {
      const take = Math.min(left, (chars - 1) * MAX_LS_EM * fs);
      ln.style.setProperty('--lfit', `${(-take / chars).toFixed(3)}px`);
      left -= take;
    }
    if (left > 0.01) tight.push(ln);
  }
  // a line that tightening could not save (one unbreakable string): measured again as it
  // now stands, and squeezed by exactly what remains
  for (const ln of tight) {
    const r = document.createRange();
    r.selectNodeContents(ln);
    const natural = r.getBoundingClientRect().width, w = parseFloat(ln.style.width) || ln.clientWidth;
    if (natural <= w - 0.5) continue;
    fitStats.squeezed++;
    ln.style.transformOrigin = '0 0';
    ln.style.transform = `scaleX(${((w - 0.75) / natural).toFixed(4)})`;
  }
}

/** The width of the hyphen a hyphenated line draws after its text. */
function hyphenWidth(ln: HTMLElement) {
  return parseFloat(getComputedStyle(ln, '::after').width) || 0;
}

/** How far a line's text ends past its box, px, as drawn (transforms included): what the
 *  reader would see. Zero for every line is the rule. */
export function residual(ln: HTMLElement): number {
  const r = document.createRange();
  r.selectNodeContents(ln);
  const rects = r.getClientRects();
  if (!rects.length) return 0;
  let right = -Infinity;
  for (const x of rects) right = Math.max(right, x.right);
  // the hyphen drawn after a hyphenated line is part of it
  if (ln.classList.contains('hy')) right += hyphenWidth(ln);
  return Math.max(0, right - ln.getBoundingClientRect().right);
}
