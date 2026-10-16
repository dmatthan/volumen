<script lang="ts">
  import { keyHint, touchUI } from './touch';
  import { coverThumb } from './thumb';
  import { fitImage, fitTitle } from './covers';
  import { backup, restore, isBackup } from '../core/backup';
  import { shell } from '../core/shell';
  import ShareSheet from './ShareSheet.svelte';
  import InviteSheet from './InviteSheet.svelte';
  import DraftSheet from './DraftSheet.svelte';
  import EpubSheet from './EpubSheet.svelte';
  import { earlierDraft } from '../reader/draft';
  import { droppedFiles } from './files';
  import { stale } from '../reader/reread';
  import { isTauri } from '../core/shell';
  import { isIOS, isInstalled } from '../core/env';
  import { removeBook, keepLibrary, collectSoon, rereadStale } from './library';
  import { sharedOf } from '../core/service';
  import type { Core, LibEntry } from '../core/types';
  import { kv } from '../core/kv';
  import { type Reader } from '../reader/reader.svelte';
  import { ui, toast } from '../state.svelte';
  import Sheet from './Sheet.svelte';
  import Help from './Help.svelte';
  import LibraryNotebook from './LibraryNotebook.svelte';
  import LibraryResults from './LibraryResults.svelte';
  import { fold } from '../reader/notebook';
  import { hint } from '../reader/hints';
  import { takeNotes as takeNotesIn } from '../reader/intake';
  import { isNotesMarkdown } from '../reader/notesmd';
  import { isWebAnno } from '../reader/webanno';
  import { SMART, shelves, loadShelves, onShelf, createShelf, renameShelf, deleteShelf, toggleShelf, addToShelf } from './shelves.svelte';

  let { core, reader, hidden }: { core: Core; reader: Reader; hidden: boolean } = $props();
  let books: LibEntry[] = $state([]);
  let grid: HTMLElement;
  let file: HTMLInputElement;
  let removing: LibEntry | null = $state(null);
  let sharing: LibEntry | null = $state(null);
  let draftOf: { from: LibEntry; to: LibEntry } | null = $state(null);
  let epubOf: LibEntry | null = $state(null);
  /** The shelf shown: one that fills itself, or a collection. */
  loadShelves();
  let shelf = $state(kv.get<string>('shelf', 'all'));
  if (!SMART.some(x => x.id === shelf) && !shelves.list.some(c => c.id === shelf)) shelf = 'all';
  const allShelves = $derived([...SMART, ...shelves.list]);
  /** A search: the books whose title or author has every word, across the library, and
   *  the matches in their text beneath (LibraryResults). */
  let query = $state('');
  let searchEl: HTMLInputElement | undefined = $state();
  let results: LibraryResults | undefined = $state();
  const words = $derived(fold(query).split(/\s+/).filter(Boolean));
  const shown = $derived(words.length
    ? books.filter(b => { const h = fold(`${b.title} ${b.author}`); return words.every(w => h.includes(w)); })
    : books.filter(b => onShelf(shelf, b)));
  function searchKey(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      // the first Esc clears the search, the next leaves the field
      e.preventDefault(); e.stopPropagation();
      if (query) query = ''; else { searchEl?.blur(); restoreFocus(); }
    } else if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault(); e.stopPropagation();
      const first = grid.querySelector<HTMLElement>('.slot .book');
      if (first && shown.length) first.focus(); else results?.focusFirst();
    }
  }
  const mine = $derived(shelves.list.find(c => c.id === shelf) ?? null);
  function setShelf(id: string) { shelf = id; kv.set('shelf', id); requestAnimationFrame(restoreFocus); }
  function stepShelf(d: number) {
    const i = allShelves.findIndex(x => x.id === shelf);
    setShelf(allShelves[(i + d + allShelves.length) % allShelves.length].id);
  }
  /** The book whose sheet is open (its collections, removing it). */
  let sheetBook: LibEntry | null = $state(null);
  let newName = $state('');
  function bookSheet(b: LibEntry) { sheetBook = b; newName = ''; ui.sheet = 'book'; }
  function addNew(b: LibEntry) {
    const c = createShelf(newName);
    if (c) { addToShelf(c.id, b.id); newName = ''; toast(`In “${c.name}”.`); }
  }
  let renaming = $state('');
  /** Books, or every book's notebook. */
  let view: 'books' | 'notebook' = $state('books');
  let notebook: LibraryNotebook | undefined = $state();
  function setView(v: typeof view) {
    view = v;
    if (v === 'books') requestAnimationFrame(restoreFocus);
  }
  let dropping = $state(false);
  let focusId: string | null = kv.get('lastOpened', null);
  /** Cover images as object URLs, loaded once per book. */
  let covers: Record<string, string> = $state({});
  const loading = new Set<string>();
  function loadCovers(list: LibEntry[]) {
    for (const b of list) {
      if (!b.cover || covers[b.id] || loading.has(b.id)) continue;
      loading.add(b.id);
      core.cover(b.id).then(async buf => {
        if (!buf.byteLength) return;
        // a large cover is drawn down once and kept small (ui/thumb.ts)
        const small = await coverThumb(buf);
        if (small) core.setCover(b.id, await small.arrayBuffer()).catch(() => {});
        covers[b.id] = URL.createObjectURL(small ?? new Blob([buf]));
      });
    }
  }

  async function load() {
    const list = await core.library();
    loadCovers(list);
    books = list.sort((a, z) => (kv.get<number>('opened.' + z.id, z.added) - kv.get<number>('opened.' + a.id, a.added)));
    rereadStale(core, list, () => reader.book?.id);
    collectSoon(core, id => books.find(b => b.id === id)?.title ?? 'a book');
  }

  $effect(() => { ui.libVersion; load().then(() => { if (!hidden) restoreFocus(); }); });
  $effect(() => { if (!hidden) requestAnimationFrame(restoreFocus); });
  // with a few books, how to find things among them
  // on an iPhone or iPad, in Safari, not yet on the Home Screen: how to put it there, once
  // (volumen.page sends people here to do it, so the library is what is installed)
  $effect(() => {
    if (!hidden && isIOS && !isInstalled() && !isTauri) setTimeout(() => !hidden && hint('touch-install', 'To keep Volumen on your Home Screen: tap Share, then Add to Home Screen. It then opens full screen and reads offline.', 8000), 1500);
  });
  $effect(() => { if (!hidden && books.length >= 3) setTimeout(() => !hidden && hint('lib-search', '/ searches titles and the text of every book. [ ] switch shelves; A puts a book in a collection.'), 1200); });

  function restoreFocus() {
    // (not from under an open sheet: it keeps the focus)
    if (ui.sheet) return;
    const el = (focusId && grid?.querySelector<HTMLElement>(`[data-id="${CSS.escape(focusId)}"]`)) || grid?.querySelector<HTMLElement>('.book');
    el?.focus({ preventScroll: false });
  }

  function progress(b: LibEntry) {
    const s = kv.get<{ where: string; done: boolean } | null>('state.' + b.id, null);
    // a writer's book that readers have sent notes on says so
    const fb = Object.keys(kv.get<Record<string, unknown>>('fb.' + b.id, {})).length;
    const notes = fb ? ` · notes from ${fb} reader${fb === 1 ? '' : 's'}` : '';
    if (!s) return 'Not started' + notes;
    return (s.done ? 'Finished' : s.where) + notes;
  }

  function hue(b: LibEntry) {
    let h = 0;
    for (const ch of b.title) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return h % 360;
  }

  function open(b: LibEntry) {
    focusId = b.id;
    kv.set('lastOpened', b.id);
    kv.set('opened.' + b.id, Date.now());
    reader.open(b.id);
  }

  /** Notes files (JSON, Markdown exported from a notebook, Web Annotations): one's own
   *  notes are put back on their books; another reader's are kept as feedback on theirs. */
  async function takeNotes(texts: string[], names: string[] = []) {
    const { said } = await takeNotesIn(core, texts, books, undefined, names);
    // (putting one's own notes back read their books in the engine; none is open here)
    if (!reader.book) core.idle?.();
    toast(said, Math.max(5200, said.length * 60));
    ui.libVersion++;
  }

  /** The whole library in one file (core/backup.ts). */
  async function backUp() {
    toast('Gathering the library…', 8000);
    const b = await backup(core);
    const bytes = new Uint8Array(await b.blob.arrayBuffer());
    const day = new Date().toISOString().slice(0, 10);
    if (await shell.saveBytes(`Volumen library ${day}.vbackup`, bytes)) {
      toast(`Backed up: ${b.books} book${b.books === 1 ? '' : 's'} and everything about them.${b.missing.length ? ` Not their files: ${b.missing.join(', ')} (added before files were kept: add them again).` : ''}`, 6000);
    }
  }
  async function restoreFrom(f: File) {
    toast('Restoring the library…', 15000);
    const r = await restore(core, f);
    if (typeof r === 'string') { toast(r, 5200); return; }
    toast(`Restored: ${r.books} book${r.books === 1 ? '' : 's'} added${r.failed.length ? `; could not read ${r.failed.join(', ')}` : ''}. Reloading…`, 4000);
    // (settings, themes and collections are read as the app starts)
    setTimeout(() => location.reload(), 1600);
  }

  async function addFiles(files: FileList | File[]) {
    // books first, then notes: a folder holding a manuscript and its readers' notes is
    // taken whole
    const notes: string[] = [], names: string[] = [];
    for (const f of files) {
      if (/\.vbackup$/i.test(f.name) || (f.size > 10 && await isBackup(f))) { await restoreFrom(f); return; }
      if (/\.vnotes$/i.test(f.name)) { notes.push(await f.text()); names.push(f.name); continue; }
      // notes exported as Markdown (rather than a manuscript), or as Web Annotations
      if (/\.(md|markdown|txt|json|jsonld)$/i.test(f.name) && f.size < 8e6) {
        const text = await f.text();
        if (isNotesMarkdown(text) || isWebAnno(text)) { notes.push(text); names.push(f.name); continue; }
        if (/\.(json|jsonld)$/i.test(f.name)) { notes.push(text); names.push(f.name); continue; }
      }
      toast(`Opening ${f.name}…`, 8000);
      try {
        const e = await core.importFile(new Uint8Array(await f.arrayBuffer()), f.name);
        focusId = e.id;
        // a new draft of a book here already: offered its notes, feedback and share
        const before = draftOf ? null : earlierDraft(e, await core.library());
        if (before) draftOf = { from: before, to: e };
        if (mine) addToShelf(mine.id, e.id);
        toast(`Added “${e.title}”.`, 3600);
        keepLibrary();
      } catch (err) {
        const m = `Couldn’t open ${f.name}: ${(err as Error).message}`;
        toast(m, Math.max(5200, m.length * 70));
      }
    }
    if (notes.length) { await load(); await takeNotes(notes, names); }
    if (draftOf) ui.sheet = 'draft';
    await load();
    restoreFocus();
  }

  function add() {
    if (core.pick) {
      core.pick().then(async p => {
        if (p?.kind === 'notes') { takeNotes([p.text]); return; }
        if (p?.kind === 'backup') { restoreFrom(p.file as File); return; }
        const e = p?.entry;
        if (e) { focusId = e.id; if (mine) addToShelf(mine.id, e.id); toast(`Added “${e.title}”.`, 3600); await load(); restoreFocus(); }
      })
        .catch(err => toast(`Couldn’t open it: ${(err as Error).message}`, 5200));
    } else file.click();
  }

  async function remove(b: LibEntry) {
    removing = null;
    try { await removeBook(core, b.id); }
    catch (e) { toast(`“${b.title}” is shared, and its link could not be withdrawn (${(e as Error).message}). It is still in your library.`, 6000); return; }
    toast('Removed from the library.');
    await load();
    restoreFocus();
  }

  /** Arrow keys and hjkl move through the grid. */
  export function key(e: KeyboardEvent): boolean {
    if (e.key === 'n' || e.key === 'N') { setView(view === 'books' ? 'notebook' : 'books'); return true; }
    if (view === 'notebook') {
      if (e.key === 'Escape' || e.key === 'b' || e.key === 'B') { setView('books'); return true; }
      if (e.key === '?') { ui.sheet = 'help'; return true; }
      return notebook?.key(e) ?? false;
    }
    const items = [...grid.querySelectorAll<HTMLElement>('.book')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    const k = e.key;
    if (k === 'o' || k === 'O') { add(); return true; }
    if (k === '/') { searchEl?.focus(); searchEl?.select(); return true; }
    if ((document.activeElement as Element)?.closest?.('.res')) return results?.key(e) ?? false;
    if (k === ']' || k === '[') { stepShelf(k === ']' ? 1 : -1); return true; }
    if ((k === 'a' || k === 'A') && i >= 0 && items[i].dataset.id) { const b = books.find(b => b.id === items[i].dataset.id); if (b) bookSheet(b); return true; }
    if (k === '?') { ui.sheet = 'help'; return true; }
    if (i < 0) {
      if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'h', 'j', 'k', 'l'].includes(k)) { items[0]?.focus(); return true; }
      return false;
    }
    const top0 = items[0].getBoundingClientRect().top;
    const perRow = Math.max(1, items.filter(x => Math.abs(x.getBoundingClientRect().top - top0) < 2).length);
    let j = i;
    if (k === 'ArrowRight' || k === 'l') j = i + 1;
    else if (k === 'ArrowLeft' || k === 'h') j = i - 1;
    else if (k === 'ArrowDown' || k === 'j') j = i + perRow;
    else if (k === 'ArrowUp' || k === 'k') j = i - perRow;
    else if ((k === 'x' || k === 'Delete') && items[i].dataset.id) { const b = books.find(b => b.id === items[i].dataset.id); if (b) { removing = b; ui.sheet = 'remove'; } return true; }
    else return false;
    items[Math.max(0, Math.min(items.length - 1, j))].focus();
    return true;
  }
