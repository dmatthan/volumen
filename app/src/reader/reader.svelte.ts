import { edges } from '../core/edges';
import type { BookData, Core, LayoutParams } from '../core/types';
import { kv, flushKV } from '../core/kv';
import { shareAt, shareOf } from '../core/book';
import { metrics, insets, type Look, type Metrics } from './geometry';
import { Strip, parseLayout, F, FIELDS, type Anchor } from './strip';
import { columnHTML, leafHTML, chapName, esc } from './render';
import { Surface } from './surface';
import { Motion } from './motion';
import { readTokens, hueAt } from './tokens';
import { calibrate } from './calibrate';
import { settings, reduceMotion, SIZES } from './settings.svelte';
import { themes, themeById, resolve, loadFamily, fontsReady, type Resolved } from './themes.svelte';
import { Annotations, type Reaction } from './annotations';
import { Finder } from './find.svelte';
import { notebookOf, saveDigest } from './notebook';
import { Feedback, notesFile, type Progress } from './feedback';
import { takeNotes } from './intake';
import { sendQuietly } from '../core/service';
import { embedded, embedMoved, embedOpts } from '../core/embed';
import { hint } from './hints';
import { spokenPage } from './spoken';
import { ui, toast } from '../state.svelte';
import { spans, selText, type Sel } from './selection';
import { ReaderInput } from './input';
import { Cursor } from './cursor';
import { BookImages } from './images';

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
  /** The furthest this reader has read in the book, as a share of it (kept: `far.<id>`). */
  furthest = 0;
  reading = false;

  stage!: HTMLElement;
  surface!: Surface;
  motion!: Motion;

  private gen = 0;
  /** Bumps whenever the text is set with new parameters; a whole-book layout that
   *  arrives for older parameters is dropped, one for the current ones always applies. */
  private paramGen = 0;
  private shownK = -1;
  private dwellT = 0; private saveT = 0; private seenT = 0;
  onMapOpen: () => void = () => {};

  input!: ReaderInput;
  /** Marking from the keyboard (V). */
  cursor = new Cursor(this);
  images: BookImages;

  constructor(core: Core) { this.core = core; this.images = new BookImages(core, () => this.book); }

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
      frame: (p, v, glided) => this.frame(p, v, glided),
      glide: (at, times, t0) => { if (this.strip) this.surface.glide(at, times, t0); },
      rest: k => this.rest(k),
    });
    this.input = new ReaderInput(this);
    window.addEventListener('pagehide', () => { this.flush(); flushKV(); });
    // (a phone switching apps hides the page without leaving it)
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.flush(); });
    new ResizeObserver(() => {
      if (!this.book) return;
      if (this.opening) { this.resizedWhileOpening = true; return; }
      clearTimeout(this.resizeT);
      this.resizeT = window.setTimeout(() => this.relayout(), 140);
    }).observe(stage);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.themeChanged());
    matchMedia('(prefers-contrast: more)').addEventListener('change', () => this.themeChanged());
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
        // (more contrast asked for: the quieter inks nearer the ink)
        const more = matchMedia('(prefers-contrast: more)').matches;
        set('--ink-2', `color-mix(in oklab, ${ink} ${more ? 90 : 74}%, ${paper})`);
        set('--ink-3', `color-mix(in oklab, ${ink} ${more ? 84 : 62}%, ${paper})`);   // (4.5:1 at least: WCAG AA)
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

  /** The colour around the page follows the surface in view (`core/edges.ts`); `ms` as the
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

  /** The faces, weights and book the fonts were last made ready for: a size changes none
   *  of them (asking again cost 23 ms of every change of size). */
  private fontsFor = '';
  /** Loads the theme's face (system families are handed to the webview first). */
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

  /** Takes notes files while a book is open (intake.ts): those for it are placed on it at
   *  once, others kept for their books. */
  async receiveNotes(input: string | string[]): Promise<string> {
    const texts = Array.isArray(input) ? input : [input];
    if (!this.book || !this.fb || !this.strip || !this.ann) return 'Open the book the notes are for first.';
    const { said, changed } = await takeNotes(this.core, texts, await this.core.library(), { book: this.book, ann: this.ann, marks: this.marks, fb: this.fb });
    if (changed) {
      for (const [k] of this.surface.rendered()) this.surface.refresh(k);
      ui.annVersion++;
      this.digestSoon();
    }
    return said;
  }

  /** This reader's notes on the open book, as a notes file. */
  myNotes() {
    const f = notesFile(this.book!, this.ann?.list ?? [], this.marks, this.strip!.keyIndex);
    // how far they got goes with their notes, unless they said not (D7)
    if (kv.get('progress.' + this.book!.id, true)) f.progress = this.progress();
    return f;
  }

  /** Where the reader is, and the furthest they have read (to the hundredth: a page or
   *  two read changes nothing to send). */
  progress(): Progress {
    const strip = this.strip!, at = this.viewEnd();
    const r = (x: number) => Math.round(x * 100) / 100;
    const it = strip.itemAt(this.cur);
    return { at: r(at), furthest: r(Math.max(this.furthest, at)), where: it?.type === 'sect' ? chapName(this.book!, it.sec) : this.headFor(this.cur), done: Math.max(this.furthest, at) >= 0.995 || strip.itemAt(this.cur)?.type === 'colophon' };
  }
  /** The share of the book read by the end of the page in view. */
  private viewEnd() { const strip = this.strip!; return this.textShare(Math.min(strip.N - 1, this.cur + this.M.N - 1)); }
  /** How far through the book's text column k is: its first paragraph's place among all
   *  of them (0 to 1). By the text, not by columns, which are estimates until the whole
   *  book is laid out: the same in any layout, size or device. */
  private textShare(k: number): number {
    const strip = this.strip!, book = this.book!, a = strip.anchorAt(k);
    if (!a) return 0;
    if ('key' in a) return shareOf(book, strip.keyIndex, a.key) ?? 0;
    return a.leaf === 'colophon' ? 1 : a.leaf === 'title' ? 0 : shareAt(book, a.sec, 0);
  }

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
    if (it.type === 'sect') return columnHTML(strip, k, this.M, this.marks, this.marksOf, this.images.src, this.fb?.size ? this.fb : undefined);
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
      this.images.reset();
      await this.images.measure(book).catch(() => {});
      if (gen !== this.gen) return;
      this.marks = new Set(kv.get<string[]>('marks.' + id, []));
      this.seen = new Set(kv.get<string[]>('seen.' + id, []));
      this.visited = new Set();
      this.furthest = kv.get<number>('far.' + id, 0);
      this.reading = false;
      this.input.taps = 0; this.walked = 0; this.lastK = -1;
      this.strip = new Strip(book);
      this.ann = new Annotations(book, this.strip.keyIndex);
      this.fb = new Feedback(book, this.strip.keyIndex);
      // notes made on another version of the text find their words again (one's own, and
      // other readers' that arrived since)
      await Promise.all([this.ann.place(this.core), this.fb.place(this.core)]).catch(() => {});
      if (gen !== this.gen) return;
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
    // (an embedded book is all there is: there is no library to go back to)
    if (!this.book || embedded) return;
    this.flush();
    this.gen++;
    this.motion.jump(0);
    if (this.finder.open) this.finder.hide();
    ui.bookNote = null; ui.lightbox = null;
    this.book = null; this.strip = null; this.ann = null; this.fb = null; this.reading = false;
    ui.chip = null;
    this.cursor.end();
    ui.mapOpen = false; ui.sheet = null;
    this.surface.setLazy(false);
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
    kv.set('far.' + id, this.furthest);
    kv.set('seen.' + id, [...this.seen]);
    kv.set('marks.' + id, [...this.marks]);
    if (this.digestT) { clearTimeout(this.digestT); this.digestT = 0; this.saveDigest(); }
    const it = this.strip.itemAt(this.cur);
    // a book sent by link: the reader's notes go back by themselves, if they changed
    // (not while it is still opening: it has not found its place yet, and how far the
    // reader got would read as changed)
    if (this.ann && !this.opening && kv.get('joined.' + id, null)) sendQuietly(id, this.myNotes());
    kv.set('state.' + id, { where: it && it.sec >= 0 && it.type !== 'colophon' ? chapName(this.book, Math.min(it.sec, this.book.sections.length - 1)) : it?.type === 'colophon' ? 'At the end' : 'At the beginning', done: it?.type === 'colophon' });
  }

  /** Reading begins: the keys go to the page, and the hints for a new reader come. */
  private begin() {
    this.visited = new Set([this.cur]);
    this.reading = true;
    this.stage.focus({ preventScroll: true });
    const opens = kv.get<number>('opens', 0) + 1;
    kv.set('opens', opens);
    if (opens >= 2) setTimeout(() => hint('settings', 'S opens themes, size and spacing; C changes how many columns you see.'), 2500);
    this.touchHint();
  }

  /* ---------- position and movement ---------- */
  headFor(k: number) {
    const strip = this.strip!, it = strip.itemAt(k), b = strip.book;
    if (!it) return '';
    if (it.type === 'title') return b.title;
    if (it.type === 'colophon') return embedOpts.endHref ? 'The end' : 'Colophon';
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
  private frame(p: number, v: number, glided = false) {
    if (!this.strip) return;
    if (ui.sideNotes) ui.sideNotes = null;
    this.surface.place(p, v, glided, this.motion.target);
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
    this.furthest = Math.max(this.furthest, this.viewEnd());
    clearTimeout(this.saveT); this.saveT = window.setTimeout(() => { if (!this.book) return; kv.set('pos.' + this.book.id, strip.anchorAt(this.cur)); kv.set('far.' + this.book.id, this.furthest); }, 400);
    if (embedded) embedMoved(strip.frac(k), k >= strip.N - 1);
    // controls in leaves are reachable only while their leaf is in focus, and a screen
    // reader hears a leaf only then; the text in view it hears as a document (spoken.ts)
    for (const [c, el] of this.surface.rendered()) {
      for (const x of el.querySelectorAll<HTMLElement>('textarea, button, a[href]')) x.tabIndex = focus.includes(c) ? 0 : -1;
      if (el.classList.contains('leafcol')) el.setAttribute('aria-hidden', String(!focus.includes(c)));
    }
    const said = this.stage.querySelector('.spoken');
    if (said) said.innerHTML = spokenPage(strip, focus);
    if (!quiet && document.activeElement?.closest?.('.leaf') && !focus.some(c => this.surface.columnEl(c)?.contains(document.activeElement))) this.stage.focus({ preventScroll: true });
    if (this.cursor.active) this.cursor.move(0);
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
    let first: string | null = null;
    const touched = new Set<number>();
    for (const { s, b, from, to } of spans(book, sel)) {
      const blk = book.sections[s].blocks[b];
      if (!blk.t) continue;
      const a = ann.add(blk.key, from, to, color, first ? '' : note);
      if (a && !first) first = a.id;
      touched.add(s);
    }
    for (const s of touched) this.refreshSection(s);
    return first;
  }

  recolor(id: string, color: number) { this.ann!.update(id, { color }); this.refreshAnn(id); }
  /** A reaction (D6) on a highlight, or on a selection (highlighted for it); the same one
   *  again takes it off. */
  react(on: { ann?: string | null; sel?: Sel | null }, r: Reaction): string | null {
    const id = on.ann ?? (on.sel ? this.highlight(on.sel, 1) : null);
    if (!id) return null;
    const a = this.ann!.list.find(x => x.id === id);
    this.ann!.update(id, { react: a?.react === r ? undefined : r });
    this.refreshAnn(id);
    return id;
  }
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
  selText(sel: Sel): string { return selText(this.book!, sel); }


}

export { esc };
