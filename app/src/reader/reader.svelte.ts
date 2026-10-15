import { edges } from '../ui/edges';
import { RICH, measureRich, richURL } from './rich';
import type { BookData, Core, LayoutParams } from '../core/types';
import { kv, flushKV } from '../core/kv';
import { metrics, insets, type Look, type Metrics } from './geometry';
import { Strip, parseLayout, F, FIELDS, Flag, type Anchor } from './strip';
import { columnHTML, leafHTML, chapName, esc } from './render';
import { Surface } from './surface';
import { Motion } from './motion';
import { readTokens, hueAt } from './tokens';
import { calibrate } from './calibrate';
import { settings, reduceMotion, SIZES } from './settings.svelte';
import { themes, themeById, resolve, loadFamily, fontsReady, type Resolved } from './themes.svelte';
import { Annotations } from './annotations';
import { Finder } from './find.svelte';
import { notebookOf, saveDigest } from './notebook';
import { Feedback, parseNotes, targetOf, notesFile } from './feedback';
import { sendQuietly } from '../core/service';
import { isMine, restoreInto, restored } from './restore';
import { hint } from './hints';

export type Sheet = null | 'settings' | 'theme' | 'help' | 'remove' | 'note' | 'book' | 'shelf' | 'send' | 'share' | 'invite' | 'welcome';

/** A text selection in the book: from (sec, block, offset) to (sec, block, offset). */
export interface Sel { a: [number, number, number]; z: [number, number, number] }

/** Reactive state the chrome reads. */
export const ui = $state({
  view: 'library' as 'library' | 'reader',
  title: '',
  runhead: '',
  sheet: null as Sheet,
  mapOpen: false,
  toast: '',
  toastOn: false,
  busy: '',
  /** Columns in focus right now, and whether the chosen layout had to give way. */
  cols: 1,
  /** A phone-sized window: one column as a spread, the touch conventions. */
  phone: false,
  /** Bumps when a tap asks the reader's bar to show or hide (touch). */
  barToggle: 0,
  colsReduced: false,
  /** Bumps when the library should be re-read. */
  libVersion: 0,
  /** An invitation to share books, from its link, until it is used (InviteSheet). */
  invite: '',
  /** A book just arrived by link: who sent it (WelcomeSheet, once per book). */
  welcome: null as null | { by: string },
  /** Bumps when the whole book's layout arrives (column counts become exact). */
  layoutVersion: 0,
  /** The chip offered after a selection or on a highlight. */
  chip: null as null | { x: number; y: number; sel: Sel | null; ann: string | null },
  /** The annotation whose note is being edited. */
  noteFor: '' as string,
  /** A book note shown beside its marker: its index, and where (stage px). */
  bookNote: null as null | { i: number; x: number; y: number; below: boolean },
  /** An image shown large: its index and where it sits on the page (viewport px). */
  lightbox: null as null | { i: number; rect: { x: number; y: number; w: number; h: number } },
  /** Bumps when annotations change (notebook, gauge). */
  annVersion: 0,
  /** Notes shown beside their lines: on hover (one, until the pointer leaves) or pinned
   *  (by a press on a dot, or ; for every note in view). Any movement puts them away. */
  sideNotes: null as null | { ids: string[]; pinned: boolean },
});

let toastT = 0;
export function toast(msg: string, ms = 2600) {
  ui.toast = msg; ui.toastOn = true;
  clearTimeout(toastT); toastT = window.setTimeout(() => (ui.toastOn = false), ms);
}

/** Interaction constants: these are the point of the reader. */
const CRUISE_AFTER = 260;       // ms a key or press is held before the tap flows into a cruise
const WHEEL_QUIET = 90;         // ms without wheel input that end a trackpad gesture
const WHEEL_LOCK = 200;         // ms of quiet before input is read again after a takeover
const SELECT_AFTER = 300;      // ms held still before the press selects a word (moving first moves the sheet)


export class Reader {
  core: Core;
  book: BookData | null = null;
  strip: Strip | null = null;
  M!: Metrics;
  /** First column of the focus window, at rest. */
  cur = 0;
  marks = new Set<string>();
  ann: Annotations | null = null;
  seen = new Set<string>();
  /** Columns seen since the book was opened (for the hints). */
  visited = new Set<number>();
  reading = false;

  stage!: HTMLElement;
  surface!: Surface;
  motion!: Motion;

  private gen = 0;
  /** Bumps whenever the text is set with new parameters; a whole-book layout that
   *  arrives for older parameters is dropped, one for the current ones always applies. */
  private paramGen = 0;
  private shownK = -1;
  private keyHeld: string | null = null; private keyHoldT = 0;
  private dwellT = 0; private saveT = 0; private seenT = 0;
  private wheel: { kind: 'notch' | 'direct' | 'locked'; last: number; mags: number[]; t0: number; endT: number; acc: number; log: [number, number][]; from: number } | null = null;
  pick: { idx: number } | null = null;
  onMapOpen: () => void = () => {};

  constructor(core: Core) { this.core = core; }

