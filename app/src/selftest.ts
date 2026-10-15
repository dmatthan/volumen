// Development self-test, run inside whichever webview hosts the app (the Tauri shell sets
// VOLUMEN_SELFTEST). Measures rendering fidelity and frame timing, reports, then quits.
import type { Reader } from './reader/reader.svelte';
import type { MapCtl } from './reader/map.svelte';
import { settings } from './reader/settings.svelte';

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
/** Waits for a condition, but never forever: a stall fails the run with its name. */
async function until(cond: () => boolean, what: string, ms = 20000) {
  const t0 = performance.now();
  while (!cond()) {
    if (performance.now() - t0 > ms) throw new Error(`timed out after ${ms / 1000}s waiting for ${what}`);
    await wait(15);
  }
}

function frames() {
  const gaps: number[] = [];
  let last = performance.now(), on = true;
  const at: number[] = [];
  const f = (t: number) => { gaps.push(t - last); at.push(Math.round(t - t0)); last = t; if (on) requestAnimationFrame(f); };
  const t0 = performance.now();
  requestAnimationFrame(f);
  return () => {
    on = false;
    const s = [...gaps].sort((a, b) => a - b);
    const med = s[Math.floor(s.length / 2)] || 16.7;
    const worstAt = at[gaps.indexOf(Math.max(...gaps))];
    return { frames: gaps.length, medianMs: +med.toFixed(2), worstMs: +Math.max(0, ...gaps).toFixed(1), worstAt, dropped: gaps.filter(g => g > med * 1.5).length };
  };
}

