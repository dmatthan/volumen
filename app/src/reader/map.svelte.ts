import { copyText } from '../ui/clipboard';
import type { Reader } from './reader.svelte';
import { ui, toast } from './reader.svelte';
import { F, FIELDS, Flag } from './strip';
import { T, readTokens, hueAt } from './tokens';
import { chapName, chapTitle } from './render';
import { reduceMotion } from './settings.svelte';
import { markdownOf, type NoteEntry } from './notebook';
import { notesMarkdown } from './notesmd';
import { hint } from './hints';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/** A notebook entry with the column it is in now. */
export type NoteItem = NoteEntry & { k: number };

/** Reactive map state for the chrome. */
export const mp = $state({
  uiIn: false,
  view: 'strip' as 'strip' | 'marks',
  sel: null as number | null,
  here: 0,
  infoT: '',
  infoS: '',
  goLabel: 'Read from here',
  chapters: [] as { sec: number; num: string; title: string; read: boolean; current: boolean; feedback: number }[],
  gauge: { read: 0, ticks: [] as number[], marks: [] as number[], hits: [] as number[], here: 0 },
  notes: [] as NoteItem[],
  /** The find field is showing (asked for, or a search is under way). */
  find: false,
  /** Matches per section, while a search is on. */
  secHits: {} as Record<number, number>,
});

export class MapCtl {
  cv!: HTMLCanvasElement;
  el!: HTMLElement;
  strip!: HTMLElement;
  win!: HTMLElement;
  bg!: HTMLElement;
  private ctx!: CanvasRenderingContext2D;
  private s = 1; private cx = 0; private sx = 0; private cy = 0;
  private W = 0; private dpr = 1;
  private read = { sx: 0, cy: 0 }; private home = { sx: 0, cy: 0 };
  private sMap = 0.1; private stripTop = 0; private stripBot = 0;
  private raf = 0; private glideRaf = 0;
  busy = false;
  private drag: { x0: number; cx0: number; moved: boolean; smp: [number, number][] } | null = null;

  constructor(private r: Reader) {}

  mount(el: HTMLElement, cv: HTMLCanvasElement, strip: HTMLElement, win: HTMLElement, bg: HTMLElement) {
    this.el = el; this.cv = cv; this.strip = strip; this.win = win; this.bg = bg;
    this.ctx = cv.getContext('2d')!;
    this.bind();
  }

  private animate(dur: number, fn: (t: number) => void, done?: () => void) {
    cancelAnimationFrame(this.raf);
    const t0 = performance.now();
    const tick = (now: number) => {
      const t = dur <= 1 ? 1 : clamp((now - t0) / dur, 0, 1);
      fn(t);
      if (t < 1) this.raf = requestAnimationFrame(tick); else done?.();
    };
    this.raf = requestAnimationFrame(tick);
  }

  private geom() {
    const M = this.r.M;
    const mr = this.el.getBoundingClientRect(), sr = this.r.stage.getBoundingClientRect(), st = this.strip.getBoundingClientRect();
    this.W = mr.width;
    this.read = { sx: sr.left - mr.left + M.x0 + M.focusW / 2, cy: sr.top - mr.top + M.y0 + M.colH / 2 };
    this.home = { sx: mr.width / 2, cy: st.top - mr.top + st.height / 2 + 8 };
    this.stripTop = st.top - mr.top; this.stripBot = st.bottom - mr.top;
    this.sMap = clamp(Math.min(Math.max(36, mr.width / 16) / M.P, (st.height - 84) / M.colH), 0.035, 0.32);
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    // reassigning a canvas's size reallocates it even when unchanged: only on a real change
    const w = Math.round(mr.width * this.dpr), h = Math.round(mr.height * this.dpr);
    if (this.cv.width !== w || this.cv.height !== h) { this.cv.width = w; this.cv.height = h; }
  }