  /* ---------- mounting ---------- */
  mount(stage: HTMLElement, track: HTMLElement) {
    this.stage = stage;
    this.surface = new Surface(track, () => ({
      strip: this.strip!, M: this.M,
      column: k => this.columnHTML(k),
      isLeaf: k => this.strip!.itemAt(k)?.type !== 'sect',
    }));
    this.motion = new Motion({
      min: () => 0,
      max: () => Math.max(0, (this.strip?.N ?? 1) - (this.M?.N ?? 1)),
      spread: () => this.M?.N ?? 1,
      reduced: reduceMotion,
      frame: (p, v) => this.frame(p, v),
      rest: k => this.rest(k),
    });
    this.bindInput();
    new ResizeObserver(() => {
      if (!this.book) return;
      if (this.opening) { this.resizedWhileOpening = true; return; }
      clearTimeout(this.resizeT);
      this.resizeT = window.setTimeout(() => this.relayout(), 140);
    }).observe(stage);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.themeChanged());
    this.prewarm();
  }
  private resizeT = 0;
  private opening = false;
  private resizedWhileOpening = false;

  /** The current theme, resolved for the current appearance. */
  look: Resolved = resolve(themeById(settings.theme), false);

  isDark() {
    if (settings.appearance !== 'auto') return settings.appearance === 'dark';
    return themes.desktop ? themes.desktop.dark : matchMedia('(prefers-color-scheme: dark)').matches;
  }

  /** Resolves the theme and paints it: the appearance on the root, the theme's colours on
   *  the reader (sheets keep the app's own), and the type variables the lines use. */
  applyLook() {
    const root = document.documentElement;
    const want = settings.appearance === 'auto' ? (themes.desktop ? (themes.desktop.dark ? 'dark' : 'light') : null) : settings.appearance;
    if (want) root.setAttribute('data-theme', want); else root.removeAttribute('data-theme');
    this.look = resolve(themeById(settings.theme), this.isDark());
    const el = this.stage?.parentElement;
    if (el) {
      const pal = this.look.palette;
      const set = (k: string, v: string) => el.style.setProperty(k, v);
      const TOK = ['--paper', '--ink', '--ink-2', '--ink-3', '--rule', '--accent', '--accent-ink', '--focus', '--veil', '--veil-soft', '--wash', '--read', '--hover'];
      if (!pal) for (const k of TOK) el.style.removeProperty(k);
      else {
        const { paper, ink, accent } = pal;
        set('--paper', paper); set('--ink', ink); set('--accent', accent); set('--focus', accent); set('--accent-ink', paper);
        set('--ink-2', `color-mix(in oklab, ${ink} 74%, ${paper})`);
        set('--ink-3', `color-mix(in oklab, ${ink} 62%, ${paper})`);   // (4.5:1 at least: WCAG AA)
        set('--rule', `color-mix(in oklab, ${ink} 16%, ${paper})`);
        set('--veil', `color-mix(in srgb, ${paper} 62%, transparent)`);
        set('--veil-soft', `color-mix(in srgb, ${paper} 36%, transparent)`);
        set('--wash', `color-mix(in srgb, ${accent} 13%, transparent)`);
        set('--read', `color-mix(in srgb, ${ink} 5%, transparent)`);
        set('--hover', `color-mix(in srgb, ${ink} 7%, transparent)`);
      }
    }
    // (dark paper: rich blocks, drawn in ink, are inverted: reader.css)
    el?.classList.toggle('dark-paper', this.isDark());
    root.classList.toggle('synth-sc', this.look.synthSc);
    root.style.setProperty('--f-text', this.look.css);
    if (this.M) this.applyType();
    this.paintEdges(1400);
  }

  /** The colour around the page follows the surface in view (`ui/edges.ts`); `ms` as the
   *  surface changes: the reader fades between themes over 1.4 s. */
  paintEdges(ms: number) {
    const c = ui.lightbox ? '#0c0d11' : ui.mapOpen || ui.view !== 'reader' ? 'var(--ground)' : this.look.palette?.paper ?? 'var(--paper)';
    edges(c, ms);
  }

  lookGeom(): Look {
    const o = this.look.options;
    return { scale: this.look.scale, lineSpacing: o.lineSpacing, margins: o.margins };
  }

  /** Type variables for the current size: on the root, so calibration probes anywhere
   *  are set exactly like the lines. */
  private applyType(M = this.M) {
    const st = document.documentElement.style, L = this.look, fs = M.fs;
    st.setProperty('--wb', String(L.wght));
    st.setProperty('--wB', String(L.bold));
    st.setProperty('--w-sc', String(L.wght + 30));
    st.setProperty('--ls', ((L.options.charSpacing / 100) * fs).toFixed(3) + 'px');
    st.setProperty('--ws', ((L.options.wordSpacing / 100) * fs).toFixed(3) + 'px');
    st.setProperty('--opsz-sc', String(Math.min(144, Math.max(6, fs * 0.78))));
    st.setProperty('--fvs', L.axes.map(([k, v]) => `"${k}" ${v}, `).join('') + '"wght" 400,');
  }

  /** Loads the theme's face (system families are handed to the webview first). */
  /** The faces, weights and book the fonts were last made ready for: a size changes none
   *  of them (asking again cost 23 ms of every change of size). */
  private fontsFor = '';
  private async ensureFonts() {
    const book = this.book;
    const key = JSON.stringify([this.look.chain, this.look.wght, this.look.bold, book?.id ?? '', book?.ext ?? '']);
    if (key === this.fontsFor) return;
    // the page's faces first: the engine's copy of them then comes from the browser's
    // cache (asked for at once, each face was downloaded twice)
    await fontsReady(this.look, this.M?.fs ?? 20, '', undefined).catch(() => {});
    await loadFamily(this.core, this.look.chain[0]);
    // the family's small capitals are known only once it is loaded
    this.look = resolve(themeById(settings.theme), this.isDark());
    document.documentElement.classList.toggle('synth-sc', this.look.synthSc);
    const needs = book ? await this.core.fontNeeds(book.id, this.look.chain[0]).catch(() => undefined) : undefined;
    await fontsReady(this.look, this.M?.fs ?? 20, book?.ext ?? '', needs);
    this.fontsFor = key;
  }

  themeChanged() {
    this.applyLook();
    readTokens();
  }

  /** Highlights and find hits for a block, as the renderer draws them (hits first). */
  private marksOf = (key: string) => {
    const f = this.finder.open ? this.finder.of(key) : undefined, a = this.ann?.of(key);
    return f && a ? [...f, ...a] : f || a;
  };
  finder = new Finder(this);
  /** Other readers' notes on the open book. */
  fb: Feedback | null = null;

  /** Takes a notes file for the open book: one's own notes are put back (an export, or a
   *  copy from another device), another reader's are placed beside the text as theirs. */
  async receiveNotes(text: string): Promise<string> {
    const files = parseNotes(text, this.book ? { id: this.book.id, title: this.book.title, author: this.book.author } : undefined);
    if (typeof files === 'string') return files;
    const book = this.book;
    if (!book || !this.fb || !this.strip || !this.ann) return 'Open the book the notes are for first.';
    const f = files.find(x => targetOf(x, [{ id: book.id, title: book.title }]));
    if (!f) return `These notes are for “${files[0].book.title}”.`;
    if (isMine(f)) {
      const r = await restoreInto(f, book, this.core, this.ann, this.marks);
      for (const [k] of this.surface.rendered()) this.surface.refresh(k);
      ui.annVersion++;
      this.digestSoon();
      return restored(book.title, r);
    }
    this.fb.add(f);
    await this.fb.place(this.core);
    for (const [k] of this.surface.rendered()) this.surface.refresh(k);
    ui.annVersion++;
    const r = this.fb.list().find(x => x.name === (f.from.name || 'A reader'));
    return `Notes from ${f.from.name || 'a reader'}: ${r?.count ?? 0} placed${r?.lost ? `, ${r.lost} not found in this version` : ''}.`;
  }

  /** This reader's notes on the open book, as a notes file. */
  myNotes() { return notesFile(this.book!, this.ann?.list ?? [], this.marks, this.strip!.keyIndex); }

  /** Rich blocks' XHTML, by image index (rich.ts). */
  private richText = new Map<number, string>();
  private async richOf(i: number): Promise<string> {
    let t = this.richText.get(i);
    if (t === undefined) {
      t = new TextDecoder().decode(await this.core.imageBytes(this.book!.id, i));
      this.richText.set(i, t);
    }
    return t;
  }
  /** Rich blocks are laid out as images of the size the browser draws them at: measured
   *  the first time the book opens, and kept with it. */
  private async measureRich(book: BookData) {
    const todo = book.images.map((im, i) => [im, i] as const).filter(([im]) => im[3] === RICH && (!im[0] || !im[1]));
    if (!todo.length) return;
    const sizes: [number, number, number][] = [];
    for (const [im, i] of todo) {
      const { w, h } = measureRich(await this.richOf(i));
      im[0] = w; im[1] = h;
      sizes.push([i, w, h]);
    }
    await this.core.setImageSizes(book.id, sizes);
  }

  /** An image's URL if known; otherwise it is asked for and set on the page when it
   *  arrives (the desktop knows at once; the web build reads IndexedDB). A rich block's
   *  is its picture, made from its XHTML. */
  private imgURLs = new Map<number, string>();
  private richBlobs = new Set<string>();
  private imgSrc = (i: number): string => {
    if (i < 0 || !this.book) return '';
    const hit = this.imgURLs.get(i);
    if (hit !== undefined) return hit;
    const im = this.book.images[i];
    const u: string | Promise<string> = im?.[3] === RICH ? this.richOf(i).then(t => { const url = richURL(t, im[0] || 600, im[1] || 400); this.richBlobs.add(url); return url; }) : this.core.imageURL(this.book.id, i);
    if (typeof u === 'string') { this.imgURLs.set(i, u); return u; }
    this.imgURLs.set(i, '');
    const book = this.book.id;
    u.then(url => {
      if (this.book?.id !== book) return;
      this.imgURLs.set(i, url);
      for (const img of document.querySelectorAll<HTMLImageElement>(`.col img[data-i="${i}"]`)) img.src = url;
    });
    return '';
  };
  imageURL(i: number) { return this.imgSrc(i); }

  /** Redraws the columns in view (marks, hits) without moving anything. */
  repaint() { if (this.strip) this.surface.reset(this.cur); }

  /** Brings column k into view: a short way on a calm curve; a long way with a quick
   *  fade, as the surface cannot build a hundred columns in passing. */
  async travelTo(k: number) {
    if (!this.strip) return;
    k = Math.max(0, Math.min(Math.max(0, this.strip.N - this.M.N), k));
    const d = Math.abs(k - this.cur);
    if (!d) return;
    if (d <= 6) { this.go(k); return; }
    const t = this.surface.track;
    if (reduceMotion()) { this.jump(k); return; }
    t.style.transition = 'opacity .11s ease-in'; t.style.opacity = '0';
    await new Promise(r => setTimeout(r, 115));
    this.jump(k);
    requestAnimationFrame(() => { t.style.transition = 'opacity .2s ease-out'; t.style.opacity = '1'; });
  }

  private columnHTML(k: number): string {
    const strip = this.strip!;
    const it = strip.itemAt(k);
    if (!it) return '';
    if (it.type === 'sect') return columnHTML(strip, k, this.M, this.marks, this.marksOf, this.imgSrc, this.fb?.size ? this.fb : undefined);
    return leafHTML(strip, it, { totalLines: this.totalLines(), N: strip.N });
  }

  private totalLines() {
    let n = 0;
    for (const sl of this.strip!.layouts.values()) n += sl.n;
    return n;
  }

  /** Whether this webview rounds glyph advances, to whole px or 1/60 px (calibrate.ts). */
  private round = false;
  private appUnits = false;
  /** Whether this webview kerns across word spaces (see calibrate.ts). */
  private spaceKern: 0 | 1 | 2 = 0;
  /** Whether this webview shapes inline elements apart (see calibrate.ts). */
  private linkRuns = false;
  calibErr = 0;
  private params(M = this.M): LayoutParams {
    const L = this.look, o = L.options;
    return {
      size: M.fs, measure: M.colW, rows: M.rows, headRows: M.headRows, lh: M.lh, justify: o.justify, hyphenate: o.hyphenate, round: this.round, appUnits: this.appUnits,
      font: L.chain, wght: L.wght, bold: L.bold, ls: +((o.charSpacing / 100) * M.fs).toFixed(3), ws: +((o.wordSpacing / 100) * M.fs).toFixed(3), axes: L.axes, spaceKern: this.spaceKern, linkRuns: this.linkRuns,
    };
  }
  private applyCSS() {
    const M = this.M, st = this.stage.parentElement!.style;
    st.setProperty('--fs', M.fs + 'px'); st.setProperty('--lh', M.lh + 'px');
    st.setProperty('--colW', M.colW + 'px'); st.setProperty('--colH', M.colH + 'px');
    st.setProperty('--G', M.G + 'px'); st.setProperty('--y0', M.y0 + 'px');
    st.setProperty('--opsz', String(Math.min(144, Math.max(6, M.fs))));
    st.setProperty('--opsz-s', String(Math.min(144, Math.max(6, M.fs * 0.7))));
    this.applyType();
    // the focus window, and how far the veil takes to reach full strength beside it
    st.setProperty('--fl', M.x0 - M.G / 2 + 'px');
    st.setProperty('--fr', M.W - (M.x0 + M.focusW + M.G / 2) + 'px');
    const side = Math.min(M.x0, M.W - M.x0 - M.focusW) - M.G / 2;
    st.setProperty('--feather', Math.round(Math.max(24, Math.min(220, side * 0.6, M.P * 0.33))) + 'px');
    ui.cols = M.N; ui.colsReduced = M.reduced; ui.phone = M.phone;
  }

  /* ---------- open, layout, close ---------- */
  /** Opens a book where it was left, or at `at` (from the library's notebook or a
   *  search), and reading begins at once. */
  async open(id: string, at?: Anchor) {
    const gen = ++this.gen;
    ui.busy = 'Opening…';
    performance.mark('open');
    this.opening = true;
    this.resizedWhileOpening = false;
    try {
      const book = await this.core.open(id);
      performance.mark('open:book');
      if (gen !== this.gen) return;
      this.book = book;
      this.richText.clear();
      await this.measureRich(book).catch(() => {});
      if (gen !== this.gen) return;
      this.marks = new Set(kv.get<string[]>('marks.' + id, []));
      this.seen = new Set(kv.get<string[]>('seen.' + id, []));
      this.visited = new Set();
      // (what earlier versions kept per book: a line per chapter, a stopping point)
      kv.del('lines.' + id); kv.del('session.' + id);
      this.reading = false;
      this.taps = 0; this.walked = 0; this.lastK = -1;
      this.strip = new Strip(book);
      this.ann = new Annotations(book, this.strip.keyIndex);
      this.fb = new Feedback(book, this.strip.keyIndex);
      // notes made on another version of the text find their words again (one's own, and
      // other readers' that arrived since)
      await Promise.all([this.ann.place(this.core), this.fb.place(this.core)]).catch(() => {});
      if (gen !== this.gen) return;
      this.imgURLs.clear();
      // (the pictures made for the last book's rich blocks)
      for (const u of this.richBlobs) URL.revokeObjectURL(u);
      this.richBlobs.clear();
      ui.title = book.title;
      ui.view = 'reader';
      await new Promise(r => requestAnimationFrame(r));
      await this.layoutFrom(at ?? kv.get<Anchor | null>('pos.' + id, null), gen);
      if (gen !== this.gen) return;
      // a book whose notebook the library has not seen yet gets its digest now
      if (!kv.get('nb.' + id, null)) this.digestSoon();
      this.begin();
    } catch (e) {
      ui.view = 'library';
      toast(`Couldn’t open the book: ${(e as Error).message}`, 5000);
    } finally {
      if (gen === this.gen) {
        ui.busy = '';
        this.opening = false;
        if (this.resizedWhileOpening && this.book) this.relayout();
      }
    }
  }

  /** Opens a book at a match of a library search, the search going on in the book. */
  async openAt(id: string, at: Anchor, query: string) {
    await this.open(id, at);
    if (this.book?.id !== id) return;
    this.finder.query = query;
    this.finder.show();
    await this.finder.run();
  }

  /** Lays the book out around an anchor: its section first, then (not awaited) the rest. */
  private async layoutFrom(anchor: Anchor | null, gen: number) {
    const strip = this.strip!, book = this.book!;
    this.applyLook();
    this.M = metrics(this.stage.clientWidth, this.stage.clientHeight, this.lookGeom(), insets());
    this.applyCSS();
    await this.ensureFonts();
    performance.mark('open:fonts');
    if (gen !== this.gen) return;
    this.applyType();
    const cal = await calibrate(this.core, this.stage.parentElement!, { ...this.params(), round: false, appUnits: false });
    performance.mark('open:calibrated');
    this.round = cal.round; this.appUnits = cal.appUnits; this.spaceKern = cal.spaceKern; this.linkRuns = cal.linkRuns; this.calibErr = cal.err;
    if (gen !== this.gen) return;
    const p = this.params();
    const pg = ++this.paramGen;
    strip.setEstimate(this.M.rows, this.M.colW, this.M.fs);
    let sec = 0;
    if (anchor && 'key' in anchor) sec = strip.keyIndex.get(anchor.key)?.[0] ?? 0;
    else if (anchor && 'sec' in anchor) sec = Math.max(0, Math.min(book.sections.length - 1, anchor.sec));
    const first = parseLayout(await this.core.layout(book.id, [sec], p));
    performance.mark('open:first-layout');
    if (gen !== this.gen) return;
    strip.layouts = first;
    this.recompose(anchor);
    performance.mark('open:shown');
    this.calibrateNeighbours();
    this.core.layout(book.id, [], p).then(buf => {
      performance.mark('open:all-layout');
      if (pg !== this.paramGen || this.strip !== strip) return;
      const all = parseLayout(buf);
      const keep = this.motion.moving ? null : strip.anchorAt(this.cur);
      strip.layouts = all;
      this.recompose(keep ?? strip.anchorAt(this.cur), true);
      ui.layoutVersion++;
    }, e => toast(`Couldn’t lay out the book: ${(e as Error).message}`, 5000));
  }

  /** The sizes either side of this one, measured while nothing else is happening: the
   *  next step of the size control finds them known (a size not yet measured took 11–30
   *  ms of its change). */
  private calibrateNeighbours() {
    // (the book, not the layout's generation: a relayout that changes nothing still
    // counts one, and the neighbours were never measured)
    const book = this.book;
    const now = settings.size ?? (this.M.phone ? 17 : 20);
    const i = SIZES.indexOf(now);
    const next = [SIZES[i - 1], SIZES[i + 1]].filter((s): s is number => s !== undefined && i >= 0);
    const idle = window.requestIdleCallback ?? ((f: () => void) => window.setTimeout(f, 400));
    idle(async () => {
      for (const size of next) {
        if (!book || this.book !== book) return;
        const M = metrics(this.stage.clientWidth, this.stage.clientHeight, this.lookGeom(), insets(), size);
        await calibrate(this.core, this.stage.parentElement!, { ...this.params(M), round: false, appUnits: false }).catch(() => {});
      }
    });
  }

  /** Measures this webview's glyph positioning once, before any book is opened. */
  async prewarm() {
    this.applyLook();
    await this.ensureFonts();
    await document.fonts.ready;
    if (this.book) return;
    const M = metrics(Math.max(640, window.innerWidth), Math.max(480, window.innerHeight), this.lookGeom());
    this.applyType(M);
    await calibrate(this.core, document.body, { ...this.params(M), round: false }).catch(() => {});
    if (!this.book) this.core.idle?.();
  }

  private recompose(anchor: Anchor | null, quiet = false) {
    const strip = this.strip!;
    strip.compose();
    this.cur = Math.min(Math.max(0, strip.N - this.M.N), Math.max(0, strip.resolve(anchor)));
    readTokens();
    this.motion.jump(this.cur);
    this.surface.reset(this.cur);
    this.arrive(this.cur, quiet);
  }

  async relayout() {
    if (!this.book || !this.strip) return;
    const gen = ++this.gen;
    const anchor = this.strip.anchorAt(this.cur);
    const old = this.M;
    this.applyLook();
    const M = metrics(this.stage.clientWidth, this.stage.clientHeight, this.lookGeom(), insets());
    const force = this.forceRelayout;
    this.forceRelayout = false;
    if (!force && old && M.W === old.W && M.H === old.H && M.fs === old.fs && M.colW === old.colW && M.rows === old.rows && M.N === old.N) return;
    // same measure and rows: the text need not be set again, only the window moves
    if (!force && old && M.fs === old.fs && M.colW === old.colW && M.rows === old.rows && M.headRows === old.headRows) {
      this.M = M; this.applyCSS(); this.recompose(anchor, true);
      return;
    }
    await this.layoutFrom(anchor, gen);
  }
  forceRelayout = false;
  async settingsChanged(kind: 'layout' | 'style') {
    if (!this.strip) return;
    if (kind === 'layout') { this.forceRelayout = true; await this.relayout(); }
    else this.surface.reset(this.cur);
  }

  close() {
    if (!this.book) return;
    this.flush();
    this.gen++;
    this.motion.jump(0);
    if (this.finder.open) this.finder.hide();
    ui.bookNote = null; ui.lightbox = null;
    this.book = null; this.strip = null; this.ann = null; this.fb = null; this.reading = false;
    ui.chip = null;
    this.pick = null;
    ui.mapOpen = false; ui.sheet = null;
    document.documentElement.style.removeProperty('--h');
    for (const [, el] of this.surface.rendered()) el.remove();
    this.core.idle?.();
    ui.view = 'library';
    ui.libVersion++;
  }

  flush() {
    if (!this.book || !this.strip) return;
    clearTimeout(this.saveT); clearTimeout(this.seenT); clearTimeout(this.dwellT);
    const id = this.book.id;
    kv.set('pos.' + id, this.strip.anchorAt(this.cur));
    kv.set('seen.' + id, [...this.seen]);
    kv.set('marks.' + id, [...this.marks]);
    if (this.digestT) { clearTimeout(this.digestT); this.digestT = 0; this.saveDigest(); }
    const it = this.strip.itemAt(this.cur);
    // a book sent by link: the reader's notes go back by themselves, if they changed
    if (this.ann && kv.get('joined.' + id, null)) sendQuietly(id, this.myNotes());
    kv.set('state.' + id, { where: it && it.sec >= 0 && it.type !== 'colophon' ? chapName(this.book, Math.min(it.sec, this.book.sections.length - 1)) : it?.type === 'colophon' ? 'At the end' : 'At the beginning', done: it?.type === 'colophon' });
  }

  /** Reading begins: the keys go to the page, and the hints for a new reader come. */
  private begin() {
    this.visited = new Set([this.cur]);
    this.reading = true;
    this.stage.focus({ preventScroll: true });
    const opens = kv.get<number>('opens', kv.get<number>('sessions', 0)) + 1;
    kv.set('opens', opens); kv.del('sessions');
    if (opens >= 2) setTimeout(() => hint('settings', 'S opens themes, size and spacing; C changes how many columns you see.'), 2500);
    this.touchHint();
  }

  /* ---------- position and movement ---------- */
  headFor(k: number) {
    const strip = this.strip!, it = strip.itemAt(k), b = strip.book;
    if (!it) return '';
    if (it.type === 'title') return b.title;
    if (it.type === 'colophon') return 'Colophon';
    const s = b.sections[it.sec];
    if (s.k === 0) return s.title || 'Front matter';
    return s.label && s.title ? `${s.num} · ${s.title}` : chapName(b, it.sec);
  }

  /** Columns in the focus window at rest. */
  focusCols(): number[] {
    const out: number[] = [];
    for (let k = this.cur; k < Math.min(this.strip!.N, this.cur + this.M.N); k++) out.push(k);
    return out;
  }

  /** Every frame the sheet moves. */
  private frame(p: number, v: number) {
    if (!this.strip) return;
    if (ui.sideNotes) ui.sideNotes = null;
    this.surface.place(p, v);
    const k = Math.round(p);
    if (k !== this.shownK) {
      this.shownK = k;
      ui.runhead = this.headFor(k);
      // the paper's tint changes only at rest: changing it in motion repainted the whole
      // window (background, veils) every few frames
    }
  }

  /** The sheet came to rest on a boundary. */
  private rest(k: number) {
    if (!this.strip) return;
    this.cur = k;
    this.surface.rebase(k);
    this.surface.place(k);
    this.arrive(k);
  }

  private arrive(k: number, quiet = false) {
    const strip = this.strip!;
    this.shownK = k;
    ui.runhead = this.headFor(k);
    document.documentElement.style.setProperty('--h', hueAt(strip.frac(k)).toFixed(1));
    const focus = this.focusCols();
    for (const c of focus) this.visited.add(c);
    this.teach(k);
    clearTimeout(this.dwellT); this.dwellT = window.setTimeout(() => focus.forEach(c => this.markSeen(c)), 1600);
    clearTimeout(this.saveT); this.saveT = window.setTimeout(() => this.book && kv.set('pos.' + this.book.id, strip.anchorAt(this.cur)), 400);
    // controls in leaves are reachable only while their leaf is in focus
    for (const [c, el] of this.surface.rendered()) for (const x of el.querySelectorAll<HTMLElement>('textarea, button')) x.tabIndex = focus.includes(c) ? 0 : -1;
    if (!quiet && document.activeElement?.closest?.('.leaf') && !focus.some(c => this.surface.columnEl(c)?.contains(document.activeElement))) this.stage.focus({ preventScroll: true });
    if (this.pick) this.pickSet(0);
  }

  private markSeen(k: number) {
    const L = this.strip?.linesAt(k);
    if (!L || !this.book) return;
    let changed = false;
    const sec = this.book.sections[L.sec];
    for (let j = L.from; j < L.to; j++) {
      const key = sec.blocks[L.sl.u[j * FIELDS + F.block]].key;
      if (!this.seen.has(key)) { this.seen.add(key); changed = true; }
    }
    if (changed) { clearTimeout(this.seenT); this.seenT = window.setTimeout(() => this.book && kv.set('seen.' + this.book.id, [...this.seen]), 800); }
  }

  colSeen(k: number) {
    const L = this.strip?.linesAt(k);
    if (!L || L.to <= L.from) return false;
    const sec = this.book!.sections[L.sec];
    let s = 0;
    for (let j = L.from; j < L.to; j++) if (this.seen.has(sec.blocks[L.sl.u[j * FIELDS + F.block]].key)) s++;
    return s / (L.to - L.from) > 0.6;
  }

  /** Moves to column k on a calm curve. */
  go(k: number) { if (this.strip) this.motion.toward(k); }

  /** A turn: the whole set in view (or `n` columns) on or back. */
  step(d: number, n?: number) {
    if (!this.strip || ui.mapOpen || ui.sheet) return;
    this.motion.tap(d, n);
  }

  /** Map travel lands here without its own animation (the map animates the trip). */
  jump(k: number) {
    this.cur = Math.max(0, Math.min(Math.max(0, this.strip!.N - this.M.N), k));
    this.motion.jump(this.cur);
    this.surface.reset(this.cur);
    this.arrive(this.cur);
  }

  /* ---------- notes, references, images ---------- */
  /** Shows note `i` beside its marker. */
  openNote(i: number, at: HTMLElement) {
    if (!this.book?.notes[i]) return;
    const r = at.getBoundingClientRect(), st = this.stage.getBoundingClientRect();
    const below = r.bottom - st.top < st.height * 0.6;
    ui.chip = null;
    ui.bookNote = { i, x: r.left + r.width / 2 - st.left, y: (below ? r.bottom + 6 : r.top - 6) - st.top, below };
  }
  /** Travels to the block a reference names. */
  followRef(key: string) {
    if (!this.strip) return;
    ui.bookNote = null;
    this.travelTo(this.strip.resolve({ key, off: 0 }));
  }
  /** Where a note is printed in the book, as a column to go to. */
  noteHome(i: number): number | null {
    const at = this.book?.notes[i]?.at;
    return at && this.strip ? this.strip.resolve({ key: at, off: 0 }) : null;
  }
  openImage(i: number, fig: HTMLElement) {
    const r = fig.getBoundingClientRect();
    ui.bookNote = null; ui.chip = null;
    ui.lightbox = { i, rect: { x: r.left, y: r.top, w: r.width, h: r.height } };
  }

  /* ---------- marks ---------- */
  toggleMark(key: string) {
    if (this.marks.has(key)) this.marks.delete(key);
    else {
      this.marks.add(key);
      hint('mark', 'Marked. Your marks are in the notebook: the map’s (M) or the library’s (N).', 4200);
    }
    this.paintMark(key);
    kv.set('marks.' + this.book!.id, [...this.marks]);
    this.digestSoon();
  }

  /** Pins every note in the focus columns beside its line, or puts them away. */
  toggleSideNotes() {
    if (ui.sideNotes?.pinned) { ui.sideNotes = null; return; }
    const ids: string[] = [];
    for (const k of this.focusCols()) for (const d of this.surface.columnEl(k)?.querySelectorAll<HTMLElement>('.nd') ?? []) ids.push(d.dataset.a!);
    if (!ids.length) { toast('No notes in view. Notes you add show a dot beside their line.'); return; }
    ui.chip = null;
    ui.sideNotes = { ids, pinned: true };
  }

  /* ---------- hints ---------- */
  /** On a touch screen, the gestures, once, as reading begins. */
  private touchHint() {
    setTimeout(() => hint('touch-start', 'Tap near the edges to turn the page, the middle for the menu. Pinch in to see the whole book.', 7000), 900);
  }
  private taps = 0;
  private walked = 0;
  private lastK = -1;
  /** Hints that come with reading: the map after a long walk column by column, selection
   *  once a reader has read a while and marked nothing. */
  private teach(k: number) {
    const d = this.lastK < 0 ? 0 : Math.abs(k - this.lastK);
    this.lastK = k;
    if (d > 0 && d <= this.M.N * 2) this.walked += d;
    if (this.walked >= 30) hint('map', 'M shows the whole book at once: choose a place, Enter travels there.');
    if (this.visited.size >= 14 && !this.ann?.list.length && !this.marks.size) hint('select', 'Hold on a word to select it, drag to take more; then 1–4 highlights and N adds a note. V picks a paragraph from the keyboard.', 7000);
  }

  /* ---------- the notebook ---------- */
  /** Everything added to this book, in reading order. */
  notebook() {
    return notebookOf(this.book!, this.strip!.keyIndex, this.ann?.list ?? [], this.marks);
  }
  private digestT = 0;
  /** The library's copy of this book's notebook, written a moment after a change. */
  digestSoon() {
    clearTimeout(this.digestT);
    this.digestT = window.setTimeout(() => { this.digestT = 0; this.saveDigest(); }, 400);
  }
  private saveDigest() { if (this.book && this.strip) saveDigest(this.book, this.notebook()); }

  paintMark(key: string) {
    const hit = this.strip?.keyIndex.get(key);
    if (!hit) return;
    const on = this.marks.has(key);
    for (const [k, el] of this.surface.rendered()) {
      const it = this.strip!.itemAt(k);
      if (!it || it.sec !== hit[0] || it.type !== 'sect') continue;
      for (const ln of el.querySelectorAll(`.ln[data-b="${hit[1]}"]`)) ln.classList.toggle('mk', on);
    }
  }

  /* ---------- highlights and notes ---------- */
  /** Re-renders every visible column of a section after its annotations changed. */
  refreshSection(sec: number) {
    for (const [k] of this.surface.rendered()) if (this.strip!.itemAt(k)?.sec === sec) this.surface.refresh(k);
    ui.annVersion++;
    this.digestSoon();
  }

  /** Highlights a selection (one annotation per block it covers). Returns the first. */
  highlight(sel: Sel, color = 1, note = ''): string | null {
    const book = this.book!, ann = this.ann!;
    let [as, ab, ao] = sel.a, [zs, zb, zo] = sel.z;
    if (as > zs || (as === zs && (ab > zb || (ab === zb && ao > zo)))) [as, ab, ao, zs, zb, zo] = [zs, zb, zo, as, ab, ao];
    let first: string | null = null;
    const touched = new Set<number>();
    for (let s = as; s <= zs; s++) {
      const blocks = book.sections[s].blocks;
      for (let b = s === as ? ab : 0; b <= (s === zs ? zb : blocks.length - 1); b++) {
        const blk = blocks[b];
        if (!blk.t) continue;
        const from = s === as && b === ab ? ao : 0, to = s === zs && b === zb ? zo : blk.t.length;
        const a = ann.add(blk.key, from, to, color, first ? '' : note);
        if (a && !first) first = a.id;
        touched.add(s);
      }
    }
    for (const s of touched) this.refreshSection(s);
    return first;
  }

  recolor(id: string, color: number) { this.ann!.update(id, { color }); this.refreshAnn(id); }
  setNote(id: string, note: string) {
    this.ann!.update(id, { note }); this.refreshAnn(id);
    if (note) hint('sidenotes', 'A dot beside the line marks your note: point at it to read it, or press ; for every note in view.');
  }
  unhighlight(id: string) {
    const a = this.ann!.list.find(x => x.id === id);
    this.ann!.remove(id);
    if (a) this.refreshSection(this.strip!.keyIndex.get(a.key)?.[0] ?? -1);
  }
  private refreshAnn(id: string) {
    const a = this.ann!.list.find(x => x.id === id);
    if (a) this.refreshSection(this.strip!.keyIndex.get(a.key)?.[0] ?? -1);
  }

  /** The quote of a selection, for copying. */
  selText(sel: Sel): string {
    const book = this.book!;
    let [as, ab, ao] = sel.a, [zs, zb, zo] = sel.z;
    if (as > zs || (as === zs && (ab > zb || (ab === zb && ao > zo)))) [as, ab, ao, zs, zb, zo] = [zs, zb, zo, as, ab, ao];
    const parts: string[] = [];
    for (let s = as; s <= zs; s++) {
      const blocks = book.sections[s].blocks;
      for (let b = s === as ? ab : 0; b <= (s === zs ? zb : blocks.length - 1); b++) {
        const t = blocks[b].t;
        parts.push(t.slice(s === as && b === ab ? ao : 0, s === zs && b === zb ? zo : t.length).replace(/\n/g, ' / '));
      }
    }
    return parts.join('\n\n').trim();
  }

  /** A DOM point inside a line, as (section, block, UTF-16 offset). */
  private pointAt(node: Node | null, off: number): [number, number, number] | null {
    const el = node?.nodeType === 3 ? node.parentElement : (node as Element | null);
    const ln = el?.closest?.('.ln[data-b]') as HTMLElement | null;
    const col = ln?.closest('.col') as HTMLElement | null;
    if (!ln || !col) return null;
    const it = this.strip!.itemAt(+col.dataset.k!);
    if (!it || it.type !== 'sect') return null;
    let n = 0;
    const tw = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT);
    for (let t = tw.nextNode(); t; t = tw.nextNode()) {
      if ((t.parentElement as Element).closest('.bul')) continue;
      if (t === node) { n += off; break; }
      n += (t as Text).length;
    }
    if (node?.nodeType !== 3) n = 0;
    return [it.sec, +ln.dataset.b!, +ln.dataset.s! + n];
  }

  /** The word around a DOM point, as start and end points within its text node. */
  private wordAt(node: Node, off: number): { s: [Node, number]; e: [Node, number] } {
    if (node.nodeType !== 3) return { s: [node, off], e: [node, off] };
    const t = (node as Text).data;
    const w = (c: string | undefined) => !!c && /[\p{L}\p{N}’'-]/u.test(c);
    let a = off;
    // over a gap (space, punctuation): hold at the end of the word before it
    while (a > 0 && !w(t[a]) && !w(t[a - 1])) a--;
    if (!w(t[a]) && a > 0 && w(t[a - 1])) a--;
    let z = a;
    while (a > 0 && w(t[a - 1])) a--;
    while (z < t.length && w(t[z])) z++;
    // keep punctuation that closes the word (a full stop, a comma, a closing quote)
    while (z < t.length && /[.,;:!?”’)]/.test(t[z])) z++;
    if (z === a) z = Math.min(t.length, a + 1);
    return { s: [node, a], e: [node, z] };
  }

  /** Shows a selection from one word to another, whichever comes first in the text. */
  private showSel(a: { s: [Node, number]; e: [Node, number] }, f: { s: [Node, number]; e: [Node, number] }) {
    const r = document.createRange();
    r.setStart(a.s[0], a.s[1]);
    let before = false;
    try { before = r.comparePoint(f.s[0], f.s[1]) < 0; } catch { /* different roots */ }
    const [s, e] = before ? [f.s, a.e] : [a.s, f.e];
    try { getSelection()?.setBaseAndExtent(s[0], s[1], e[0], e[1]); } catch { /* outside text */ }
  }

  private caretAt(x: number, y: number): { node: Node; off: number } | null {
    const d = document as any;
    if (d.caretPositionFromPoint) { const p = d.caretPositionFromPoint(x, y); return p ? { node: p.offsetNode, off: p.offset } : null; }
    if (d.caretRangeFromPoint) { const r = d.caretRangeFromPoint(x, y); return r ? { node: r.startContainer, off: r.startOffset } : null; }
    return null;
  }

  /** Paragraphs with lines in the focus window, in reading order. */
  private focusBlocks(): { k: number; b: number }[] {
    const out: { k: number; b: number }[] = [];
    for (const k of this.focusCols()) {
      const L = this.strip?.linesAt(k);
      if (!L) continue;
      for (let j = L.from; j < L.to; j++) {
        const b = L.sl.u[j * FIELDS + F.block];
        const last = out[out.length - 1];
        if (L.sl.u[j * FIELDS + F.flags] & Flag.Break) continue;
        if (!last || last.b !== b || this.strip!.itemAt(last.k)!.sec !== L.sec) out.push({ k, b });
      }
    }
    return out;
  }

  /** Keyboard marking: a cursor over the paragraphs in focus. */
  pickStart() {
    if (!this.focusBlocks().length) { toast('Nothing to mark here.'); return; }
    this.pick = { idx: 0 };
    this.pickSet(0);
  }
  pickEnd() {
    this.pick = null;
    for (const [, el] of this.surface.rendered()) for (const ln of el.querySelectorAll('.pick')) ln.classList.remove('pick');
  }
  pickSet(d: number) {
    const blocks = this.focusBlocks();
    if (!this.pick || !blocks.length) { this.pickEnd(); return; }
    this.pick.idx = Math.max(0, Math.min(blocks.length - 1, this.pick.idx + d));
    const { k, b } = blocks[this.pick.idx];
    const sec = this.strip!.itemAt(k)!.sec;
    for (const [c, el] of this.surface.rendered()) {
      for (const ln of el.querySelectorAll('.pick')) ln.classList.remove('pick');
      if (this.strip!.itemAt(c)?.sec === sec && this.focusCols().includes(c)) for (const ln of el.querySelectorAll(`.ln[data-b="${b}"], .img[data-b="${b}"]`)) ln.classList.add('pick');
    }
  }
  /** Keyboard: open what the chosen paragraph holds: its image, or its first note. */
  pickOpen() {
    if (!this.pick) return;
    const picked = [...document.querySelectorAll<HTMLElement>('.col .pick')];
    const fig = picked.find(el => el.classList.contains('img'));
    if (fig) { this.openImage(+fig.dataset.i!, fig); return; }
    const nr = picked.map(el => el.querySelector<HTMLElement>('a.nr')).find(Boolean);
    if (nr) this.openNote(+nr.dataset.n!, nr);
    else toast('No note or image here.');
  }
  /** Keyboard: highlight the chosen paragraph (and open its note with `note`). */
  pickHighlight(note: boolean) {
    const blocks = this.focusBlocks();
    if (!this.pick || !blocks.length) return;
    const { k, b } = blocks[this.pick.idx];
    const sec = this.strip!.itemAt(k)!.sec;
    const len = this.book!.sections[sec].blocks[b].t.length;
    const existing = this.ann!.of(this.book!.sections[sec].blocks[b].key)?.find(a => a.s === 0 && a.e >= len - 1);
    const id = existing?.id ?? this.highlight({ a: [sec, b, 0], z: [sec, b, len] });
    if (id && note) { ui.noteFor = id; ui.sheet = 'note'; }
    this.pickSet(0);
  }
  pickToggle() {
    const blocks = this.focusBlocks();
    if (!this.pick || !blocks.length) return;
    const { k, b } = blocks[this.pick.idx];
    this.toggleMark(this.book!.sections[this.strip!.itemAt(k)!.sec].blocks[b].key);
  }

  /* ---------- input ---------- */
  private zoneAt(clientX: number): 'prev' | 'next' | 'focus' {
    const M = this.M, x = clientX - this.stage.getBoundingClientRect().left;
    const l = M.x0 - M.G / 2, r = M.x0 + M.focusW + M.G / 2;
    return x < l ? 'prev' : x > r ? 'next' : 'focus';
  }

  /** Reader keys. Returns true if handled. */
  key(e: KeyboardEvent): boolean {
    if (!this.strip) return false;
    const k = e.key;
    if (this.pick) {
      if (k === 'j' || k === 'ArrowDown') { this.pickSet(1); return true; }
      if (k === 'k' || k === 'ArrowUp') { this.pickSet(-1); return true; }
      if (k === 'x' || k === 'h' || k === 'Enter' || k === ' ') { this.pickHighlight(false); return true; }
      if (k === 'n') { this.pickHighlight(true); return true; }
      if (k === 'o') { this.pickOpen(); return true; }
      if (k === 'Escape' || k === 'v') { this.pickEnd(); return true; }
      if (k === 'l' || k === 'ArrowRight' || k === 'h' || k === 'ArrowLeft') this.pickEnd();
      else return true;
    }
    // Space and the page keys turn the whole set in view; arrows (and vim keys) move one
    // column, and held they glide so the reader chooses how far
    const page = k === ' ' || k === 'PageDown' || k === 'PageUp';
    const next = k === 'ArrowRight' || k === 'ArrowDown' || k === 'PageDown' || k === 'l' || k === 'j' || (k === ' ' && !e.shiftKey);
    const prev = k === 'ArrowLeft' || k === 'ArrowUp' || k === 'PageUp' || k === 'h' || k === 'k' || (k === ' ' && e.shiftKey);
    if (next || prev) {
      if (e.repeat) return true;                 // key repeat never turns; holding cruises
      const d = next ? 1 : -1;
      this.keyHeld = k;
      this.step(d, page ? undefined : 1);
      clearTimeout(this.keyHoldT);
      this.keyHoldT = window.setTimeout(() => { if (this.keyHeld === k && !ui.sheet && !ui.mapOpen) this.motion.cruise(d); }, CRUISE_AFTER);
      return true;
    }
    // ; shows every note in view beside its line, and puts them away again
    if (k === ';') { this.toggleSideNotes(); return true; }
    if (k === 'Escape' && ui.sideNotes) { ui.sideNotes = null; return true; }
    // a search goes on with its field put away: N steps through it, Esc ends it
    if (this.finder.open) {
      if ((k === 'n' || k === 'N') && this.finder.hits.length) { k === 'n' ? this.finder.next() : this.finder.prev(); return true; }
      if (k === 'Escape') { this.finder.hide(); return true; }
    }
    return false;
  }

  keyUp(e: KeyboardEvent) {
    if (this.keyHeld && (e.key === this.keyHeld || e.key.toLowerCase() === this.keyHeld.toLowerCase())) {
      this.keyHeld = null; clearTimeout(this.keyHoldT);
      this.motion.release();
    }
  }

  blur() { this.keyHeld = null; clearTimeout(this.keyHoldT); this.motion.release(); }

  /** Wheel input. A mouse wheel's notches each move one column; a trackpad moves the
   *  sheet directly until the fingers lift or the system's momentum begins, then the
   *  reader lands it. Which is which is read from the input's shape, not its size:
   *  webviews report a notch anywhere from 40 to 160 px (WebKitGTK: 153), high-resolution
   *  wheels send fractions of a notch, and trackpads send smoothly varying amounts. */
  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (!this.strip || ui.mapOpen || ui.sheet) return;
    if (e.ctrlKey) { if (e.deltaY > 4) this.onMapOpen(); return; }   // pinch out on a trackpad
    const now = performance.now();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const v = (Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY) * unit;
    if (!v) return;
    let g = this.wheel;
    if (g && now - g.last > (g.kind === 'locked' ? WHEEL_LOCK : WHEEL_QUIET * 2)) { this.endWheel(g); g = null; }
    if (!g) {
      const discrete = e.deltaMode !== 0 || (Math.abs(v) >= 20 && Number.isInteger(v)) || (this.wheelQ > 0 && Math.abs(Math.abs(v) - this.wheelQ) < 0.01);
      g = this.wheel = { kind: discrete ? 'notch' : 'direct', last: now, mags: [], t0: now, endT: 0, acc: 0, log: [], from: this.motion.p };
      if (discrete && Math.abs(v) >= 20) this.wheelQ = Math.abs(v);
    }
    g.last = now;
    if (g.log.length < 40) g.log.push([Math.round(now - g.t0), +v.toFixed(2)]);
    if (g.kind === 'locked') return;
    if (g.kind === 'direct') {
      g.mags.push(Math.abs(v));
      if (g.mags.length > 4) g.mags.shift();
      const m = g.mags;
      // a high-resolution wheel turned slowly: the same small step, again and again
      if (m.length >= 3 && m.slice(-3).every(x => Math.abs(x - m[m.length - 1]) < 0.01) && m[m.length - 1] >= 2) {
        // the first steps moved the sheet directly: they count towards the first notch
        // instead, and the sheet goes back to where the wheel found it
        g.kind = 'notch';
        clearTimeout(g.endT);
        if (!this.wheelQ) this.wheelQ = m[m.length - 1] * 8;
        g.acc = g.log.slice(0, -1).reduce((a, [, d]) => a + d, 0) / this.wheelQ;
        this.motion.toward(Math.round(g.from));
      }
    }
    if (g.kind === 'notch') {
      // partial notches add up; a notch's worth turns at the half, so the wheel answers at once
      const q = this.wheelQ || Math.abs(v);
      g.acc += v / q;
      // (the remainder after a turn may sit at exactly −½: only more than that turns back)
      if (Math.abs(g.acc) >= 0.5) do {
        const d = Math.sign(g.acc);
        this.motion.notch(d);
        g.acc -= d;
      } while (Math.abs(g.acc) > 0.5);
      return;
    }
    // momentum detection: magnitudes that keep falling after the hand has moved
    const m = g.mags;
    const decaying = m.length === 4 && m[1] < m[0] * 0.9 && m[2] < m[1] * 0.9 && m[3] < m[2] * 0.9 && now - g.t0 > 140;
    this.motion.directBy(v / this.M.P);
    clearTimeout(g.endT);
    if (decaying) { g.kind = 'locked'; this.motion.directEnd(true, true); return; }
    g.endT = window.setTimeout(() => { if (this.wheel === g && g.kind === 'direct') { g.kind = 'locked'; this.motion.directEnd(false, true); } }, WHEEL_QUIET);
  }
  /** The size of one notch of the wheel last seen, px. */
  private wheelQ = 0;
  /** Recent wheel gestures, kept for diagnosis (kv `diag.input`). */
  private wheelLog: unknown[] = [];
  private endWheel(g: NonNullable<Reader['wheel']>) {
    this.wheelLog.push({ at: new Date().toISOString().slice(11, 19), kind: g.kind, q: this.wheelQ, from: +g.from.toFixed(2), to: this.motion.target, events: g.log });
    if (this.wheelLog.length > 30) this.wheelLog.shift();
    kv.set('diag.input', this.wheelLog);
  }

  private bindInput() {
    const stage = this.stage;
    stage.addEventListener('wheel', e => this.onWheel(e), { passive: false });

    const PTR = new Map<number, { x: number; y: number }>();
    let GS: any = null;
    const cancelPress = () => {
      if (!GS) return;
      clearTimeout(GS.holdT); clearTimeout(GS.armT);
    };
    stage.addEventListener('pointerdown', e => {
      if (ui.mapOpen || !this.strip || e.button > 0) return;
      // a card over the page (a book's note, your notes) takes its own presses: never a
      // turn or a selection of the page beneath it
      if ((e.target as Element).closest?.('.bn, .sn')) return;
      // controls handle themselves; links in the text (notes, references) are the reader's
      const ctl = (e.target as Element).closest?.('textarea, button, input, label, a:not(.nr):not(.xr):not(.ur)');
      if (ctl && this.zoneAt(e.clientX) === 'focus') return;
      if (ctl) e.preventDefault();
      PTR.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      if (PTR.size === 2) {
        cancelPress();
        const [a, b] = [...PTR.values()];
        if (GS?.dragging) this.motion.directEnd();
        GS = { pinch: true, d0: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
        return;
      }
      if (PTR.size > 2) return;
      const zone = this.zoneAt(e.clientX);
      // the stage captures the pointer, so remember what was under the press itself
      GS = { x0: e.clientX, y0: e.clientY, xl: e.clientX, zone, moved: false, dragging: false, down: e.target, touch: e.pointerType === 'touch' };
      ui.chip = null;
      if (zone === 'focus') {
        // held still for a moment, the press selects the word under it; moving then extends
        // the selection word by word (moving at once moves the sheet instead)
        GS.armT = setTimeout(() => {
          if (!GS || GS.moved) return;
          const c = this.caretAt(e.clientX, e.clientY);
          if (!c || !this.pointAt(c.node, c.off)) return;
          GS.anchor = this.wordAt(c.node, c.off);
          GS.selecting = true;
          this.stage.parentElement!.classList.add('selecting');
          this.showSel(GS.anchor, GS.anchor);
          try { navigator.vibrate?.(6); } catch { /* no vibration */ }
        }, SELECT_AFTER);
      } else {
        const d = zone === 'next' ? 1 : -1;
        GS.holdT = setTimeout(() => { if (GS && !GS.moved) { GS.holding = true; this.motion.tap(d); this.motion.cruise(d); } }, CRUISE_AFTER + 160);
      }
    });
    stage.addEventListener('pointermove', e => {
      if (!PTR.has(e.pointerId) || !GS) return;
      PTR.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (GS.pinch) {
        if (PTR.size < 2) return;
        const [a, b] = [...PTR.values()];
        if (Math.hypot(a.x - b.x, a.y - b.y) / GS.d0 < 0.72) { GS = null; PTR.clear(); this.onMapOpen(); }
        return;
      }
      const dx = e.clientX - GS.x0, dy = e.clientY - GS.y0;
      if (GS.selecting) {
        const c = this.caretAt(e.clientX, e.clientY);
        if (c && this.pointAt(c.node, c.off)) this.showSel(GS.anchor, this.wordAt(c.node, c.off));
        return;
      }
      // (a finger rests less still than a mouse: a tap may wander a little)
      if (!GS.moved && Math.hypot(dx, dy) > (GS.touch ? 12 : 8)) {
        GS.moved = true; cancelPress();
        if (GS.holding) return;
        if (Math.abs(dx) >= Math.abs(dy)) { GS.dragging = true; this.motion.directStart(); GS.xl = GS.x0; }   // catch up with the hand
      }
      // the sheet follows the hand, one to one
      if (GS.dragging) { this.motion.directBy(-(e.clientX - GS.xl) / this.M.P); GS.xl = e.clientX; }
    });
    const end = (e: PointerEvent) => {
      if (!PTR.has(e.pointerId)) return;
      PTR.delete(e.pointerId);
      if (!GS) return;
      if (GS.pinch) { if (!PTR.size) GS = null; return; }
      const g = GS; cancelPress(); GS = null;
      if (g.selecting) {
        this.stage.parentElement!.classList.remove('selecting');
        const r0 = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0) : null;
        const a = r0 ? this.pointAt(r0.startContainer, r0.startOffset) : null, z = r0 ? this.pointAt(r0.endContainer, r0.endOffset) : null;
        getSelection()?.removeAllRanges();
        if (a && z && (a[0] !== z[0] || a[1] !== z[1] || a[2] !== z[2])) {
          const r = stage.getBoundingClientRect();
          ui.chip = { x: e.clientX - r.left, y: e.clientY - r.top, sel: { a, z }, ann: null };
        }
        return;
      }
      if (g.holding) { this.motion.release(); return; }
      if (g.dragging) { this.motion.directEnd(); return; }
      if (e.type === 'pointercancel') return;
      const dy = e.clientY - g.y0;
      if (g.moved) { if (Math.abs(dy) > 44) this.step(dy < 0 ? 1 : -1); return; }
      // explicit targets in the focus column: a note marker, a reference, an image
      const tgt = g.down as Element | null;
      if (g.zone === 'focus' && tgt?.closest) {
        const nr = tgt.closest('a.nr') as HTMLElement | null;
        if (nr) { this.openNote(+nr.dataset.n!, nr); return; }
        const xr = tgt.closest('a.xr') as HTMLElement | null;
        if (xr) { this.followRef(xr.dataset.b!); return; }
        const fig = tgt.closest('figure.img') as HTMLElement | null;
        if (fig) { this.openImage(+fig.dataset.i!, fig); return; }
        const nd = tgt.closest('.nd') as HTMLElement | null;
        if (nd) { ui.chip = null; ui.sideNotes = { ids: [nd.dataset.a!], pinned: true }; return; }
      }
      // a highlight opens its chip; find hits (h5, h6) are not annotations
      const mark = (g.down as Element)?.closest?.('mark.hl:not(.h5):not(.h6)') as HTMLElement | null;
      if (g.zone === 'focus' && mark) {
        const r = stage.getBoundingClientRect();
        ui.chip = { x: e.clientX - r.left, y: e.clientY - r.top, sel: null, ann: mark.dataset.a! };
        return;
      }
      // a finger, as phone readers expect: the outer fifth of the page turns it, the middle
      // shows or hides the bar (a mouse keeps the rule that tapping the text does nothing)
      if (g.touch && g.zone === 'focus') {
        const r = stage.getBoundingClientRect(), at = (e.clientX - r.left) / r.width;
        if (at < 0.2) this.step(-1);
        else if (at > 0.8) this.step(1);
        else ui.barToggle++;
        return;
      }
      if (g.zone === 'next') this.step(1);
      else if (g.zone === 'prev') this.step(-1);
      if (!g.touch && (g.zone === 'next' || g.zone === 'prev') && ++this.taps >= 4) hint('keys-turn', 'Space turns the page from the keyboard, → one column (held, it glides), ← back.');
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    // a note's dot, or its highlight, shows the note beside the line while the pointer rests
    // on either (or on the card); a pinned note stays until put away
    let hoverT = 0;
    stage.addEventListener('pointerover', e => {
      if (e.pointerType !== 'mouse' || GS || ui.chip) return;
      const t = (e.target as Element).closest?.('.nd, mark.hl[data-a], .fb[data-f], .sn') as HTMLElement | null;
      if (!t) return;
      clearTimeout(hoverT);
      if (t.classList.contains('sn') || ui.sideNotes?.pinned) return;
      // a dot or a highlight names one note; another reader's underline, all on its words
      const ids = (t.dataset.f ?? t.dataset.a!).split(' ').filter(id => id.includes('|') ? !!this.fb?.find(id)?.n.note : this.ann?.list.some(a => a.id === id && a.note));
      if (!ids.length) return;
      if (ui.sideNotes?.ids.join() !== ids.join()) ui.sideNotes = { ids, pinned: false };
    });
    stage.addEventListener('pointerout', e => {
      if (!ui.sideNotes || ui.sideNotes.pinned) return;
      const t = (e.target as Element).closest?.('.nd, mark.hl[data-a], .fb[data-f], .sn');
      const to = (e.relatedTarget as Element | null)?.closest?.('.nd, mark.hl[data-a], .fb[data-f], .sn');
      if (!t || to) return;
      clearTimeout(hoverT);
      hoverT = window.setTimeout(() => { if (ui.sideNotes && !ui.sideNotes.pinned) ui.sideNotes = null; }, 280);
    });
    stage.addEventListener('selectstart', e => { if (!this.stage.parentElement!.classList.contains('selecting')) e.preventDefault(); });
    // the browser's own drag-selection would replace the word-by-word selection; selection
    // here is entirely the reader's (controls in leaves keep their default)
    stage.addEventListener('mousedown', e => { if (!(e.target as Element).closest?.('textarea, input, button, a, label')) { e.preventDefault(); this.stage.focus({ preventScroll: true }); } });
    stage.addEventListener('contextmenu', e => { if (!(e.target as Element).closest?.('textarea')) e.preventDefault(); });
    stage.addEventListener('scroll', () => { stage.scrollLeft = 0; stage.scrollTop = 0; });

    const track = this.surface.track;
    track.addEventListener('focusin', e => {
      stage.scrollLeft = 0;
      const col = (e.target as Element).closest('.col') as HTMLElement | null; if (!col) return;
      const k = +col.dataset.k!;
      if (!this.focusCols().includes(k)) this.go(k);
    });
    window.addEventListener('pagehide', () => { this.flush(); flushKV(); });
    // (a phone switching apps hides the page without leaving it)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
  }
}

export { esc };
