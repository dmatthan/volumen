import { embedOpts } from '../core/embed';
import { BlockKind, Style, type BlockData, type BookData } from '../core/types';
import type { Metrics } from './geometry';
import type { Annotation } from './annotations';
import { F, FIELDS, Flag, type Item, type Strip } from './strip';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Inline HTML for text[s, e) of a block: its styled runs, links and marks
 *  (highlights, find hits). Nesting is mark ⟩ link ⟩ style; each mark is one element over
 *  its whole run on the line, so it draws as one shape. Nothing here changes the text's
 *  width: links are colour and underline only. */
/** Stretches of a block other readers marked, with their colours (feedback.ts). */
export type FbSeg = { s: number; e: number; colours: number[]; ids: string[] };

/** Underlines for a stretch other readers marked: one stripe per reader, stacked from
 *  the baseline down, drawn as backgrounds so the text's width is untouched. */
function fbOpen(f: FbSeg) {
  const bg = f.colours.slice(0, 3).map((c, i) => `linear-gradient(var(--r${c}),var(--r${c})) 0 calc(100% - ${i * 3}px)/100% 2px no-repeat`).join(',');
  return `<span class="fb" data-f="${esc(f.ids.join(' '))}" style="background:${bg}">`;
}

function inline(b: BlockData, s: number, e: number, hls?: Annotation[], fbs?: FbSeg[]): string {
  const t = b.t, r = b.r, ls = b.l;
  const hs = hls?.filter(a => a.s < e && a.e > s);
  const fs = fbs?.filter(f => f.s < e && f.e > s);
  if (!hs?.length && !fs?.length && !ls?.length && !r.length) return esc(t.slice(s, e));
  const cuts = new Set([s, e]);
  const cut = (c: number) => { if (c > s && c < e) cuts.add(c); };
  for (let j = 0; j < r.length; j += 3) { cut(r[j]); cut(r[j + 1]); }
  if (ls) for (const l of ls) { cut(l[0]); cut(l[1]); }
  if (hs) for (const a of hs) { cut(a.s); cut(a.e); }
  if (fs) for (const f of fs) { cut(f.s); cut(f.e); }
  const pts = [...cuts].sort((x, y) => x - y);
  let out = '';
  let openH: Annotation | undefined, openF: FbSeg | undefined, openL: [number, number, string] | undefined;
  // nesting: mark ⟩ other readers' underline ⟩ link ⟩ style
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], z = pts[i + 1];
    const h = hs?.find(x => x.s <= a && x.e > a);
    const f = fs?.find(x => x.s <= a && x.e > a);
    const L = ls?.find(x => x[0] <= a && x[1] > a);
    const inner = h !== openH || f !== openF;
    if (inner || (L !== openL && openL)) { if (openL) { out += '</a>'; openL = undefined; } }
    if (inner && openF) { out += '</span>'; openF = undefined; }
    if (h !== openH) {
      if (openH) out += '</mark>';
      if (h) out += `<mark class="hl h${h.color}${h.note && h.e <= e ? ' nt' : ''}${h.s >= s ? ' hs' : ''}${h.e <= e ? ' he' : ''}" data-a="${h.id}">`;
      openH = h;
    }
    if (f && f !== openF) { out += fbOpen(f); openF = f; }
    if (L !== openL) {
      if (L) out += linkOpen(L[2]);
      openL = L;
    }
    const st = styleAt(b, a);
    let o = '', c = '';
    if (st & Style.Italic) { o += '<i>'; c = '</i>' + c; }
    if (st & Style.Bold) { o += '<b>'; c = '</b>' + c; }
    if (st & Style.SmallCaps) { o += '<span class="sc">'; c = '</span>' + c; }
    if (st & Style.Sup) { o += '<sup>'; c = '</sup>' + c; }
    if (st & Style.Sub) { o += '<sub>'; c = '</sub>' + c; }
    out += o + esc(t.slice(a, z)) + c;
  }
  if (openL) out += '</a>';
  if (openF) out += '</span>';
  if (openH) out += '</mark>';
  return out;
}

