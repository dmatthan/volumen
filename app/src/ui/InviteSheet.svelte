<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { ui, toast } from '../state.svelte';
  import { service, register, personToken, canPasskey, syncShares } from '../core/service';
  import type { Core } from '../core/types';

  /** An invitation to share books (from its link): the writer's name, a check that a
   *  person is here (Turnstile), and a passkey made on this device, which signs them in
   *  from then on. The invitation is used up by it. */
  let { core }: { core: Core } = $props();
  let name = $state(''), busy = $state(false), why = $state('');
  let check: HTMLElement | undefined = $state();

  function close() { ui.sheet = null; ui.invite = ''; }

  async function accept() {
    if (busy || !name.trim()) return;
    busy = true; why = '';
    try {
      const c = await service();
      if (!c) { why = 'Sharing works on the app as served from the web, not here.'; return; }
      if (!c.turnstile) { why = 'The service is not set up yet: try again later.'; return; }
      const token = await personToken(check!, c.turnstile, 'register');
      const r = await register(ui.invite, name, token);
      if (!r) { why = 'No passkey was made. Try again when you are ready.'; return; }
      // (a passkey added for a new device: the shares from the others come here)
      const added = await syncShares(core).catch(() => 0);
      if (added) ui.libVersion++;
      toast(added ? `Welcome back, ${r.name}. ${added} shared book${added === 1 ? '' : 's'} from your other devices added.` : `Welcome, ${r.name}. Share a book from its card in the library: “Share as a link…”.`, 6400);
      close();
    } catch (e) {
      why = (e as Error).message;
    } finally { busy = false; }
  }
</script>

<Sheet label="Accept the invitation to share books" onclose={close}>
  <div>
    <p class="eyebrow">An invitation</p>
    <h2>Share your books with readers</h2>
    <p class="where">You have been invited to share books from Volumen: each as a link your readers open here, with their notes coming back to you. Sealed on this device: nobody else, the service included, can read your books or their notes.</p>
  </div>
  {#if !canPasskey()}
    <p class="hint">This browser cannot make a passkey. Open the invitation in Safari, Chrome, Edge or Firefox on a phone or computer with a screen lock.</p>
  {:else}
    <label class="name">
      <span>Your name, as your readers will know you</span>
      <input type="text" bind:value={name} placeholder="Your name" maxlength="60" data-autofocus onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); accept(); } }} />
    </label>
    <p class="where">You sign in with a passkey: this device's screen lock (Face ID, a fingerprint, a PIN) instead of a password. Your phone or computer keeps it, and can share it with your other devices.</p>
    <div class="check" bind:this={check}></div>
    {#if why}<p class="why" role="alert">{why}</p>{/if}
  {/if}
  <div class="acts two">
    <button class="btn" onclick={close}>Not now <kbd>Esc</kbd></button>
    <button class="btn primary" disabled={busy || !name.trim() || !canPasskey()} onclick={accept}>{busy ? 'Making the passkey…' : 'Make my passkey'} <kbd>Enter</kbd></button>
  </div>
</Sheet>

<style>
  .name { display: grid; gap: 6px; font: 600 var(--t-s)/1.3 var(--f-ui); color: var(--ink-2); }
  .name input { height: 46px; box-sizing: border-box; border: 1.5px solid var(--rule); border-radius: var(--r-m); background: var(--surface); color: var(--ink); font: 500 var(--t-m)/1 var(--f-ui); padding: 0 14px; outline: none; }
  .name input:focus { border-color: var(--accent); }
  .check:empty { display: none; }
  .why { margin: 0; font: 600 var(--t-m)/1.45 var(--f-ui); color: var(--ink); }
</style>