export async function selftest(reader: Reader, map: MapCtl, log: (s: string) => Promise<void>) {
  const out: Record<string, unknown> = { ua: navigator.userAgent, dpr: devicePixelRatio };
  await wait(800);
  const t0 = performance.now();
  ([...document.querySelectorAll<HTMLElement>('.book[data-id]')].find(b => b.textContent?.includes('Thursday')) ?? document.querySelector('.book[data-id]') as HTMLElement).click();
  await until(() => reader.reading, 'the book to open');
  out.openMs = Math.round(performance.now() - t0);
  const t = (n: string) => { const e = performance.getEntriesByName(n).at(-1), o = performance.getEntriesByName('open').at(-1); return e && o ? Math.round(e.startTime - o.startTime) : null; };
  await until(() => !!performance.getEntriesByName('open:all-layout').length, 'the whole-book layout after opening');
  out.openStages = Object.fromEntries(['open:book', 'open:calibrated', 'open:first-layout', 'open:shown', 'open:all-layout'].map(n => [n.slice(5), t(n)]));
  out.round = (reader as any).round; out.calibErr = reader.calibErr;
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  (document.querySelector('.sheet .btn.primary') as HTMLElement)?.click();
  await wait(600);

  // turns: ten single-column turns, each left to land
  let stop = frames();
  for (let i = 0; i < 10; i++) { reader.step(1); await wait(760); }
  out.turns = stop();
  // a held key glides for three seconds
  stop = frames();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
  await wait(3000);
  window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
  await wait(900);
  out.hold = stop();
  // map open, travel to the start, back
  stop = frames();
  const jumpMs: number[] = [];
  const origJump = reader.jump.bind(reader);
  const parts: Record<string, number> = {};
  const timeIt = (obj: any, name: string, label: string) => { const f = obj[name].bind(obj); obj[name] = (...a: any[]) => { const t = performance.now(); const r = f(...a); parts[label] = +((parts[label] || 0) + performance.now() - t).toFixed(2); return r; }; return () => (obj[name] = f); };
  const undo = [timeIt(reader.surface, 'reset', 'surface.reset'), timeIt(reader as any, 'arrive', 'arrive'), timeIt((reader as any).motion, 'jump', 'motion.jump'), timeIt(map as any, 'draw', 'map.draw')];
  reader.jump = (k: number) => { const t0 = performance.now(); origJump(k); jumpMs.push(Math.round(performance.now() - t0)); };
  const t0open = performance.now();
  map.open(); await wait(900); const openSpan = performance.now() - t0open; map.close(1); await wait(2600);
  reader.jump = origJump;
  undo.forEach(u => u());
  out.mapDetail = { jumpMs, openSpan: Math.round(openSpan), parts };
  out.mapTrip = stop();

  // long holds in wider layouts and both edge styles, full screen
  {
    const { shell } = await import('./core/shell');

    await shell.toggleFullscreen(); await wait(1200);
    const wide: Record<string, unknown> = {};
    const { fitControl } = await import('./reader/verify');
    for (const check of [true, false]) for (const layout of [2, 3] as const) for (const view of ['flow', 'minimal'] as const) {
      fitControl.on = check;
      settings.layout = layout; settings.view = view;
      await reader.settingsChanged('layout'); await wait(800);
      reader.jump(10); await wait(300);
      // time our own work per frame: placing the track, with column building
      const sf: any = reader.surface;
      const place0 = sf.place.bind(sf), make0 = sf.make.bind(sf);
      let tPlace = 0, tMake = 0, nMake = 0, nFrames = 0;
      sf.place = (p: number, v?: number) => { const t = performance.now(); place0(p, v); tPlace += performance.now() - t; nFrames++; };
      sf.make = (k: number) => { const t = performance.now(); make0(k); tMake += performance.now() - t; nMake++; };
      const stop = frames();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
      await wait(5000);
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight' }));
      await wait(1200);
      sf.place = place0; sf.make = make0;
      wide[`${layout}-${view}${check ? '' : ' (no check)'}`] = { ...stop(), cols: reader.M.N, travelled: reader.cur - 10, jsPerFrame: { place: +(tPlace / nFrames).toFixed(2) }, makes: nMake, makeMs: +(tMake / Math.max(1, nMake)).toFixed(2), domCols: document.querySelectorAll('.col').length };
    }
    fitControl.on = true;
    out.wideHold = wide;
    settings.layout = 'auto'; settings.view = 'flow';
    await shell.toggleFullscreen(); await wait(1000);
    await reader.settingsChanged('layout'); await wait(800);
  }
  // fidelity: every column of the book, in every theme
  const { fitStats, resetFitStats, residual } = await import('./reader/verify');
  const fit = () => {
    const N = reader.strip!.N, rng = document.createRange();
    let lines = 0, over = 0, short = 0, worst = 0;
    resetFitStats();
    for (let k = 0; k < N; k++) {
      reader.jump(k);
      const col = document.querySelector(`.col[data-k="${k}"]`);
      if (!col) continue;
      for (const ln of col.querySelectorAll<HTMLElement>('.ln:not(.brk)')) {
        lines++;
        const o = residual(ln);
        if (o > 0.5) { over++; worst = Math.max(worst, o); }
        if (ln.classList.contains('j') && !ln.classList.contains('hy')) {
          rng.selectNodeContents(ln);
          const rs = [...rng.getClientRects()];
          if (rs.length && ln.getBoundingClientRect().right - Math.max(...rs.map(r => r.right)) > 1) short++;
        }
      }
    }
    return { lines, overflow: over, worstOverPx: worst, short, corrected: fitStats.fixed, squeezed: fitStats.squeezed, maxCorrection: fitStats.maxPx, round: (reader as any).round, calibErr: +reader.calibErr.toFixed(3) };
  };
  out.fidelity = { ...fit(), N: reader.strip!.N, focus: reader.M.N, laidOut: reader.strip!.layouts.size, sections: reader.book!.sections.length };
  const themesFit: Record<string, unknown> = {};
  for (const t of ['quiet', 'paper', 'bold', 'calm', 'focus']) {
    settings.theme = t;
    await reader.settingsChanged('layout');
    await until(() => reader.strip!.layouts.size === reader.book!.sections.length, `the ${t} theme's whole-book layout`);
    themesFit[t] = fit();
  }
  // an installed family through the desktop's font path, as a user theme
  const { themes, saveUserTheme, deleteUserTheme, readDesktop } = await import('./reader/themes.svelte');
  const sys = reader.core.systemFamilies ? await reader.core.systemFamilies() : [];
  // installed families the press has never been tuned for, with hostile settings: an odd
  // size, wide letter and word spacing, bold text, narrow margins
  const picks = ['Liberation Serif', 'DejaVu Sans', 'Noto Serif', 'Cantarell', 'Liberation Mono'].filter(f => sys.includes(f));
  for (const [i, fam] of picks.entries()) {
    saveUserTheme({ id: 'selftest-sys', name: 'System', type: { family: fam, fallback: /Sans|Cantarell/.test(fam) ? 'sans' : 'serif', scale: 1.07, weight: 400, bold: 700, boldText: 500, axes: {} },
      options: { boldText: i % 2 === 1, lineSpacing: 1.5, charSpacing: [2, 7, -2, 4, 0][i], wordSpacing: [4, 20, -6, 10, 0][i], margins: -2, justify: true, hyphenate: i !== 2 }, light: null, dark: null });
    settings.theme = 'selftest-sys';
    await reader.settingsChanged('layout');
    await until(() => reader.strip!.layouts.size === reader.book!.sections.length, `the ${fam} theme's whole-book layout`);
    const r = fit();
    reader.jump(12); await wait(50);
    themesFit['system:' + fam] = { ...r, smcp: themes.families[fam]?.smcp ?? null, drawn: getComputedStyle(document.querySelector('.ln')!).fontFamily.split(',')[0] };
    deleteUserTheme('selftest-sys');
  }
  // Original takes the desktop's colours where the desktop publishes them
  await readDesktop(reader.core);
  settings.theme = 'original';
  await reader.settingsChanged('layout');
  out.desktop = { palette: themes.desktop, paper: getComputedStyle(reader.stage.parentElement!).getPropertyValue('--paper'), dataTheme: document.documentElement.getAttribute('data-theme') };
  out.themes = themesFit;
  await log(JSON.stringify(out));
}

