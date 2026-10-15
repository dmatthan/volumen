<script lang="ts">
  import { tick } from 'svelte';
  import Sheet from './Sheet.svelte';
  import { copyText } from './clipboard';
  import { toast, ui } from '../reader/reader.svelte';
  import { shell } from '../core/shell';
  import { canSeal, seal, linkFor, serviceLink } from '../core/share';
  import { service, signIn, signOut, publish, renew, withdraw, sharedOf, myShares, collectNotes, canPasskey, personToken, syncShares, hasVault, unlockVault, sendDraft, type ServiceConfig, type Shared } from '../core/service';
  import type { Core, LibEntry } from '../core/types';
  import { me } from '../reader/feedback';

  /** Shares a book as a link (core/share.ts): the book sealed with a key of its own, which
   *  only the link holds. With the service (this app served from the web, service/), a
   *  signed-in writer puts the sealed book there and readers' notes come back through it;
   *  without it (the desktop app, the dev server), the writer saves the sealed file and
   *  puts it where readers can fetch it. */
  let { core, book, onclose }: { core: Core; book: LibEntry; onclose: () => void } = $props();

  let svc: ServiceConfig | null | undefined = $state(undefined);
  service().then(c => (svc = c));
  // svelte-ignore state_referenced_locally
  let shared: Shared | null = $state(sharedOf(book.id));
  let readers: number | null = $state(null);
  let busy = $state(false), confirmWithdraw = $state(false), why = $state('');

  const day = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

  $effect(() => {
    if (!svc?.writer || !shared) return;
    myShares().then(s => {
      const b = s.books.find(x => x.id === shared?.id);
      // (withdrawn elsewhere, or expired and swept: the link no longer works)
      if (!b) { shared = null; return; }
      readers = b.readers;
    }).catch(() => {});
  });

  async function act(f: () => Promise<void>) {
    busy = true; why = '';
    try { await f(); } catch (e) { why = (e as Error).message; } finally { busy = false; }
  }
  /** This device's shares and the writer's vault brought together (core/service.ts):
   *  after any change here, and on signing in. */
  let vault = $state(hasVault());
  async function sync() {
    vault = hasVault();
    const added = await syncShares(core).catch(() => 0);
    if (added) { ui.libVersion++; toast(`${added} shared book${added === 1 ? '' : 's'} from your other devices added to this library.`, 5200); }
  }
  const keepEverywhere = () => act(async () => {
    if (!(await unlockVault())) { why = 'This passkey cannot keep your shares on other devices: open each link there once instead.'; return; }
    await sync();
  });

  let checkEl: HTMLElement | undefined = $state();
  const doSignIn = () => act(async () => {
    if (!svc?.turnstile) { why = 'The service is not set up yet: try again later.'; return; }
    if (await signIn(await personToken(checkEl!, svc.turnstile, 'login'))) { svc = await service(); await sync(); shared = sharedOf(book.id); }
  });
  const doSignOut = () => act(async () => { await signOut(); svc = await service(); vault = false; });

  const makeLink = () => act(async () => {
    const src = await core.source(book.id);
    if (!src) { why = 'This book’s file was not kept: add it again, then share it.'; return; }
    await publish(book.id, src);
    shared = sharedOf(book.id);
    readers = 0;
    sync();
    await tick();
    copyBtn?.focus();
  });
  let copyBtn: HTMLButtonElement | undefined = $state();
  // the link carries an earlier draft of this book (carried here: reader/draft.ts)
  const behind = $derived(!!shared?.book && shared.book !== book.id);
  const sendThis = () => act(async () => {
    const src = await core.source(book.id);
    if (!src) { why = 'This book’s file was not kept: add it again, then send it.'; return; }
    const v = await sendDraft(book.id, src);
    shared = sharedOf(book.id);
    sync();
    toast(`Sent: your readers get this draft (draft ${v}) the next time they open the book, their notes carried over.`, 6000);
  });
  const keep = () => act(async () => { await renew(book.id); shared = sharedOf(book.id); sync(); toast(`The link works until ${day(shared!.expires)}.`, 4000); });
  const doWithdraw = () => act(async () => {
    if (!confirmWithdraw) { confirmWithdraw = true; return; }
    await withdraw(book.id);
    shared = null; confirmWithdraw = false;
    sync();
    toast('Withdrawn: the link no longer opens the book.', 4200);
  });
  const check = () => act(async () => {
    const all = await collectNotes();
    if (all.length) ui.libVersion++;
    const got = all.filter(n => n.book === book.id);
    toast(got.length ? got.map(n => `${n.from}: ${n.notes} note${n.notes === 1 ? '' : 's'}`).join('; ') + '. Open the book to see them.' : 'Nothing new from your readers.', 5200);
  });

  const link = $derived(shared ? serviceLink(shared.id, shared.key) : '');
  const copy = async (l: string) => toast((await copyText(l)) ? 'Link copied. Send it to your readers.' : l, 6000);

  // without the service: a sealed file the writer places
  let key = $state(''), where = $state('');
  const fileLink = $derived(key && /^https?:\/\/\S+$/.test(where.trim()) ? linkFor(where.trim(), key) : '');
  async function sealIt() {
    busy = true;
    try {
      const src = await core.source(book.id);
      if (!src) { toast('This book’s file was not kept: add it again, then share it.', 5200); return; }
      const s = await seal(src.bytes, src.name, me().name || undefined);
      const name = book.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() + '.vbook';
      if (await shell.saveBytes(name, s.sealed)) key = s.key;
    } finally { busy = false; }
  }