  private build() {
    const r = this.r, strip = r.strip!, book = r.book!;
    const N = strip.N, pct = (k: number) => (k / Math.max(1, N - 1)) * 100;
    const hereIt = strip.itemAt(mp.here);
    // where readers' notes are (a writer's book with feedback): a count by the chapter
    const fbIn = r.fb?.size ? r.fb.perSection() : null;
    mp.chapters = book.sections.map((s, sec) => {
      let n = 0, seen = 0;
      for (const b of s.blocks) { if (b.k === 8) continue; n++; if (r.seen.has(b.key)) seen++; }
      return { sec, num: s.k === 1 ? s.num : '', title: s.label && s.title ? s.title : chapTitle(book, sec), read: n > 0 && seen / n > 0.95, current: hereIt?.sec === sec, feedback: fbIn?.get(sec) ?? 0 };
    });
    mp.gauge = {
      read: pct(mp.here),
      ticks: book.sections.map((s, i) => (s.k === 1 ? pct(strip.secStart[i]) : -1)).filter(x => x >= 0),
      marks: [...[...r.marks].map(k => strip.resolve({ key: k, off: 0 })), ...(r.ann?.list ?? []).filter(a => !a.lost).map(a => strip.resolve({ key: a.key, off: a.s }))].map(pct),
      hits: this.hitTicks(),
      here: pct(mp.here),
    };
  }

  /* ---------- find, from the map ---------- */

  /** The search's hits on the gauge: one tick per fifth of a percent at most. */
  private hitTicks() {
    const f = this.r.finder, N = this.r.strip!.N;
    const seen = new Set<number>();
    for (const h of f.hits) seen.add(Math.round((f.colOf(h) / Math.max(1, N - 1)) * 500) / 5);
    return [...seen];
  }

  /** New results: their ticks, and the current one chosen on the map. */
  hitsChanged() {
    if (!ui.mapOpen || !this.r.strip) return;
    mp.gauge = { ...mp.gauge, hits: this.hitTicks() };
    const f = this.r.finder;
    const per: Record<number, number> = {};
    for (const h of f.hits) per[h.sec] = (per[h.sec] ?? 0) + 1;
    mp.secHits = per;
    if (f.cur >= 0) this.select(f.colOf(f.hits[f.cur]), 'center');
    else { this.info(); this.draw(); }
  }

  /** The next or previous match, chosen on the map (the trip waits for Enter). */
  stepHit(d: number) {
    const f = this.r.finder;
    if (!f.hits.length) return;
    this.select(f.pick(f.cur + d), 'center');
  }

  focusFind() {
    if (mp.view !== 'strip') return;
    mp.find = true;
    queueMicrotask(() => { const i = this.el.querySelector('.m-find input') as HTMLInputElement | null; i?.focus(); i?.select(); });
  }

  info() {
    const strip = this.r.strip!, book = this.r.book!;
    const k = mp.sel ?? mp.here;
    const it = strip.itemAt(k);
    let t = '', s = '';
    if (it) {
      if (it.type === 'title') { t = book.title; s = 'Title'; }
      else if (it.type === 'colophon') { t = 'Colophon'; s = 'The end of the book'; }
      else { t = chapTitle(book, it.sec); s = `Column ${k - it.start + 1} of ${it.n}`; }
    }
    mp.infoT = t;
    const f = this.r.finder, h = f.hits[f.cur];
    if (h && f.colOf(h) === k) s = f.phrase ? `Match ${f.cur + 1} of ${f.total}` : `Paragraph ${f.cur + 1} of ${f.total} with every word`;
    mp.infoS = (k === mp.here ? 'Where you are · ' : '') + s;
    const sel = mp.sel != null ? strip.itemAt(mp.sel) : null;
    mp.goLabel = sel && sel.type === 'sect' && mp.sel === sel.start && book.sections[sel.sec].k === 1 ? `Read from ${chapName(book, sel.sec)}` : 'Read from here';
  }

