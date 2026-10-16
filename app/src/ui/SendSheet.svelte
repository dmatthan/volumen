<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { type Reader } from '../reader/reader.svelte';
  import { ui, toast } from '../state.svelte';
  import { me, setName } from '../core/identity';
  import { shell } from '../core/shell';
  import { service, joinedOf, sendNotes, personToken } from '../core/service';
  import { kv } from '../core/kv';

  /** Sends this reader's notes on the book to whoever sent it: a notes file, saved (and
   *  then attached to an email or a message). The name goes with them. */
  let { reader }: { reader: Reader } = $props();
  let name = $state(me().name);
  // whether how far they read goes too (D7): yes unless they say not
  // svelte-ignore state_referenced_locally
  let far = $state(kv.get('progress.' + reader.book!.id, true));
  const file = $derived.by(() => { name; far; return reader.myNotes(); });
  function setFar() { kv.set('progress.' + reader.book!.id, far); }
  const count = (k: string) => file.notes.filter(n => n.kind === k).length;
  const parts = $derived([
    [count('highlight'), 'highlight', 'highlights'],
    [file.notes.filter(n => n.kind === 'highlight' && n.note).length, 'with a note', 'with notes'],
    [count('mark'), 'marked paragraph', 'marked paragraphs'],
  ].filter(p => +p[0] > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`).concat(file.progress ? [file.progress.done ? 'that you finished it' : `how far you have read (${Math.round(file.progress.furthest * 100)}%)`] : []));
  /** Something to send: notes, or how far they read. */
  const some = $derived(file.notes.length > 0 || !!file.progress);

  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  function close() { ui.sheet = null; }

  // a book that came by link through the service: the notes go back the same way
  // svelte-ignore state_referenced_locally
  const joined = joinedOf(reader.book!.id);
  let online = $state(false), busy = $state(false), why = $state('');
  let check: HTMLElement | undefined = $state();
  if (joined) service().then(c => (online = !!c?.turnstile));
  // after the first send, new notes go by themselves (as the reader leaves the book)
  let auto = $state(joined?.auto !== false);
  function setAuto() { const j = joinedOf(reader.book!.id); if (j) kv.set('joined.' + reader.book!.id, { ...j, auto }); }
  async function sendBack() {
    if (!name.trim() || busy) return;
    setName(name);
    busy = true; why = '';
    try {
      const c = await service();
      if (!c?.turnstile) { why = 'The service cannot be reached: save the file instead.'; return; }
      // (a pass from an earlier send needs no check)
      const token = joinedOf(reader.book!.id)?.pass ? undefined : await personToken(check!, c.turnstile, 'notes');
      await sendNotes(reader.book!.id, reader.myNotes(), token);
      setAuto();
      toast(auto ? 'Sent. New notes go to the writer by themselves when you leave the book.' : 'Sent. The writer sees your notes beside their text.', 5200);
      close();
    } catch (e) { why = (e as Error).message; }
    finally { busy = false; }
  }
  const sentBefore = joined?.sent ? new Date(joined.sent).toLocaleDateString(undefined, { day: 'numeric', month: 'long' }) : '';
  const canShare = typeof navigator.canShare === 'function' && navigator.canShare({ files: [new File(['{}'], 'x.vnotes', { type: 'application/json' })] });
  /** Where the system can share a file (a phone's share sheet: mail, messages), the notes
   *  go straight there; otherwise the file is saved, to attach. */
  async function send() {
    if (!name.trim()) return;
    setName(name);
    const f = reader.myNotes();
    const title = reader.book!.title.replace(/[\\/:*?"<>|]+/g, ' ').trim();
    const fileName = `${title} — notes from ${f.from.name}.vnotes`;
    const text = JSON.stringify(f);
    const file = new File([text], fileName, { type: 'application/json' });
    if (navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: `Notes on ${reader.book!.title}`, text: `My notes on ${reader.book!.title}: open the file in Volumen to see them in place.` });
        toast('Sent.', 2600);
        close();
        return;
      } catch (e) {
        if ((e as Error).name === 'AbortError') return;
        // fall through to saving the file
      }
    }
    if (await shell.saveText(fileName, text, 'vnotes')) {
      toast('Saved. Send the file to whoever sent you the book; they open it in their library.', 5200);
      close();
    }
  }
</script>

<Sheet label="Send my notes" onclose={close}>
  <div>
    <p class="eyebrow">Send my notes</p>
    <h2>{reader.book?.title}</h2>
    {#if online}
      <p class="where">{parts.length ? cap(parts.join(', ')) + '.' : 'Nothing to send yet.'} They go to the writer, sealed: only they can read them. Sending again replaces what you sent{sentBefore ? ` (last on ${sentBefore})` : ''}.</p>
    {:else}
      <p class="where">{parts.length ? cap(parts.join(', ')) + '.' : 'Nothing to send yet.'} They go as one small file, which the writer opens in their library; their book shows your notes in place.</p>
    {/if}
  </div>
  <label class="name">
    <span>Your name, as the writer will see it</span>
    <input type="text" bind:value={name} placeholder="Your name" data-autofocus onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); online ? sendBack() : send(); } }} />
  </label>
  <label class="tog">
    <span><span class="t-t">Send how far I have read</span><span class="t-m">Where you are and the furthest you have read, with your notes.</span></span>
    <input type="checkbox" bind:checked={far} onchange={setFar} />
  </label>
  {#if online}
    <label class="tog">
      <span><span class="t-t">Send new notes by themselves</span><span class="t-m">When you leave the book, if you added any or read on.</span></span>
      <input type="checkbox" bind:checked={auto} onchange={setAuto} />
    </label>
    <div class="check" bind:this={check}></div>
    {#if why}<p class="why" role="alert">{why}</p>{/if}
    <div class="acts two">
      <button class="btn" onclick={send} disabled={!name.trim() || !some}>Save as a file</button>
      <button class="btn primary" disabled={busy || !name.trim() || !some} onclick={sendBack}>{busy ? 'Sending…' : 'Send to the writer'} <kbd>Enter</kbd></button>
    </div>
  {:else}
    <div class="acts two">
      <button class="btn" onclick={close}>Not now <kbd>Esc</kbd></button>
      <button class="btn primary" disabled={!name.trim() || !some} onclick={send}>{canShare ? 'Send…' : 'Save the file'} <kbd>Enter</kbd></button>
    </div>
  {/if}
</Sheet>

<style>
  .name { display: grid; gap: 6px; font: 600 var(--t-s)/1.3 var(--f-ui); color: var(--ink-2); }
  .name input { height: 46px; box-sizing: border-box; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: var(--surface); color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0 14px; outline: none; }
  .name input:focus { border-color: var(--accent); }
  .check:empty { display: none; }
  .why { margin: 0; font: 600 var(--t-m)/1.45 var(--f-ui); color: var(--ink); }
</style>
