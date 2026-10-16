<script lang="ts">
  import { count } from '../core/say';
  import Sheet from './Sheet.svelte';
  import { type Reader } from '../reader/reader.svelte';
  import { ui, toast } from '../state.svelte';
  import { shell } from '../core/shell';
  import { wordComments, feedbackMarkdown, feedbackCsv, criticMarkup } from '../reader/feedbackExport';

  /** Readers' feedback out to where the writer works (reader/feedbackExport.ts): into
   *  their own file (Word comments, or CriticMarkup in Markdown), into another version of
   *  it, or as a report or a spreadsheet. */
  let { reader }: { reader: Reader } = $props();
  // svelte-ignore state_referenced_locally
  const book = reader.book!, fb = reader.fb!;
  let open = $state(false), busy = $state(false);
  let source: { name: string; bytes: Uint8Array } | null = $state(null);
  // svelte-ignore state_referenced_locally
  reader.core.source(book.id).then(s => (source = s)).catch(() => {});
  const kind = (name: string) => (/\.docx$/i.test(name) ? 'docx' : /\.(md|markdown|txt)$/i.test(name) ? 'md' : null);
  const base = (name: string) => name.replace(/\.[^.]+$/, '');
  const notes = $derived.by(() => { open; return wordComments(fb, open).length; });
  let other: HTMLInputElement | undefined = $state();

  function close() { ui.sheet = null; }

  /** Into a Word or Markdown file: the writer's own, or another version of it. */
  async function into(file: { name: string; bytes: Uint8Array }) {
    const k = kind(file.name);
    if (!k) { toast('Choose a Word (.docx) or Markdown (.md) file.', 4200); return; }
    busy = true;
    try {
      const cs = wordComments(fb, open);
      let bytes: Uint8Array, placed: number, lost: number;
      if (k === 'docx') {
        const r = await reader.core.annotateDocx(file.bytes, cs);
        bytes = r.bytes; placed = r.placed; lost = r.unplaced.length;
      } else {
        const r = criticMarkup(new TextDecoder().decode(file.bytes), cs);
        bytes = new TextEncoder().encode(r.text); placed = r.placed; lost = r.unplaced;
      }
      const name = `${base(file.name)} — with feedback.${k === 'docx' ? 'docx' : 'md'}`;
      if (await shell.saveBytes(name, bytes)) {
        toast(`Saved: ${count(placed, 'note', 'notes')} ${k === 'docx' ? 'as comments' : 'in CriticMarkup'}${lost ? `; ${count(lost, 'was', 'were')} not found in that version` : ''}.`, 6000);
        close();
      }
    } catch (e) { toast(`The feedback could not be put in: ${(e as Error).message}`, 6000); }
    finally { busy = false; }
  }
  async function pickOther(e: Event) {
    const f = (e.currentTarget as HTMLInputElement).files?.[0];
    (e.currentTarget as HTMLInputElement).value = '';
    if (f) await into({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
  }
  async function report() {
    if (await shell.saveText(`${book.title} — feedback.md`, feedbackMarkdown(book, fb, open), 'md')) { toast('Saved the report.', 3000); close(); }
  }
  async function sheet() {
    if (await shell.saveBytes(`${book.title} — feedback.csv`, new TextEncoder().encode(feedbackCsv(fb, open)))) { toast('Saved the spreadsheet.', 3000); close(); }
  }
</script>

<Sheet label="Export feedback" onclose={close}>
  <div>
    <p class="eyebrow">Export feedback</p>
    <h2>{book.title}</h2>
    <p class="where">{count(fb.list().filter(r => !fb.hidden.has(r.id)).length, 'reader', 'readers')}, {count(notes, 'note', 'notes')}. Readers you have hidden are left out.</p>
  </div>
  <div class="ways">
    {#if source && kind(source.name)}
      <button class="way" disabled={busy || !notes} onclick={() => into(source!)}>
        <span class="t">Into {source.name}</span>
        <span class="m">{kind(source.name) === 'docx' ? 'Your Word file, each note a comment by its reader on its words. Word, Google Docs, LibreOffice, Pages and Scrivener read these.' : 'Your Markdown, each note in CriticMarkup on its words.'}</span>
      </button>
    {/if}
    <button class="way" disabled={busy || !notes} onclick={() => other?.click()}>
      <span class="t">Into another version…</span>
      <span class="m">A Word or Markdown file of this book, a later draft too: each note is found there by its words.</span>
    </button>
    <button class="way" disabled={busy || !notes} onclick={report}>
      <span class="t">A report</span>
      <span class="m">Markdown, chapter by chapter: each passage, then what each reader said.</span>
    </button>
    <button class="way" disabled={busy || !notes} onclick={sheet}>
      <span class="t">A spreadsheet</span>
      <span class="m">CSV, one row a note, with its chapter, reader and status.</span>
    </button>
  </div>
  <label class="tog">
    <span><span class="t-t">Open passages only</span><span class="t-m">Leave out those marked done or won’t change.</span></span>
    <input type="checkbox" bind:checked={open} />
  </label>
  <input type="file" accept=".docx,.md,.markdown,.txt" hidden bind:this={other} onchange={pickOther} />
</Sheet>

<style>
  .ways { display: grid; gap: 6px; }
  .way { appearance: none; text-align: left; cursor: pointer; display: grid; gap: 3px; padding: 12px 14px; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: none; color: var(--ink); }
  :global(html:not(.touchui)) .way:hover:not(:disabled) { background: var(--hover); }
  .way:disabled { opacity: .5; cursor: default; }
  .way .t { font: 600 var(--t-m)/1.3 var(--f-ui); }
  .way .m { font: 500 var(--t-s)/1.45 var(--f-ui); color: var(--ink-3); }
</style>