  open() {
    const r = this.r;
    if (ui.mapOpen || !r.strip || ui.sheet) return;
    r.pickEnd();
    ui.mapOpen = true; this.busy = true;
    mp.view = 'strip'; mp.sel = null; mp.here = r.cur; mp.uiIn = false;
    mp.find = !!r.finder.query.trim();
    this.build(); this.info();
    requestAnimationFrame(() => {
      this.geom();
      readTokens();
      this.paperCache.clear(); this.numW.clear(); this.titleFit.clear(); this.lastBand = [-1e6, 1e6];
      this.cx = r.cur * r.M.P + r.M.focusW / 2;
      const dur = reduceMotion() ? 1 : 480;
      const reader = r.stage.parentElement!;
      this.cv.style.opacity = '0';
      this.animate(dur, t => {
        const e = ease(t);
        this.s = lerp(1, this.sMap, e); this.sx = lerp(this.read.sx, this.home.sx, e); this.cy = lerp(this.read.cy, this.home.cy, e);
        this.bg.style.opacity = String(clamp(t * 3, 0, 1));
        reader.style.opacity = String(1 - clamp(t * 4, 0, 1));
        this.cv.style.opacity = String(clamp(t * 6, 0, 1));
        this.draw();
      }, () => {
        this.busy = false; mp.uiIn = true; this.el.focus({ preventScroll: true });
        hint('map-keys', '← → choose a column, [ ] a chapter, Enter travels there. / finds words in the book.');
      });
    });
  }

  close(dest: number | null = null) {
    const r = this.r;
    if (!ui.mapOpen || this.busy) return;
    if (dest == null) dest = mp.here;
    this.busy = true; mp.uiIn = false;
    // a search made here goes on in the reader, its marks and its bar with it
    if (r.finder.query.trim() && r.finder.total) r.finder.show();
    cancelAnimationFrame(this.glideRaf);
    if (mp.view !== 'strip') { mp.view = 'strip'; }
    const M = r.M;
    const to = dest * M.P + M.focusW / 2, from = this.cx;
    const dist = Math.abs(to - from) / M.P;
    const reader = r.stage.parentElement!;
    // the reader moves to the destination now, under the map; its columns are built one
    // per frame during the trip (it is hidden until the zoom-in), not all in this frame
    r.surface.setLazy(true);
    r.jump(dest);
    const zoomIn = () => {
      this.geom();
      const dur = reduceMotion() ? 1 : 460;
      this.animate(dur, t => {
        const e = ease(t);
        this.s = lerp(this.sMap, 1, e); this.sx = lerp(this.home.sx, this.read.sx, e); this.cy = lerp(this.home.cy, this.read.cy, e);
        this.bg.style.opacity = String(1 - clamp((t - 0.5) * 2.6, 0, 1));
        // before the page shows again, anything not yet built is built
        if (t > 0.55) r.surface.setLazy(false);
        reader.style.opacity = String(clamp((t - 0.62) * 3.2, 0, 1));
        this.cv.style.opacity = String(1 - clamp((t - 0.82) * 6, 0, 1));
        this.draw();
      }, () => {
        r.surface.setLazy(false);
        ui.mapOpen = false; this.busy = false;
        reader.style.opacity = ''; this.bg.style.opacity = '0';
        // the canvas holds the window's size in pixels (four times over at 2×): given back
        // while the map is closed, made again when it opens
        this.cv.width = 0; this.cv.height = 0;
        r.stage.focus({ preventScroll: true });
      });
    };
    if (dist < 0.01 || reduceMotion()) { this.cx = to; zoomIn(); return; }
    // the trip is always animated across the distance: a long way looks long
    const dur = clamp(320 + 300 * Math.log2(1 + dist), 380, 2200);
    const dip = Math.min(0.62, Math.log10(1 + dist) / 3.4);
    const s0 = this.s;
    this.animate(dur, t => {
      const e = ease(t);
      this.cx = lerp(from, to, e);
      this.s = s0 * (1 - dip * Math.sin(Math.PI * t));
      this.draw();
    }, zoomIn);
  }