function linkOpen(to: string): string {
  const k = to[0], v = esc(to.slice(2));
  if (k === 'n') return `<a class="nr" data-n="${v}">`;
  if (k === 'b') return `<a class="xr" data-b="${v}">`;
  return `<a class="ur" data-u="${v}">`;
}

function styleAt(b: BlockData, i: number) {
  for (let j = 0; j < b.r.length; j += 3) if (i >= b.r[j] && i < b.r[j + 1]) return b.r[j + 2];
  return 0;
}

/** HTML for a note's text (its own runs; lines become paragraphs). */
export function noteHTML(t: string, r: number[]): string {
  const b: BlockData = { k: BlockKind.P, key: '', t, r };
  let out = '', at = 0;
  for (const line of t.split('\n')) {
    out += `<p>${inline(b, at, at + line.length)}</p>`;
    at += line.length + 1;
  }
  return out;
}

/** Dots in the gutter beside the line where each noted highlight starts: the note itself
 *  shows beside them on demand (SideNotes). */
function noteDots(anns: Annotation[] | undefined, s: number, e: number, top: number, M: Metrics, others?: { id: string; s: number; colour: number }[]): string {
  let out = '', n = 0;
  // inside the focus zone's half of the gutter, so a press on it is the reader's
  const at = () => `top:${top + M.lh / 2}px;left:${M.colW + Math.min(M.G * 0.36, 14) + n++ * 11}px`;
  for (const a of anns ?? []) if (a.note && a.s >= s && a.s < e) out += `<span class="nd" data-a="${a.id}" style="${at()}" aria-hidden="true"></span>`;
  // other readers' notes: a dot in their colour
  for (const o of others ?? []) if (o.s >= s && o.s < e) out += `<span class="nd fd" data-a="${esc(o.id)}" style="${at()};--dc:var(--r${o.colour})" aria-hidden="true"></span>`;
  return out;
}

/** Scripts written right to left. */
const RTL = /[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Syriac}\p{Script=Thaana}\p{Script=Nko}\p{Script=Adlam}\p{Script=Samaritan}\p{Script=Mandaic}]/u;
const rtlOf = new WeakMap<object, boolean>();
/** A paragraph written right to left (Hebrew, Arabic): told by its first letter, as
 *  HTML's dir="auto" tells it. Its lines are set from the column's right edge, the
 *  indent there too; the press's lines are the same either way. */
export function rtl(b: { t: string }): boolean {
  let v = rtlOf.get(b);
  if (v === undefined) {
    const first = /\p{L}/u.exec(b.t);
    v = !!first && RTL.test(first[0]);
    rtlOf.set(b, v);
  }
  return v;
}

/** The optical size the press measures a size at (shape.rs `opsz`). */
const opsz = (px: number) => Math.min(144, Math.max(6, px));

/** The text lines of one column. */
/** Other readers' notes, for drawing (feedback.ts `Feedback`). */
export interface FbView {
  segments(key: string): FbSeg[];
  written(key: string): { r: string; n: { id: string; s: number; e: number } }[];
  marked(key: string): { r: string }[];
  colourOf(r: string): number;
}