</script>

<section class="shelf" {hidden} aria-label="Library"
  ondragover={e => { e.preventDefault(); dropping = true; }}
  ondragleave={() => (dropping = false)}
  ondrop={e => { e.preventDefault(); dropping = false; if (e.dataTransfer?.items.length) droppedFiles(e.dataTransfer).then(addFiles); }}
  class:dropping>
  <header class="head">
    <div class="title">
      <h1>Library</h1>
      <div class="seg" role="group" aria-label="Show">
        <button aria-pressed={view === 'books'} onclick={() => setView('books')}>Books</button>
        <button aria-pressed={view === 'notebook'} onclick={() => setView('notebook')}>Notebook <kbd>N</kbd></button>
      </div>
    </div>
    <div class="head-acts">
      {#if view === 'books'}
        <label class="search">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
          <input bind:this={searchEl} type="search" bind:value={query} onkeydown={searchKey} placeholder={'Search books and their text' + keyHint('/')} aria-label="Search the library" spellcheck="false" autocomplete="off" />
        </label>
      {/if}
      <button class="btn add-btn" onclick={add} aria-label="Add a book (O)"><span class="add-l">Add a book</span><span class="add-p" aria-hidden="true">+</span> <kbd>O</kbd></button>
      <button class="btn quiet keys-only" onclick={() => (ui.sheet = 'help')} aria-label="Keyboard shortcuts">Keys <kbd>?</kbd></button>
    </div>
  </header>
  {#if view === 'notebook'}
    <LibraryNotebook bind:this={notebook} {books} {reader} />
  {/if}
  {#if view === 'books'}
    <div class="shelves" class:off={words.length > 0} role="tablist" aria-label="Shelves ( [ and ] )">
      {#each allShelves as x (x.id)}
        <button role="tab" aria-selected={shelf === x.id} class:own={!SMART.some(m => m.id === x.id)} onclick={() => setShelf(x.id)}>{x.name}</button>
      {/each}
      {#if mine}
        <span class="sh-acts">
          <button class="btn quiet" onclick={() => { renaming = mine.name; ui.sheet = 'shelf'; }}>Rename or delete…</button>
        </span>
      {/if}
    </div>
  {/if}
  <div class="books" bind:this={grid} hidden={view !== 'books'}>
    {#if words.length && !shown.length}
      <p class="none">No title or author matches “{query.trim()}”.</p>
    {:else if !words.length && !shown.length && shelf !== 'all'}
      <p class="none">{mine ? `Nothing in “${mine.name}” yet. Press A on a book to put it here, or add a book while this shelf is open.` : shelf === 'reading' ? 'No book under way.' : shelf === 'finished' ? 'No book finished yet.' : 'Every book has been opened.'}</p>
    {/if}
    {#each shown as b (b.id)}
      <div class="slot">
      <button class="book" data-id={b.id} onclick={() => open(b)} oncontextmenu={e => { e.preventDefault(); bookSheet(b); }} aria-label="{b.title}, {progress(b)}. A for collections.">
        {#if covers[b.id]}
          <div class="cover img lift small" aria-hidden="true"><img src={covers[b.id]} alt="" decoding="async" loading="lazy" use:fitImage /></div>
        {:else}
          <div class="cover lift small" style="--ch:{hue(b)}" aria-hidden="true" use:fitTitle>
            <span class="c-author">{b.author}</span>
            <span class="c-title">{b.title}</span>
            <span class="c-year">{b.year}</span>
          </div>
        {/if}
        <span class="meta"><span class="t">{b.title}</span><span class="s">{progress(b)}</span></span>
      </button>
      <button class="more hover-reveal" onclick={() => bookSheet(b)} aria-label="Collections and more for {b.title} (A)" tabindex="-1">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="18" cy="12" r="1.6" /></svg>
      </button>
      </div>
    {/each}
    {#if !words.length && (shelf === 'all' || mine)}
    <button class="book add" onclick={add} aria-label="Add a book from an EPUB, Word, Markdown or text file">
      <div class="cover" aria-hidden="true"><span class="plus">+</span><span class="c-t">Add a book</span><span class="c-s">EPUB, Word, Markdown or text</span></div>
      <span class="meta"><span class="t">&nbsp;</span></span>
    </button>
    {/if}
  </div>
  {#if view === 'books'}<LibraryResults bind:this={results} {core} {reader} {query} {books} />{/if}
  <p class="foot" hidden={view !== 'books'}>Books stay on this device. <button class="link-btn" onclick={backUp}>Back up the library…</button> (Restore one by adding its file.) <span class="keys-only">Use the arrow keys or H J K L to move, Enter to open, A for a book’s collections, [ and ] for the shelves, X to remove.</span></p>
  <!-- (a phone's picker greys out what it cannot match to a type it knows, notes files
       among them; there every file may be chosen, and the importer says what it is) -->
  <input type="file" bind:this={file} accept={touchUI() ? undefined : '.epub,.docx,.md,.markdown,.txt,.vnotes,.json,.jsonld,.vbackup,application/epub+zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/markdown,text/plain'} multiple
    onchange={e => { const fs = (e.target as HTMLInputElement).files; if (fs?.length) addFiles([...fs]); (e.target as HTMLInputElement).value = ''; }} hidden />
</section>

{#if !hidden && ui.sheet === 'help'}
  <Help onclose={() => (ui.sheet = null)} />
{/if}
{#if !hidden && ui.sheet === 'book' && sheetBook}
  {@const b = sheetBook}
  <Sheet label="{b.title}: collections" onclose={() => { ui.sheet = null; sheetBook = null; }} onkey={e => {
    if ((e.target as Element).closest?.('input')) return false;
    const n = +e.key;
    if (n >= 1 && n <= 9 && shelves.list[n - 1]) { toggleShelf(shelves.list[n - 1].id, b.id); return true; }
    if (e.key === 'x' || e.key === 'Delete') { removing = b; sheetBook = null; ui.sheet = 'remove'; return true; }
    return false;
  }}>
    <div><p class="eyebrow">Collections</p><h2>{b.title}</h2>
      {#if stale(b) && !b.source}<p class="where">Read by an earlier version of Volumen. Add its file again to see it as Volumen now reads it: your place and notes stay.</p>{/if}</div>
    <div class="cols" role="group" aria-label="Collections">
      {#each shelves.list as c, i (c.id)}
        <label class="col-row"><input type="checkbox" checked={c.books.includes(b.id)} onchange={() => toggleShelf(c.id, b.id)} /><span class="cn">{c.name}</span>{#if i < 9}<kbd>{i + 1}</kbd>{/if}</label>
      {/each}
      <form class="new" onsubmit={e => { e.preventDefault(); addNew(b); }}>
        <input type="text" placeholder={shelves.list.length ? 'New collection' : 'Name a first collection, e.g. Essays'} bind:value={newName} aria-label="New collection" />
        <button class="btn" type="submit" disabled={!newName.trim()}>Add</button>
      </form>
    </div>
    <button class="btn quiet share" onclick={() => { sharing = b; sheetBook = null; ui.sheet = 'share'; }}>Share as a link…</button>
    {#if b.source}<button class="btn quiet share" onclick={() => { epubOf = b; sheetBook = null; ui.sheet = 'epub'; }}>Save as EPUB…</button>{/if}
    <div class="acts two">
      <button class="btn quiet" onclick={() => { removing = b; sheetBook = null; ui.sheet = 'remove'; }}>Remove book <kbd>X</kbd></button>
      <button class="btn primary" data-autofocus onclick={() => { ui.sheet = null; sheetBook = null; }}>Done <kbd>Esc</kbd></button>
    </div>
  </Sheet>
{/if}
{#if !hidden && ui.sheet === 'share' && sharing}
  <ShareSheet {core} book={sharing} onclose={() => { ui.sheet = null; sharing = null; }} />
{/if}
{#if !hidden && ui.sheet === 'epub' && epubOf}
  <EpubSheet {core} book={epubOf} onclose={() => { ui.sheet = null; epubOf = null; }} />
{/if}
{#if !hidden && ui.sheet === 'draft' && draftOf}
  <DraftSheet {core} from={draftOf.from} to={draftOf.to} remove={remove} onclose={() => { ui.sheet = null; draftOf = null; }} />
{/if}
{#if !hidden && ui.sheet === 'invite' && ui.invite}
  <InviteSheet {core} />
{/if}
{#if !hidden && ui.sheet === 'shelf' && mine}
  {@const c = mine}
  <Sheet label="Collection {c.name}" onclose={() => (ui.sheet = null)}>
    <div><p class="eyebrow">Collection</p><h2>{c.name}</h2><p class="where">{c.books.length} book{c.books.length === 1 ? '' : 's'}. Deleting it leaves the books in the library.</p></div>
    <form class="new" onsubmit={e => { e.preventDefault(); renameShelf(c.id, renaming); ui.sheet = null; }}>
      <input type="text" bind:value={renaming} aria-label="Name" data-autofocus />
      <button class="btn" type="submit" disabled={!renaming.trim() || renaming.trim() === c.name}>Rename</button>
    </form>
    <div class="acts two">
      <button class="btn quiet" onclick={() => { deleteShelf(c.id); ui.sheet = null; setShelf('all'); toast(`Deleted “${c.name}”.`); }}>Delete the collection</button>
      <button class="btn primary" onclick={() => (ui.sheet = null)}>Done <kbd>Esc</kbd></button>
    </div>
  </Sheet>
{/if}
{#if !hidden && ui.sheet === 'remove' && removing}
  {@const b = removing}
  <Sheet label="Remove a book" onclose={() => { ui.sheet = null; removing = null; }} onkey={e => { if (e.key === 'y' || e.key === 'Enter') { ui.sheet = null; remove(b); return true; } return false; }}>
    <div><p class="eyebrow">Remove from the library</p><h2>{b.title}</h2>
      <p class="where">Your place, highlights and notes for this book are removed too.{#if sharedOf(b.id)} Its link stops working, and readers’ notes waiting for you go with it.{/if}</p></div>
    <div class="acts two">
      <button class="btn" data-autofocus onclick={() => { ui.sheet = null; removing = null; }}>Keep it <kbd>Esc</kbd></button>
      <button class="btn primary" onclick={() => { ui.sheet = null; remove(b); }}>Remove <kbd>Y</kbd></button>
    </div>
  </Sheet>
{/if}

<style>
  /* the shelf scrolls down and only down: covers' shadows reach past its sides, and a
     sideways swipe moved it a few pixels to show nothing */
  .shelf { position: absolute; inset: 0; overflow-y: auto; overflow-x: hidden; touch-action: pan-y; background: var(--ground); padding: 36px max(20px, 6vw) 56px; box-sizing: border-box; }
  .shelf.dropping { outline: 3px dashed var(--accent); outline-offset: -12px; }
  .head { max-width: 1040px; display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 32px; }
  .title { display: flex; align-items: center; gap: 20px; flex-wrap: wrap; }
  .seg { display: inline-flex; padding: 3px; border-radius: var(--r-m); background: var(--read); }
  .seg button { appearance: none; border: 0; background: none; cursor: pointer; padding: 8px 14px; border-radius: 9px; font: 600 var(--t-s)/1.2 var(--f-ui); color: var(--ink-2); display: inline-flex; align-items: center; gap: 8px; }
  .seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px oklch(0 0 0 / 0.12); }
  .seg kbd { font-size: 11px; }
  .books[hidden], .foot[hidden] { display: none; }
  .search { display: flex; align-items: center; gap: 8px; width: min(320px, 40vw); height: 44px; box-sizing: border-box; padding: 0 14px; border-radius: var(--r-m); border: 1.5px solid var(--rule); background: var(--surface); color: var(--ink-3); cursor: text; }
  .search:focus-within { border-color: var(--accent); }
  .search svg { width: 17px; height: 17px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; }
  .search input { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: transparent; color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0; }
  .search input::placeholder { color: var(--ink-3); }
  .shelves.off { opacity: .4; pointer-events: none; }
  .shelves { max-width: 1040px; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: -10px 0 30px; }
  .shelves > button { appearance: none; border: 1.5px solid var(--rule); background: none; cursor: pointer; height: 36px; padding: 0 14px; border-radius: 18px; font: 600 var(--t-s)/1 var(--f-ui); color: var(--ink-2); }
  :global(html:not(.touchui)) .shelves > button:not([aria-selected="true"]):hover { background: var(--hover); color: var(--ink); }
  .shelves > button[aria-selected="true"] { background: var(--ink); border-color: var(--ink); color: var(--ground); }
  .shelves > button.own { font-style: normal; }
  .shelves > button:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .sh-acts { margin-left: auto; }
  .none { grid-column: 1 / -1; margin: 0; font: 500 var(--t-m)/1.5 var(--f-ui); color: var(--ink-3); max-width: 60ch; }
  /* Nothing here is positioned at rest: WebKitGTK gives every positioned element a layer
     of its own, and 200 more of them slowed the shelf's scrolling. The book and its ⋯
     share one grid cell; the ⋯ exists only while the book is hovered or focused. */
  .slot { display: grid; min-width: 0; }
  .slot > .book, .slot > .more { grid-area: 1 / 1; }
  .slot > .book { width: 100%; }
  .more { display: none; justify-self: end; align-self: start; margin: 6px; width: 32px; height: 32px; border-radius: 16px; border: 0; padding: 0; cursor: pointer; place-items: center;
    background: color-mix(in srgb, var(--surface) 88%, transparent); color: var(--ink); }
  .more svg { width: 18px; height: 18px; fill: currentColor; }
  :global(html:not(.touchui)) .slot:hover .more, .slot:focus-within .more { display: grid; position: relative; z-index: 1; animation: more-in .15s ease-out; }
  @keyframes more-in { from { opacity: 0; } }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr); gap: 2px; }
  .col-row { display: flex; align-items: center; gap: 12px; min-height: 44px; padding: 0 10px; border-radius: var(--r-s); cursor: pointer; font: 600 var(--t-m)/1.2 var(--f-ui); color: var(--ink); }
  :global(html:not(.touchui)) .col-row:hover { background: var(--hover); }
  .col-row input { width: 18px; height: 18px; accent-color: var(--accent); margin: 0; }
  .col-row .cn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .new { display: flex; gap: 8px; margin-top: 8px; }
  .new input { flex: 1; min-width: 0; width: 0; height: 44px; box-sizing: border-box; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: var(--surface); color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0 14px; outline: none; }
  .new input:focus { border-color: var(--accent); }
  h1 { margin: 0; font: 700 var(--t-xxl)/1.1 var(--f-ui); letter-spacing: -0.02em; color: var(--ink); }
  .head-acts { display: flex; gap: 8px; }
  .add-p { display: none; }
  @media (max-width: 640px) { .add-p { display: inline; } }
  .books { max-width: 1040px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 34px 24px; }
  .book { all: unset; cursor: pointer; display: grid; gap: 12px; align-content: start; min-width: 0; border-radius: 6px; }
  .book:focus-visible { outline: none; }
  .book:focus-visible .cover { outline: 3px solid var(--focus); outline-offset: 4px; }
  .cover {
    /* every cover the same frame, whatever it holds: 2:3, and never taller (a box with an
       aspect ratio grows to fit its content unless its minimum height is zero) */
    width: 100%; aspect-ratio: 2 / 3; min-height: 0; box-sizing: border-box; border-radius: 4px 8px 8px 4px; padding: 14% 11% 11%;
    display: flex; flex-direction: column; justify-content: space-between; text-align: center;
    background: oklch(0.38 0.06 var(--ch)); color: oklch(0.95 0.025 var(--ch));
    box-shadow: inset 5px 0 0 oklch(0 0 0 / 0.14), inset 6px 0 0 oklch(1 0 0 / 0.08);
    transition: transform .25s cubic-bezier(.2,.8,.2,1);
  }
  :global(html:not(.touchui)) .book:hover .cover, .book:focus-visible .cover { transform: translateY(-3px); }
  .cover.img { padding: 0; background: var(--rule); }
  /* the image fills the cover and takes no part in sizing it */
  .cover.img img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; border-radius: inherit; opacity: 0; transition: opacity .3s ease; }
  .cover.img img:global(.in) { opacity: 1; }
  .cover.img img:global(.now) { transition: none; }
  :global(.cover.img.whole) img { object-fit: contain; }
  .c-author { font: 600 12px/1.25 var(--f-ui); letter-spacing: 0.04em; opacity: .85; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .c-title { font: 600 clamp(18px, 2.1vw, 23px)/1.12 var(--f-book); font-variation-settings: "opsz" 36, "wght" 600; text-wrap: balance; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; }
  .c-year { font: 600 12px/1 var(--f-ui); opacity: .7; }
  .add .cover { background: transparent; color: var(--ink-3); border: 2px dashed var(--rule); box-shadow: none; justify-content: center; gap: 8px; }
  .plus { font: 300 40px/1 var(--f-ui); }
  .c-t { font: 650 var(--t-m)/1.2 var(--f-ui); color: var(--ink-2); }
  .c-s { font: 500 var(--t-xs)/1.3 var(--f-ui); }
  .meta { display: grid; gap: 3px; min-width: 0; }
  .t { font: 650 var(--t-m)/1.3 var(--f-ui); color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s { font: 500 var(--t-s)/1.3 var(--f-ui); color: var(--ink-3); }
  /* a phone: the title and its switch, then the search across, the add button as a + */
  @media (max-width: 640px) {
    .shelf { padding: calc(20px + env(safe-area-inset-top)) 16px calc(40px + env(safe-area-inset-bottom)); }
    .head { margin-bottom: 18px; gap: 12px; }
    .title { width: 100%; justify-content: space-between; gap: 12px; }
    h1 { font-size: var(--t-xl); }
    .head-acts { width: 100%; }
    .search { flex: 1; width: auto; }
    .add-btn .add-l { display: none; }
    .add-btn { width: 44px; padding: 0; justify-content: center; font-size: 22px; }
    /* (the row fits a phone's width, and wraps rather than scrolls once there are
       collections too) */
    .shelves { margin: -4px 0 20px; gap: 6px; }
    .shelves > button { flex: none; padding: 0 12px; }
    .books { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 22px 14px; }
    .add .c-s { display: none; }
    .t { font-size: var(--t-s); }
    .s { font-size: var(--t-xs); }
  }
  .foot { max-width: 70ch; margin: 44px 0 0; font: 500 var(--t-s)/1.5 var(--f-ui); color: var(--ink-3); }
  /* a finger's reach (44 px) where the drawing is smaller */
  :global(.touchui) .seg button { padding-block: 12px; }
  :global(.touchui) .shelves > button { height: 40px; }
  /* (on a touch screen it is always there: beside the title, below the cover, rather
     than over a generated cover's author) */
  :global(.touchui) .more { position: relative; z-index: 1; align-self: end; margin: 0 -4px 6px 0; }
  :global(.touchui) .meta { padding-right: 34px; }
  :global(.touchui) .more::before { content: ""; position: absolute; inset: -6px; }
  .link-btn { appearance: none; border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: .15em; }
</style>