  select(k: number, pan: boolean | 'center' = false) {
    const r = this.r;
    mp.sel = clamp(k, 0, r.strip!.N - 1);
    this.info();
    if (pan) {
      const to = mp.sel * r.M.P + r.M.colW / 2, from = this.cx;
      const half = this.W / 2 / this.s;
      if (Math.abs(to - from) > half * 0.75 || pan === 'center') {
        const dist = Math.abs(to - from) / r.M.P;
        this.animate(reduceMotion() ? 1 : clamp(260 + 160 * Math.log2(1 + dist), 260, 900), t => { this.cx = lerp(from, to, ease(t)); this.draw(); });
        return;
      }
    }
    this.draw();
  }

  selectChapter(d: number) {
    const strip = this.r.strip!, book = this.r.book!;
    const base = mp.sel ?? mp.here;
    const cur = strip.itemAt(base)?.sec ?? 0;
    let s = cur + d;
    while (s >= 0 && s < book.sections.length && book.sections[s].k !== 1) s += d;
    if (d < 0 && strip.secStart[cur] != null && base > strip.secStart[cur] && book.sections[cur]?.k === 1) s = cur;
    if (s < 0 || s >= book.sections.length) return;
    this.select(strip.secStart[s], 'center');
  }

  setView(v: 'strip' | 'marks') {
    mp.view = v;
    if (v === 'marks') this.buildNotebook();
    this.draw();
  }

  /** Everything the reader has added to this book, in reading order. */
  buildNotebook() {
    const r = this.r, strip = r.strip!;
    mp.notes = r.notebook().map(e => ({ ...e, k: strip.resolve(e.at) }));
  }

  /** The notebook as Markdown, grouped by chapter, that can be put back on the book. */
  markdown(items: NoteItem[]): string {
    const book = this.r.book!;
    return notesMarkdown([markdownOf({ id: book.id, title: book.title, author: book.author }, items)]);
  }

  /** One highlight to paste anywhere: its words, where they are from, the note. */
  citeEntry(it: NoteItem): string {
    const book = this.r.book!;
    const words = it.file?.quote ?? it.quote.replace(/ \/ /g, '\n');
    return `“${words}”\n— ${book.author ? book.author + ', ' : ''}${book.title}, ${it.where.replace(/\s+·\s+/g, ': ')}${it.note ? '\n\n' + it.note : ''}`;
  }

  /** Where a notebook entry sits, as a column to travel to. */
  columnOf(it: NoteItem) { return Math.floor(it.k); }

  cite(key: string) {
    const r = this.r, book = r.book!;
    const hit = r.strip!.keyIndex.get(key);
    if (!hit) return '';
    const blk = book.sections[hit[0]].blocks[hit[1]];
    return `“${blk.t.replace(/\n/g, ' / ')}”\n— ${book.author ? book.author + ', ' : ''}${book.title}, ${chapName(book, hit[0])}`;
  }

  async copy(text: string) {
    toast((await copyText(text)) ? 'Copied' : 'This browser would not copy. Select the text instead.');
  }