</script>

<Sheet label="Share {book.title} as a link" {onclose}>
  <div>
    <p class="eyebrow">Share as a link</p>
    <h2>{book.title}</h2>
    <p class="where">The book is sealed with a key of its own, which only the link holds: whoever has the link can read it; nobody else can, the service that keeps it included.</p>
  </div>
  {#if !canSeal()}
    <p class="hint">Sealing needs a secure page: the app over https, or the desktop app.</p>
  {:else if svc === undefined}
    <p class="hint">…</p>
  {:else if svc}
    {#if !svc.writer}
      <p class="where">Writers sign in with the passkey they made when they were invited. Invitations come as a link.</p>
      {#if !canPasskey()}<p class="hint">This browser cannot use passkeys.</p>{/if}
      <div class="check" bind:this={checkEl}></div>
      <div class="acts"><button class="btn primary" disabled={busy || !canPasskey()} onclick={doSignIn}>{busy ? 'Signing in…' : 'Sign in with my passkey'}</button></div>
    {:else if !shared}
      <p class="where">Readers open the link here, read, and send their highlights and notes back to you: they arrive on your copy, beside the text. The link lasts 90 days, and you can withdraw it at any time.</p>
      <div class="acts"><button class="btn primary" disabled={busy} onclick={makeLink}>{busy ? 'Sealing and sending…' : 'Make the link'}</button></div>
    {:else}
      <div class="steps">
        <input class="link" type="text" readonly value={link} aria-label="The link" onfocus={e => (e.currentTarget as HTMLInputElement).select()} />
        <button class="btn primary" bind:this={copyBtn} onclick={() => copy(link)}>Copy the link</button>
      </div>
      {#if behind}
        <p class="where">This link still carries an earlier draft. Send this one, and readers get it the next time they open the book, their notes carried over.</p>
        <div class="acts"><button class="btn primary" disabled={busy} onclick={sendThis}>Send this draft to your readers</button></div>
      {/if}
      <p class="where">{readers === null ? '' : readers === 0 ? 'No notes from readers yet. ' : `Notes from ${readers} reader${readers === 1 ? '' : 's'}. `}Works until {day(shared.expires)}.</p>
      <div class="acts wrap">
        <button class="btn" disabled={busy} onclick={check}>Check for notes</button>
        <button class="btn" disabled={busy} onclick={keep}>Keep it 90 more days</button>
        <button class="btn" disabled={busy} onclick={doWithdraw}>{confirmWithdraw ? 'Withdraw: press again' : 'Withdraw the link…'}</button>
      </div>
    {/if}
    {#if why}<p class="why" role="alert">{why}</p>{/if}
    {#if svc.writer}
      <p class="who">Signed in as {svc.writer.name}.{#if !vault && canPasskey()} <button class="link-btn" disabled={busy} onclick={keepEverywhere}>Keep my shares on all my devices</button>{/if} <button class="link-btn" disabled={busy} onclick={doSignOut}>Sign out</button></p>
    {/if}
  {:else}
    <ol class="steps">
      <li class:done={!!key}>
        <span>Save the sealed book.</span>
        <button class="btn" disabled={busy} onclick={sealIt}>{key ? 'Saved again…' : 'Save the sealed book…'}</button>
      </li>
      <li class:off={!key}>
        <label for="share-where">Put it where your readers can fetch it (a web address), and give that address here.</label>
        <input id="share-where" type="url" placeholder="https://…" bind:value={where} disabled={!key} />
      </li>
      <li class:off={!fileLink}>
        <span>Send them the link.</span>
        <input class="link" type="text" readonly value={fileLink} aria-label="The link" onfocus={e => (e.currentTarget as HTMLInputElement).select()} disabled={!fileLink} />
        <button class="btn primary" disabled={!fileLink} onclick={() => copy(fileLink)}>Copy the link</button>
      </li>
    </ol>
  {/if}
</Sheet>

<style>
  .steps { margin: 0; padding: 0 0 0 1.2em; display: grid; gap: 16px; font: 500 var(--t-m)/1.4 var(--f-ui); color: var(--ink); }
  div.steps { padding: 0; gap: 10px; }
  .steps li { display: grid; gap: 8px; }
  .steps li.off { opacity: .45; }
  .steps li.done > span::after { content: " ✓"; color: var(--accent); }
  .steps input { height: 44px; box-sizing: border-box; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: var(--surface); color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0 12px; outline: none; min-width: 0; }
  .steps input:focus { border-color: var(--accent); }
  .steps .btn { justify-self: start; }
  .acts.wrap { display: flex; flex-wrap: wrap; gap: 8px; }
  .link-btn { appearance: none; border: 0; background: none; padding: 0; font: inherit; color: var(--accent); cursor: pointer; text-decoration: underline; text-underline-offset: .15em; }
  .who { margin: 0; font: 500 var(--t-s)/1.4 var(--f-ui); color: var(--ink-3); }
  .why { margin: 0; font: 600 var(--t-m)/1.45 var(--f-ui); color: var(--ink); }
  .check:empty { display: none; }
</style>