export function columnHTML(strip: Strip, k: number, M: Metrics, marks: Set<string>, marksOf?: (key: string) => Annotation[] | undefined, imgSrc?: (i: number) => string, fb?: FbView): string {
  const L = strip.linesAt(k);
  let html = '';
  const it = strip.itemAt(k)!;
  const sec = strip.book.sections[it.sec];
  if (it.type === 'sect' && k === it.start && sec.k === 1) html += headHTML(strip.book, it.sec, M);
  if (!L) return html;
  const { u, f } = L.sl;
  for (let j = L.from; j < L.to; j++) {
    const o = j * FIELDS;
    const flags = u[o + F.flags] & 0xffff, spaces = u[o + F.flags] >>> 16;
    const top = u[o + F.row] * M.lh;
    const bi = u[o + F.block];
    const b = sec.blocks[bi];
    if (flags & Flag.Break) {
      if (flags & Flag.First) html += `<div class="ln brk" style="top:${top}px">⁂</div>`;
      continue;
    }
    const x = f[o + F.x], avail = f[o + F.avail], nat = f[o + F.natural];
    if (flags & Flag.ImageRow) continue;
    if (flags & Flag.Rule) { html += `<div class="trule" style="top:${top}px;left:${Math.round(x)}px;width:${Math.round(avail)}px"></div>`; continue; }
    if (flags & Flag.Cell && u[o + F.s] === u[o + F.e]) continue;
    if (flags & Flag.Image) {
      // centred in the rows it spans
      const h = spaces * M.lh, i = b.img ?? -1, alt = b.t;
      const src = imgSrc?.(i) ?? '';
      // on whole pixels, so the image's edges stay crisp
      const rich = strip.book.images[i]?.[3] === 'application/xhtml+xml';
      html += `<figure class="img${rich ? ' rich' : ''}" data-i="${i}" data-b="${bi}" style="top:${Math.round(top + (h - nat) / 2)}px;left:${Math.round(x)}px;width:${Math.round(avail)}px;height:${Math.round(nat)}px">`
        + `<img data-i="${i}" alt="${esc(alt)}" decoding="async"${src ? ` src="${esc(src)}"` : ''}></figure>`;
      continue;
    }
    if (b.k === BlockKind.Pre) {
      // spaces are significant: the line keeps them (white-space: pre), sized by the press
      const anns = marksOf?.(b.key);
      html += `<div class="ln pre${marks.has(b.key) ? ' mk' : ''}" style="top:${top}px;left:${x.toFixed(2)}px;width:${avail.toFixed(2)}px;font-size:${spaces / 16}px" data-b="${bi}" data-s="${u[o + F.s]}">${inline(b, u[o + F.s], u[o + F.e], anns, fb?.segments(b.key))}</div>`;
      html += noteDots(anns, u[o + F.s], u[o + F.e], top, M);
      continue;
    }
    let cls = 'ln';
    if (flags & Flag.Justify) cls += ' j';
    if (flags & Flag.Hyph) cls += ' hy';
    if (flags & Flag.Right) cls += ' r';
    if (flags & Flag.Center) cls += ' c';
    if (flags & Flag.Head) cls += ' hd';
    if (flags & Flag.Cell) cls += ' cell';
    // styles the press adds by kind (fill.rs): signatures in small caps
    if (b.k === BlockKind.Sign) cls += ' sc2';
    if (marks.has(b.key)) cls += ' mk';
    const left = rtl(b) ? (cls += ' rtl', M.colW - x - avail) : x;
    // an indented line knows its indent, so a mark's bar and wash start at the column's edge
    let style = `top:${top}px;left:${left.toFixed(2)}px;width:${avail.toFixed(2)}px${x > 0 ? `;--x:${x.toFixed(2)}px` : ''}`;
    // a table set smaller: its size, and optical sizes to match (as the press measures)
    const sized = flags & Flag.Sized ? spaces / 16 : 0;
    if (sized) style += `;font-size:${sized}px;--opsz:${opsz(sized)};--opsz-s:${opsz(sized * 0.7)};--opsz-sc:${opsz(sized * 0.78)}`;
    // a line the press shrank: tighten the spaces so the browser's natural width fits
    if (nat > avail && (spaces > 0 || sized)) {
      // the browser applies word spacing to every word separator on the line, the
      // non-breaking ones inside words included: spread the tightening over all of them
      const seps = (b.t.slice(u[o + F.s], u[o + F.e]).match(/[ \u00a0]/g) || []).length || (sized ? 0 : spaces);
      if (seps) style += `;--fit:${((avail - nat) / seps - 0.02).toFixed(3)}px`;
    }
    const bullet = flags & Flag.Bullet ? '<span class="bul" aria-hidden="true">•</span>' : '';
    const anns = marksOf?.(b.key);
    const segs = fb?.segments(b.key);
    // a paragraph another reader marked: a bar in their colour beside it
    // (its own element: a line's ::after is its hyphen, its ::before one's own mark's bar)
    const fm = fb?.marked(b.key)[0];
    if (fm) html += `<div class="fmb" style="top:${top}px;left:-18px;--fmc:var(--r${fb!.colourOf(fm.r)})" aria-hidden="true"></div>`;
    html += `<div class="${cls}" style="${style}" data-b="${bi}" data-s="${u[o + F.s]}">${bullet}${inline(b, u[o + F.s], u[o + F.e], anns, segs)}</div>`;
    html += noteDots(anns, u[o + F.s], u[o + F.e], top, M, fb ? fb.written(b.key).map(x => ({ id: x.r + '|' + x.n.id, s: x.n.s, colour: fb.colourOf(x.r) })) : undefined);
  }
  return html;
}

