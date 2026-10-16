/** The colour around the page: what a phone's browser shows behind its status bar and
 *  toolbar. It follows the surface in view, the book's paper while reading, so the page
 *  has no frame of another colour; it changes as the surface does (`ms`: at once between
 *  views, with the reader's own fade between themes).
 *
 *  Browsers take it from different places: Chrome on Android and installed apps from
 *  `theme-color`; Safari 26 on iOS ignores that and takes the background of a
 *  `position: fixed` element at least 90% wide that a hit test finds 4 px inside the top
 *  (and the bottom) edge, else the body's, and fills the band under its bars with it
 *  (WebKit `LocalFrameView::fixedContainerEdges`). So two such strips sit at the edges,
 *  the page's own colour (the top one seen, in the band under the status bar: tokens.css);
 *  Safari is asked to look again when the colour changes (a strip that appears is sampled
 *  anew). */
import { isSafari } from './env';

let meta: HTMLMetaElement | null = null;
let probe: CanvasRenderingContext2D | null = null;
let strips: HTMLElement[] = [];
let again = 0;

export function edges(color: string, ms: number) {
  const html = document.documentElement;
  // (set on the elements themselves, not as a custom property on the root: every element
  // inherits those, and changing one restyled the whole page as the map opened, a frame
  // lost each time)
  for (const el of [html, document.body, ...strips]) {
    el.style.transitionDuration = `${ms}ms`;
    el.style.backgroundColor = color;
  }
  if (!strips.length && isSafari) {
    strips = ['top', 'bottom'].map(side => {
      const d = document.createElement('div');
      d.className = `edge-strip ${side}`;
      d.setAttribute('aria-hidden', 'true');
      d.style.backgroundColor = color;
      document.body.prepend(d);
      return d;
    });
  }
  clearTimeout(again);
  if (strips.length) again = window.setTimeout(() => {
    for (const d of strips) d.style.display = 'none';
    requestAnimationFrame(() => { for (const d of strips) d.style.display = ''; });
  }, ms + 60);
  // theme-color, when the browser is idle (reading the colour back makes it restyle now)
  const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 200));
  idle(() => {
    if (!meta) {
      for (const m of document.querySelectorAll('meta[name="theme-color"]')) m.remove();
      meta = document.createElement('meta');
      meta.name = 'theme-color';
      document.head.append(meta);
    }
    meta.content = hex(resolve(color));
  });
}

/** A colour that may name tokens (`var(--paper)`), as a colour. */
function resolve(color: string): string {
  const cs = getComputedStyle(document.documentElement);
  return color.replace(/var\((--[\w-]+)\)/g, (_, k) => cs.getPropertyValue(k).trim());
}

/** Any CSS colour as #rrggbb (`theme-color` is not read in every syntax). */
function hex(color: string): string {
  probe ??= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!probe) return color;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
