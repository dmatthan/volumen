/** Rich blocks (ingest's rich.rs): what the press cannot set from text (a genealogy drawn
 *  as a table, a figure in SVG, a formula), kept as XHTML and drawn here as a picture: an
 *  SVG whose `foreignObject` holds the markup, so the browser lays it out as the
 *  publisher made it, runs nothing in it, and scales it like any image (in the column,
 *  and large in the lightbox). Ink on transparent, in a common serif (a picture cannot
 *  load the app's faces); dark papers invert it (reader.css). */

/** An image's type when it is a rich block. */
export const RICH = 'application/xhtml+xml';

/** Widest a rich block is laid out at before the column scales it down. */
const MAX_W = 900;
const FACE = `font: 16px/1.4 Georgia, 'Times New Roman', serif; color: #111;`;

/** Its natural size in CSS px: as wide as it wants up to MAX_W, as tall as it then is. */
export function measureRich(xhtml: string): { w: number; h: number } {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-20000px;top:0;visibility:hidden;contain:layout style;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>:host{all:initial}</style><div class="box" style="${FACE} width:max-content;max-width:${MAX_W}px;display:flow-root">${xhtml}</div>`;
  document.body.append(host);
  const r = (root.querySelector('.box') as HTMLElement).getBoundingClientRect();
  host.remove();
  return { w: Math.max(24, Math.ceil(r.width)), h: Math.max(24, Math.ceil(r.height)) };
}

/** The picture, as a blob URL. */
export function richURL(xhtml: string, w: number, h: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`
    + `<foreignObject x="0" y="0" width="${w}" height="${h}"><div xmlns="http://www.w3.org/1999/xhtml" style="${FACE} width:${w}px;display:flow-root">${xhtml}</div></foreignObject></svg>`;
  return URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
}