function headHTML(book: BookData, si: number, M: Metrics): string {
  const s = book.sections[si];
  const label = s.label || (s.title ? '' : `Chapter ${s.num}`);
  return `<header class="chead" style="height:${M.headRows * M.lh}px">
    ${s.part ? `<div class="part">${esc(s.part)}</div>` : ''}
    ${label ? `<div class="label">${esc(label)}</div>` : ''}
    ${s.title ? `<h2 class="title">${esc(s.title)}</h2>` : ''}
  </header>`;
}

export function chapName(book: BookData, si: number) {
  const s = book.sections[si];
  if (!s) return '';
  return s.label || s.title || `Chapter ${s.num}`;
}

export function chapTitle(book: BookData, si: number) {
  const s = book.sections[si];
  if (!s) return '';
  if (s.label && s.title) return `${s.label} · ${s.title}`;
  return s.label || s.title || `Chapter ${s.num}`;
}

export interface LeafCtx {
  totalLines: number;
  N: number;
}

/** Whole columns that are not running text. */
export function leafHTML(strip: Strip, it: Item, ctx: LeafCtx): string {
  const b = strip.book;
  switch (it.type) {
    case 'title':
      return `<section class="leaf title-leaf">
        <div class="tl">
          ${b.author ? `<p class="tl-author">${esc(b.author)}</p>` : ''}
          <h1 class="tl-title">${esc(b.title)}</h1>
          ${b.subtitle ? `<p class="tl-sub">${esc(b.subtitle)}</p>` : ''}
        </div>
        <p class="tl-hint keys-only">Space turns the page; → moves one column, held it glides. M for the map, ? for every key.</p>
        <p class="tl-hint touch-only">Tap near the edges to turn the page, the middle for the menu. Pinch in for the map.</p>
      </section>`;
    case 'colophon':
      // an extract on someone else's page, with a way on (kit/volumen.js: end-href)
      if (embedOpts.endHref) return `<section class="leaf colophon">
        <p class="eyebrow">The end of this extract</p>
        <p class="co-title">${esc(b.title)}</p>
        <p class="co-way"><a class="btn primary" href="${esc(embedOpts.endHref)}" target="_top" rel="noopener">${esc(embedOpts.endLabel ?? 'Continue reading')}</a></p>
      </section>`;
      return `<section class="leaf colophon">
        <p class="eyebrow">Colophon</p>
        <p class="co-finis">Finis</p>
        <p class="co-title">${esc(b.title)}</p>
        <p class="co-stich">${b.words.toLocaleString('en-GB')} words<br>${ctx.totalLines.toLocaleString('en-GB')} lines in ${ctx.N.toLocaleString('en-GB')} columns at this setting</p>
        <p class="note">Scribes often ended a manuscript with its count of lines, so a buyer could check that nothing was missing.</p>
      </section>`;
    default:
      return '';
  }
}
