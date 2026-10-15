/** Small colour helpers: hex ↔ OKLCH, WCAG contrast, and taming a desktop palette into
 *  one fit for long reading. */

type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB | null {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255) as RGB;
}
export const rgbToHex = (c: RGB) => '#' + c.map(v => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');

const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

export function luminance(c: RGB) {
  const [r, g, b] = c.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: string, b: string) {
  const x = hexToRgb(a), y = hexToRgb(b);
  if (!x || !y) return 1;
  const [l1, l2] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (l1 + 0.05) / (l2 + 0.05);
}

export function toOklch(c: RGB): [number, number, number] {
  const [r, g, b] = c.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}
function fromOklchRaw(L: number, C: number, H: number): RGB {
  const a = C * Math.cos((H * Math.PI) / 180), b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
/** OKLCH to hex, reducing chroma until the colour fits sRGB. */
export function fromOklch(L: number, C: number, H: number): string {
  for (let c = C; c >= 0; c -= 0.004) {
    const rgb = fromOklchRaw(L, c, H);
    if (rgb.every(v => v >= -0.001 && v <= 1.001)) return rgbToHex(rgb);
  }
  return rgbToHex(fromOklchRaw(L, 0, H));
}

/** Moves `fg`'s lightness (keeping its hue, chroma capped) until its contrast with `bg`
 *  lies in [lo, hi]. Contrast grows as the ink moves away from the paper's lightness, so
 *  a binary search on that side finds the nearest lightness that fits. */
export function fitContrast(bg: string, fg: string, lo: number, hi: number, maxChroma = 1): string {
  const f = hexToRgb(fg), b = hexToRgb(bg);
  if (!f || !b) return fg;
  const [L, C, H] = toOklch(f);
  const c = Math.min(C, maxChroma);
  const lightPaper = luminance(b) > 0.18;
  const at = (l: number) => contrast(bg, fromOklch(l, c, H));
  const k = at(L);
  if (k >= lo && k <= hi) return fromOklch(L, c, H);
  const target = k < lo ? lo : hi;
  // too faint: search from the ink towards black (light paper) or white (dark paper);
  // too harsh: from the ink towards the paper. `far` always holds an acceptable end.
  let near = L, far = k < lo ? (lightPaper ? 0 : 1) : toOklch(b)[0];
  for (let i = 0; i < 28; i++) {
    const mid = (near + far) / 2;
    if ((at(mid) >= target) === (k < lo)) far = mid; else near = mid;
  }
  return fromOklch(far, c, H);
}

/** A reading palette from a desktop theme's colours: the background as paper (chroma kept
 *  modest), the foreground near neutral at a comfortable contrast, the accent kept for
 *  headings, highlights and controls but made legible on the paper. */
export function tame(bg: string, fg: string, accent: string) {
  const b = hexToRgb(bg);
  if (!b) return null;
  const [L, C, H] = toOklch(b);
  const paper = fromOklch(L, Math.min(C, 0.05), H);
  const ink = fitContrast(paper, fg, 7, 13, 0.03);
  const acc = fitContrast(paper, accent, 3.2, 21, 0.2);
  return { paper, ink, accent: acc, dark: luminance(hexToRgb(paper)!) < 0.18 };
}