/** Records wheel input as the webview delivers it, and where the reader went, while an
 *  outside script plays wheel patterns through a virtual mouse (bench/wheel.sh). */
export async function wheelProbe(reader: Reader, log: (s: string) => Promise<void>) {
  await wait(800);
  ([...document.querySelectorAll<HTMLElement>('.book[data-id]')].find(b => b.textContent?.includes('Thursday')) ?? document.querySelector('.book[data-id]') as HTMLElement).click();
  await until(() => reader.reading, 'the book to open');
  await until(() => !!performance.getEntriesByName('open:all-layout').length, 'the whole-book layout');
  reader.jump(20); await wait(400);
  const t0 = performance.now();
  const ev: unknown[] = [];
  reader.stage.addEventListener('wheel', e => ev.push([Math.round(performance.now() - t0), e.deltaMode, +e.deltaX.toFixed(2), +e.deltaY.toFixed(2), (e as any).wheelDeltaY ?? null]), { capture: true });
  const pos: [number, number][] = [];
  let last = reader.cur;
  const tick = () => { const p = +(reader as any).motion.p.toFixed(3); if (Math.abs(p - last) > 0.002) { pos.push([Math.round(performance.now() - t0), p]); last = p; } if (performance.now() - t0 < 30000) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  await log('ready ' + JSON.stringify({ x: Math.round(window.screenX + innerWidth / 2), y: Math.round(window.screenY + innerHeight / 2), cur: reader.cur }));
  await until(() => performance.now() - t0 > 28000, 'the recording window', 40000);
  await log(JSON.stringify({ events: ev, positions: pos.filter((_, i) => i % 3 === 0 || i === pos.length - 1), cur: reader.cur }));
}

/** Frame times while the settings sheet scrolls (VOLUMEN_SELFTEST=sheet). */
export async function sheetProbe(reader: Reader, log: (s: string) => Promise<void>) {
  await wait(800);
  ([...document.querySelectorAll<HTMLElement>('.book[data-id]')].find(b => b.textContent?.includes('Thursday')) ?? document.querySelector('.book[data-id]') as HTMLElement).click();
  await until(() => reader.reading, 'the book to open');
  await until(() => !!performance.getEntriesByName('open:all-layout').length, 'the whole-book layout');
  const { ui } = await import('./reader/reader.svelte');
  const res: Record<string, unknown> = {};
  const CSS: Record<string, string> = { 'as-is': '' };
  const style = document.createElement('style'); document.head.append(style);
  for (const variant of Object.keys(CSS)) {
    style.textContent = CSS[variant];
    // the theme editor: the tallest sheet, and one that scrolls
    const { editor } = await import('./ui/editor.svelte');
    const { themeById } = await import('./reader/themes.svelte');
    editor.start(themeById('calm'), true);
    ui.sheet = 'theme';
    await until(() => !!document.querySelector('.sheet'), 'the theme editor');
    await wait(700);
    const sh = (document.querySelector('.sheet .scroll') || document.querySelector('.sheet')) as HTMLElement;
    const max = sh.scrollHeight - sh.clientHeight;
    const gaps: number[] = [];
    let last = 0, y = 0, dir = 1;
    const t0 = performance.now();
    await new Promise<void>(done => {
      const f = (t: number) => {
        if (last) gaps.push(t - last);
        last = t;
        y += dir * 9; if (y >= max || y <= 0) dir = -dir;
        sh.scrollTop = y;
        if (t - t0 < 3000) requestAnimationFrame(f); else done();
      };
      requestAnimationFrame(f);
    });
    gaps.sort((a, b) => a - b);
    const q = (x: number) => +gaps[Math.floor((gaps.length - 1) * x)].toFixed(1);
    res[variant] = { frames: gaps.length, p50: q(0.5), p95: q(0.95), max: q(1), over20: gaps.filter(g => g > 20).length, scrollable: max };
    ui.sheet = null; await wait(400);
  }
  await log(JSON.stringify(res));
}

/** Notes, images and fit on books that have them, in WebKitGTK (VOLUMEN_SELFTEST=content). */
export async function contentProbe(reader: Reader, log: (s: string) => Promise<void>) {
  const { invoke } = await import('@tauri-apps/api/core');
  const { ui } = await import('./reader/reader.svelte');
  const out: Record<string, unknown> = {};
  for (const [file, want] of [['beagle.epub', 'figure.img'], ['artofwar.epub', 'a.nr'], ['gibbon1.epub', 'a.nr'], ['tables.epub', '.ln.cell[style*="font-size"]'], ['rich.epub', 'figure.img.rich']] as const) {
    const bytes = new Uint8Array(await invoke<ArrayBuffer>('dev_corpus', { name: file }));
    const e = await reader.core.importFile(bytes, file);
    await reader.open(e.id);
    await until(() => reader.reading, 'the book to open');
    await until(() => reader.strip!.layouts.size === reader.book!.sections.length, `${file}'s whole-book layout`);
    const r: Record<string, unknown> = {};
    // the first column with what this book is about
    let k = -1;
    for (let c = 3; c < reader.strip!.N && k < 0; c++) { reader.jump(c); if (document.querySelector(`.col[data-k="${c}"] ${want}`)) k = c; }
    r.found = k;
    if (want.startsWith('figure.img') && k >= 0) {
      const img = document.querySelector(`.col[data-k="${k}"] ${want} img`) as HTMLImageElement;
      await until(() => img.complete && img.naturalWidth > 0, 'an image through the volimg: scheme', 8000).catch(e => (r.imageError = String(e)));
      r.image = { src: img.src.slice(0, 40), w: img.naturalWidth };
      const fig = img.parentElement as HTMLElement;
      reader.openImage(+fig.dataset.i!, fig);
      await wait(500);
      r.lightbox = !!document.querySelector('.lb img');
      ui.lightbox = null;
    }
    if (want === 'a.nr' && k >= 0) {
      const a = document.querySelector(`.col[data-k="${k}"] a.nr`) as HTMLElement;
      reader.openNote(+a.dataset.n!, a);
      await wait(200);
      r.note = document.querySelector('.bn .body')?.textContent?.slice(0, 50);
      ui.bookNote = null;
    }
    // fit, every column
    let lines = 0, over = 0, pre = 0, sized = 0;
    const ex: string[] = [];
    const vf = await import('./reader/verify');
    vf.resetFitStats();
    for (let c = 0; c < reader.strip!.N; c++) {
      reader.jump(c);
      for (const ln of document.querySelectorAll<HTMLElement>(`.col[data-k="${c}"] .ln:not(.brk)`)) {
        lines++;
        if (ln.classList.contains('pre')) pre++;
        else if (ln.style.fontSize) sized++;
        const d = vf.residual(ln);
        if (d > 0.5) { over++; if (ex.length < 6) ex.push(`${d}px ${ln.className}: ${ln.innerHTML.slice(0, 140)}`); }
      }
    }
    r.fit = { linkRuns: (reader as any).linkRuns, lines, pre, sized, mono: document.fonts.check('16px "JetBrains Mono"'), overflow: over, corrected: vf.fitStats.fixed, subpx: vf.fitStats.subpx, maxCorrection: vf.fitStats.maxPx, calibErr: +reader.calibErr.toFixed(3), examples: ex, missed: vf.fitStats.samples.slice(0, 3) };
    out[file] = r;
    const id = reader.book!.id;
    reader.close();
    await wait(300);
    // read again from its kept file (as a later importer would): it opens as before
    if (file === 'rich.epub') {
      const again = await reader.core.reimport(id).catch(e => ({ error: String(e) }) as any);
      await reader.open(id);
      await until(() => reader.reading && reader.strip!.layouts.size === reader.book!.sections.length, 'the book read again to open');
      out.reread = { importer: again.importer, error: again.error, rich: reader.book!.images.filter(i => i[3] === 'application/xhtml+xml' && i[0] > 0).length };
      reader.close();
      await wait(300);
    }
  }
  await log(JSON.stringify(out));
}

/** Library search on the desktop's full-text index (VOLUMEN_SELFTEST=search): how long
 *  queries take over the self-test's library (the corpus books, and the generated ones if
 *  the library probe ran), once the indexer has caught up. */
export async function searchProbe(reader: Reader, log: (s: string) => Promise<void>) {
  const { invoke } = await import('@tauri-apps/api/core');
  const have = await reader.core.library();
  for (const f of ['thursday.epub', 'beagle.epub', 'artofwar.epub', 'gibbon1.epub', 'middlemarch.epub']) {
    if (have.some(b => f.startsWith(b.title.toLowerCase().split(' ')[0]))) continue;
    const bytes = new Uint8Array(await invoke<ArrayBuffer>('dev_corpus', { name: f }).catch(() => new ArrayBuffer(0)));
    if (bytes.length) await reader.core.importFile(bytes, f).catch(() => {});
  }
  const books = (await reader.core.library()).length;
  // the indexer works in the background: wait until a common word's count stops growing
  let last = -1, t0 = performance.now();
  for (;;) {
    const r = await reader.core.searchLibrary('the');
    const n = r.reduce((a, b) => a + b.total, 0);
    if (n === last && n > 0) break;
    last = n;
    if (performance.now() - t0 > 60000) break;
    await wait(700);
  }
  const indexedMs = Math.round(performance.now() - t0);
  const out: Record<string, unknown> = { books, indexedMs };
  for (const q of ['saffron park', 'the sea', 'anarchist', 'gregory syme', 'wild engine', 'zzqqxx']) {
    const ms: number[] = [];
    let res: Awaited<ReturnType<typeof reader.core.searchLibrary>> = [];
    for (let i = 0; i < 3; i++) { const a = performance.now(); res = await reader.core.searchLibrary(q); ms.push(performance.now() - a); }
    out[q] = { ms: ms.map(x => +x.toFixed(1)), books: res.length, total: res.reduce((a, b) => a + b.total, 0), phrase: res[0]?.phrase ?? null, first: res[0]?.hits[0] ? res[0].hits[0].before.slice(-20) + '[' + res[0].hits[0].matched + ']' : null };
  }
  await log(JSON.stringify(out));
}

/** Frame times while a large library scrolls (VOLUMEN_SELFTEST=library). Adds generated
 *  books to the self-test's own library until it holds 200. */
export async function libraryProbe(reader: Reader, log: (s: string) => Promise<void>) {
  const { ui } = await import('./reader/reader.svelte');
  const have = (await reader.core.library()).length;
  const words = ['Ash', 'Harbour', 'Quiet', 'Lantern', 'Meridian', 'Superintelligence', 'Orchard', 'Tide', 'Cartographer', 'Ember'];
  for (let i = have; i < 200; i++) {
    const title = `${words[i % 10]} ${words[(i * 7) % 10]} ${i}`;
    const txt = `Title: ${title}\nAuthor: Writer ${i}\n\nCHAPTER I\n\n` + 'A paragraph of text that goes on for a while. '.repeat(40);
    await reader.core.importFile(new TextEncoder().encode(txt), `${i}.txt`);
  }
  ui.libVersion++;
  await until(() => document.querySelectorAll('.book[data-id]').length >= 200, 'the library to list 200 books', 30000);
  await wait(1500);
  const CSS: Record<string, string> = {
    'as-is': '',
    'no-lift': '.lift::after { display: none !important; }',

  };
  const style = document.createElement('style'); document.head.append(style);
  const res: Record<string, unknown> = {};
  for (const [name, css] of Object.entries(CSS)) {
    style.textContent = css;
    await wait(500);
    const shelf = document.querySelector('.shelf') as HTMLElement;
    shelf.scrollTop = 0; await wait(300);
    const max = shelf.scrollHeight - shelf.clientHeight;
    const gaps: number[] = [];
    let last = 0, y = 0;
    const t0 = performance.now();
    await new Promise<void>(done => {
      const f = (t: number) => {
        if (last) gaps.push(t - last);
        last = t;
        y = Math.min(max, y + 22);
        shelf.scrollTop = y;
        if (y < max && t - t0 < 6000) requestAnimationFrame(f); else done();
      };
      requestAnimationFrame(f);
    });
    gaps.sort((a, b) => a - b);
    const q = (x: number) => +gaps[Math.floor((gaps.length - 1) * x)].toFixed(1);
    res[name] = { frames: gaps.length, p50: q(0.5), p95: q(0.95), max: q(1), over20: gaps.filter(g => g > 20).length };
  }
  style.remove();
  await log(JSON.stringify(res));
}

/** Press against webview, string by string, for diagnosing a model gap
 *  (VOLUMEN_SELFTEST=probe). A probe starting "<i>" is set in italic. */
export async function probeStrings(reader: Reader, log: (s: string) => Promise<void>) {
  await wait(800);
  ([...document.querySelectorAll<HTMLElement>('.book[data-id]')].find(b => b.textContent?.includes('Thursday')) ?? document.querySelector('.book[data-id]') as HTMLElement).click();
  await until(() => reader.reading, 'the book to open');
  await until(() => !!performance.getEntriesByName('open:all-layout').length, 'the layout');
  const T = (new URLSearchParams(location.search).get('t') || '').split('|').filter(Boolean).length ? (new URLSearchParams(location.search).get('t') || '').split('|') : ['stone\u200a…”', 'stone…”', '\u200a', 'a\u200ab', 'ab', 'a\u2009b', 'a\u2002b', 'a\u00a0b', 'a b'];
  const params = { ...(reader as any).params() };
  const w = await reader.core.probe(params, T);
  const pr = document.createElement('div'); pr.className = 'ln';
  pr.style.cssText = `visibility:hidden;left:0;top:0;width:auto;--o:${params.size};font-size:${params.size}px`;
  reader.stage.parentElement!.append(pr);
  const rows = T.map((t, i) => {
    if (t.startsWith('<i>')) pr.innerHTML = '<i>' + t.slice(3) + '</i>'; else pr.textContent = t;
    return `${JSON.stringify(t)} dom ${pr.getBoundingClientRect().width.toFixed(3)} exact ${w[3 * i].toFixed(3)} round ${w[3 * i + 1].toFixed(3)} sixtieths ${w[3 * i + 2].toFixed(3)}`;
  });
  // word spacing across inline links: the same text, with and without <a>
  const html = 'stone\u200a…”</a>, <a class="xr">“Energy may be likened to the bending of a crossbow\u200a…”</a>,';
  for (const [name, h] of [['links', '<a class="xr">' + html], ['spans', ('<span>' + html).replace(/<a class="xr">/g, '<span>').replace(/<\/a>/g, '</span>')], ['text', 'stone\u200a…”, “Energy may be likened to the bending of a crossbow\u200a…”,']]) {
    for (const ws of ['0px', '-0.716px']) {
      pr.innerHTML = h; pr.style.setProperty('--fit', ws);
      const r = document.createRange(); r.selectNodeContents(pr);
      rows.push(`${name} fit=${ws}: ${r.getBoundingClientRect().width.toFixed(3)}`);
    }
  }
  pr.remove();
  await log(JSON.stringify({ round: (reader as any).round, rows }));
}

/** Fit under display scaling (VOLUMEN_SELFTEST=scale): the webview zoomed to 125% and 150%,
 *  every theme laid out again and every line checked. */
export async function scaleProbe(reader: Reader, log: (s: string) => Promise<void>) {
  const { invoke } = await import('@tauri-apps/api/core');
  const { settings } = await import('./reader/settings.svelte');
  const vf = await import('./reader/verify');
  await wait(800);
  ([...document.querySelectorAll<HTMLElement>('.book[data-id]')].find(b => b.textContent?.includes('Thursday')) ?? document.querySelector('.book[data-id]') as HTMLElement).click();
  await until(() => reader.reading, 'the book to open');
  await until(() => !!performance.getEntriesByName('open:all-layout').length, 'the layout');
  const out: Record<string, unknown> = {};
  for (const z of [1.25, 1.5]) {
    await invoke('dev_zoom', { scale: z });
    await wait(1200);
    for (const t of ['original', 'paper', 'bold', 'focus']) {
      settings.theme = t;
      await reader.settingsChanged('layout');
      await until(() => reader.strip!.layouts.size === reader.book!.sections.length, 'the layout');
      vf.resetFitStats();
      let lines = 0, over = 0;
      for (let c = 0; c < reader.strip!.N; c++) {
        reader.jump(c);
        for (const ln of document.querySelectorAll<HTMLElement>(`.col[data-k="${c}"] .ln:not(.brk)`)) { lines++; if (vf.residual(ln) > 0.5) over++; }
      }
      out[`${z} ${t}`] = { dpr: devicePixelRatio, fs: reader.M.fs, round: (reader as any).round, calibErr: +reader.calibErr.toFixed(3), lines, overflow: over, corrected: vf.fitStats.fixed, subpx: vf.fitStats.subpx, missed: vf.fitStats.samples.slice(0, 2) };
    }
  }
  await invoke('dev_zoom', { scale: 1 });
  settings.theme = 'original';
  await log(JSON.stringify(out));
}