  /* ---------- drawing ---------- */
  draw() {
    const r = this.r, strip = r.strip!, M = r.M, ctx = this.ctx, s = this.s;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const top = this.cy - (M.colH * s) / 2, h = M.colH * s;
    const pad = Math.max(5, 16 * s);
    // only the band the strip was drawn in, and the one it is drawn in now, is cleared:
    // the rest of the canvas stays empty, and clearing all of a large one costs WebKitGTK
    // (Cairo) a good part of each frame
    const band: [number, number] = mp.view === 'marks' && !this.busy ? [0, 0] : [top - pad - 34, top + h + pad + 44];
    const [ca, cz] = [Math.min(band[0], this.lastBand[0]), Math.max(band[1], this.lastBand[1])];
    ctx.clearRect(0, Math.floor(ca), this.W, Math.ceil(cz - ca) + 1);
    this.lastBand = band;
    if (mp.view === 'marks' && !this.busy) return;
    const X = (wx: number) => (wx - this.cx) * s + this.sx;
    const k0 = Math.max(0, Math.floor((this.cx - this.sx / s) / M.P) - 1);
    const k1 = Math.min(strip.N - 1, Math.ceil((this.cx + (this.W - this.sx) / s) / M.P) + 1);
    // paper: one fill per hue step (the hue drifts slowly, so neighbours share a colour)
    let runK = k0, runHue = -1;
    const flushPaper = (end: number) => {
      if (runHue < 0) return;
      const xa = X(runK * M.P - M.G / 2), xb = X(end * M.P - M.G / 2);
      ctx.fillStyle = this.paper(runHue);
      ctx.fillRect(Math.floor(xa), top - pad, Math.ceil(xb - xa) + 1, h + pad * 2);
    };
    for (let k = k0; k <= k1 + 1; k++) {
      const hq = k <= k1 ? Math.round(hueAt(strip.frac(k)) * 2) / 2 : -2;
      if (hq !== runHue) { flushPaper(k); runK = k; runHue = hq; }
    }
    if (s < 0.7) {
      ctx.fillStyle = T.read;
      ctx.beginPath();
      for (let k = k0; k <= k1; k++) if (r.colSeen(k)) ctx.rect(Math.floor(X(k * M.P - M.G / 2)), top - pad, Math.ceil(M.P * s) + 1, h + pad * 2);
      ctx.fill();
    }
    // the text's shape: every bar goes into one of a few paths, each filled once
    const prose = new Path2D(), heads = new Path2D(), verse = new Path2D(), marked = new Path2D(), found = new Path2D();
    // highlights in their colours; a note is a dot in the margin beside its line (one's
    // own in its highlight's colour, other readers' in theirs)
    const lit = [new Path2D(), new Path2D(), new Path2D(), new Path2D()];
    const dots: { x: number; y: number; c: string }[] = [];
    const ann = r.ann, fb = r.fb?.size ? r.fb : null;
    const dotR = Math.max(1.6, 3.2 * s);
    const finder = r.finder, finding = finder.hits.length > 0;
    const barH = Math.max(0.75, M.lh * 0.4 * s);
    for (let k = k0; k <= k1; k++) {
      const x = X(k * M.P), it = strip.itemAt(k)!;
      if (it.type === 'sect') {
        const L = strip.linesAt(k);
        if (k === it.start && strip.book.sections[it.sec].k === 1)
          heads.rect(x + M.colW * s * 0.25, top + (M.headRows - 2) * M.lh * s, M.colW * s * 0.5, Math.max(1, M.lh * 0.5 * s));
        if (!L) continue;
        const sec = strip.book.sections[L.sec];
        const u = L.sl.u, f = L.sl.f;
        for (let j = L.from; j < L.to; j++) {
          const o = j * FIELDS, fl = u[o + F.flags] & 0xffff;
          if (fl & Flag.Break) continue;
          const avail = f[o + F.avail];
          const lw = fl & Flag.Justify ? avail : Math.min(f[o + F.natural], avail);
          const ox = fl & Flag.Right ? avail - lw : fl & Flag.Center ? (avail - lw) / 2 : 0;
          const key = sec.blocks[u[o + F.block]].key;
          let path = r.marks.size && r.marks.has(key) ? marked : fl & Flag.Head ? heads : fl & (Flag.Verse | Flag.Quote) ? verse : prose;
          const ls = u[o + F.s], le = u[o + F.e];
          const y = top + (u[o + F.row] * M.lh + M.lh * 0.3) * s;
          const here = ann?.of(key)?.filter(a => !a.lost && a.s < le && a.e > ls);
          if (here?.length) {
            path = lit[(here[0].color || 1) - 1] ?? lit[0];
            const noted = here.find(a => a.note);
            if (noted) dots.push({ x: x - dotR * 2.4, y: y + barH / 2, c: T.hs[(noted.color || 1) - 1] ?? T.accent });
          }
          if (fb) for (const v of fb.written(key)) if (v.n.s < le && v.n.e > ls) { dots.push({ x: x - dotR * 2.4, y: y + barH / 2, c: T.rd[fb.colourOf(v.r) - 1] ?? T.accent }); break; }
          if (finding) {
            const hs = finder.of(key);
            if (hs?.some(a => a.s < le && a.e > ls)) path = found;
          }
          path.rect(x + (f[o + F.x] + ox) * s, y, Math.max(0.6, lw * s), barH);
        }
      } else this.leafGlyph(it.type, x, top, s);
    }
    ctx.fillStyle = T.ink;
    ctx.globalAlpha = 0.5; ctx.fill(prose);
    ctx.globalAlpha = 0.78; ctx.fill(heads);
    ctx.globalAlpha = 0.4; ctx.fill(verse);
    ctx.fillStyle = T.accent; ctx.globalAlpha = 0.95; ctx.fill(marked);
    lit.forEach((p, i) => { ctx.fillStyle = T.hs[i] || T.accent; ctx.fill(p); });
    for (const d of dots) { ctx.fillStyle = d.c; ctx.beginPath(); ctx.arc(d.x, d.y, dotR, 0, Math.PI * 2); ctx.fill(); }
    if (finding) {
      // a match's line stands out wide enough to see from far off
      ctx.globalAlpha = 1; ctx.fill(found);
      if (s < 0.2) { ctx.strokeStyle = T.accent; ctx.lineWidth = 2; ctx.globalAlpha = 0.5; ctx.stroke(found); }
    }
    ctx.globalAlpha = 1;
    const box = (k: number | null, color: string, lw: number, dash?: number[]) => {
      if (k == null || k < k0 || k > k1) return;
      ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; if (dash) ctx.setLineDash(dash);
      const o = Math.max(3, 8 * s);
      ctx.strokeRect(X(k * M.P) - o, top - o, M.focusW * s + o * 2, h + o * 2); ctx.restore();
    };
    box(mp.here, T.accent, 1.8);
    if (mp.sel != null && mp.sel !== mp.here) box(mp.sel, T.ink, 1.8, [4, 3]);
    const la = clamp((0.45 - s) / 0.2, 0, 1);
    if (la > 0) {
      ctx.globalAlpha = la; ctx.textBaseline = 'alphabetic';
      const y = top - pad - 10;
      // the chapters in view; each font is set once, and widths and shortened titles are
      // measured once and kept (they were measured again every frame)
      const starts = strip.secStart.map((st, sec) => ({ st, sec })).filter(o => strip.book.sections[o.sec].k === 1);
      const shown: { x0: number; avail: number; sec: number }[] = [];
      starts.forEach((o, i) => {
        const x0 = X(o.st * M.P);
        const xNext = i + 1 < starts.length ? X(starts[i + 1].st * M.P) : X(strip.N * M.P);
        if (xNext < -10 || x0 > this.W + 10) return;
        shown.push({ x0, avail: xNext - x0 - 12, sec: o.sec });
      });
      ctx.fillStyle = T.ink;
      for (const o of shown) ctx.fillRect(o.x0 - 0.5, y + 4, 1, top - pad - y - 4);
      ctx.font = `650 13px ${T.ui}`;
      const nws = shown.map(o => {
        const num = strip.book.sections[o.sec].num;
        let w = this.numW.get(num);
        if (w == null) { w = ctx.measureText(num).width; this.numW.set(num, w); }
        ctx.fillText(num, o.x0 + 5, y);
        return w;
      });
      ctx.font = `500 13px ${T.ui}`;
      ctx.fillStyle = T.ink2;
      shown.forEach((o, i) => {
        const sec = strip.book.sections[o.sec];
        const title = sec.label && sec.title ? sec.title : sec.title || '';
        const max = o.avail - nws[i] - 12;
        if (!title || max <= 24) return;
        // widths in 4 px steps share an entry
        const key = `${o.sec}|${Math.floor(max / 4)}`;
        let t = this.titleFit.get(key);
        if (t == null) {
          t = title;
          const room = Math.floor(max / 4) * 4;
          if (ctx.measureText(t).width > room) {
            // the longest start that fits with its ellipsis, by halving
            let lo = 1, hi = title.length;
            while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(title.slice(0, mid) + '…').width <= room) lo = mid; else hi = mid - 1; }
            t = title.slice(0, Math.max(2, lo)).trimEnd() + '…';
          }
          this.titleFit.set(key, t);
        }
        ctx.fillText(t, o.x0 + 5 + nws[i] + 7, y);
      });
      if (mp.here >= k0 && mp.here <= k1) {
        ctx.font = `650 12px ${T.ui}`; ctx.fillStyle = T.accent; ctx.textAlign = 'center';
        ctx.fillText('YOU ARE HERE', X(mp.here * M.P + M.focusW / 2), top + h + pad + 28);
        ctx.textAlign = 'start';
      }
      ctx.globalAlpha = 1;
    }
    this.gaugeWindow();
  }

  private paperCache = new Map<number, string>();
  private numW = new Map<string, number>();
  private titleFit = new Map<string, string>();
  private lastBand: [number, number] = [-1e6, 1e6];
  private paper(hue: number) {
    let c = this.paperCache.get(hue);
    if (!c) { c = `oklch(${T.pl} ${T.pc} ${hue})`; this.paperCache.set(hue, c); }
    return c;
  }

  private leafGlyph(type: string, x: number, top: number, s: number) {
    const M = this.r.M, ctx = this.ctx, w = M.colW * s, h = M.colH * s, cx = x + w / 2, cy = top + h / 2;
    const bar = (bx: number, by: number, bw: number, bh: number, a: number, c?: string) => { ctx.globalAlpha = a; ctx.fillStyle = c || T.ink; ctx.fillRect(bx, by, Math.max(0.8, bw), Math.max(0.8, bh)); };
    if (type === 'title') {
      bar(cx - w * 0.2, top + h * 0.3, w * 0.4, h * 0.012, 0.5);
      bar(cx - w * 0.33, top + h * 0.35, w * 0.66, h * 0.03, 0.85);
      bar(cx - w * 0.26, top + h * 0.395, w * 0.52, h * 0.03, 0.85);
    } else if (type === 'colophon') {
      bar(cx - w * 0.15, cy - h * 0.05, w * 0.3, h * 0.035, 0.85);
      bar(cx - w * 0.24, cy + h * 0.02, w * 0.48, h * 0.014, 0.5);
    }
    ctx.globalAlpha = 1;
  }

  private gaugeWindow() {
    const r = this.r;
    const total = (r.strip!.N - 1) * r.M.P || 1;
    const half = this.W / 2 / this.s;
    const l = clamp((this.cx - half) / total, 0, 1), rr = clamp((this.cx + half) / total, 0, 1);
    this.win.style.left = l * 100 + '%'; this.win.style.width = Math.max(0.6, (rr - l) * 100) + '%';
  }

  /** The gauge: the whole book at once. */
  gaugeAt(clientX: number, rect: DOMRect) {
    const r = this.r;
    cancelAnimationFrame(this.raf); cancelAnimationFrame(this.glideRaf);
    this.cx = clamp((clientX - rect.left) / rect.width, 0, 1) * (r.strip!.N - 1) * r.M.P + r.M.colW / 2;
    this.draw();
  }

  key(e: KeyboardEvent): boolean {
    const k = e.key;
    if (k === 'Escape' || k === 'm' || k === 'M') { this.close(mp.here); return true; }
    if (this.busy) return true;
    if (k === 'Tab' && !e.shiftKey && (e.target as Element)?.closest?.('#map') == null) return false;
    if (mp.view !== 'strip') {
      if (k === '/' && !(e.target as Element)?.closest?.('input')) { (this.el.querySelector('.nb-filter') as HTMLElement)?.focus(); return true; }
      return false;
    }
    if (k === '/') { this.focusFind(); return true; }
    if ((k === 'n' || k === 'N') && this.r.finder.hits.length) { this.stepHit(k === 'n' ? 1 : -1); return true; }
    // Enter travels to the chosen column, also from a chapter row just clicked; only the
    // map's own action buttons keep Enter for themselves
    if (k === 'Enter' && mp.sel != null && !(e.target as Element)?.closest?.('.m-foot, .m-head')) { this.close(mp.sel); return true; }
    if ((e.target as Element)?.closest?.('button') && (k === 'Enter' || k === ' ')) return false;
    const base = mp.sel ?? mp.here;
    if (k === 'ArrowRight' || k === 'l') { this.select(base + (e.shiftKey ? 10 : 1), true); return true; }
    if (k === 'ArrowLeft' || k === 'h') { this.select(base - (e.shiftKey ? 10 : 1), true); return true; }
    if (k === 'L') { this.select(base + 10, true); return true; }
    if (k === 'H') { this.select(base - 10, true); return true; }
    if (k === ']') { this.selectChapter(1); return true; }
    if (k === '[') { this.selectChapter(-1); return true; }
    if (k === '0' || k === 'Home') { this.select(mp.here, 'center'); return true; }
    if (k === 'Enter' && mp.sel != null) { this.close(mp.sel); return true; }
    return false;
  }

  private bind() {
    const cv = this.cv;
    cv.addEventListener('pointerdown', e => {
      if (this.busy || mp.view !== 'strip') return;
      try { cv.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      cancelAnimationFrame(this.glideRaf); cancelAnimationFrame(this.raf);
      this.drag = { x0: e.clientX, cx0: this.cx, moved: false, smp: [[e.clientX, performance.now()]] };
    });
    cv.addEventListener('pointermove', e => {
      const d = this.drag; if (!d) return;
      const dx = e.clientX - d.x0;
      if (Math.abs(dx) > 5) d.moved = true;
      this.cx = clamp(d.cx0 - dx / this.s, 0, this.r.strip!.N * this.r.M.P);
      d.smp.push([e.clientX, performance.now()]); if (d.smp.length > 6) d.smp.shift();
      this.draw();
    });
    cv.addEventListener('pointerup', e => {
      const d = this.drag; this.drag = null; if (!d) return;
      if (!d.moved) {
        const y = e.clientY - this.el.getBoundingClientRect().top;
        if (y >= this.stripTop - 30 && y <= this.stripBot + 10) {
          const wx = this.cx + (e.clientX - this.el.getBoundingClientRect().left - this.sx) / this.s;
          const k = Math.floor((wx + this.r.M.G / 2) / this.r.M.P);
          if (k >= 0 && k < this.r.strip!.N) this.select(k);
        }
        return;
      }
      const [a, z] = [d.smp[0], d.smp[d.smp.length - 1]];
      let v = z[1] > a[1] ? -(z[0] - a[0]) / (z[1] - a[1]) / this.s : 0;
      let last = performance.now();
      const glide = (now: number) => {
        const dt = now - last; last = now;
        this.cx = clamp(this.cx + v * dt, 0, this.r.strip!.N * this.r.M.P);
        v *= Math.pow(0.94, dt / 16);
        this.draw();
        if (Math.abs(v) * this.s > 0.02) this.glideRaf = requestAnimationFrame(glide);
      };
      if (!reduceMotion()) this.glideRaf = requestAnimationFrame(glide);
    });
    cv.addEventListener('pointercancel', () => { this.drag = null; });
    this.el.addEventListener('wheel', e => {
      if (mp.view !== 'strip' || this.busy) return;
      if ((e.target as Element).closest('.m-list, .m-marks')) return;
      e.preventDefault();
      const v = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      this.cx = clamp(this.cx + ((v * (e.deltaMode === 1 ? 16 : 1)) / this.s) * 0.9, 0, this.r.strip!.N * this.r.M.P);
      this.draw();
    }, { passive: false });
  }
}
