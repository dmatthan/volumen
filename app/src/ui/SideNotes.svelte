<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { ui, type Reader } from '../reader/reader.svelte';

  /** Your notes beside their lines, in the room outside the focus columns: the side the
   *  note's column is nearer, else the other, else over the column just below its line.
   *  Cards never overlap; they keep within the stage. A press on one edits it. */
  let { reader }: { reader: Reader } = $props();
  const GAP = 10, EDGE = 12, MAX_W = 330, MIN_W = 150;

  /** A card: one's own note (a highlight colour), or another reader's (their name and
   *  colour; theirs to edit, not ours). */
  interface Card { id: string; note: string; color: number; reader?: string; rc?: number; top: number; left: number; width: number }
  function noteOf(id: string): { note: string; color: number; reader?: string; rc?: number } | null {
    if (id.includes('|')) {
      const f = reader.fb?.find(id);
      return f?.n.note ? { note: f.n.note, color: 0, reader: f.reader, rc: f.colour } : null;
    }
    const a = reader.ann?.list.find(x => x.id === id);
    return a?.note ? { note: a.note, color: a.color } : null;
  }
  let cards: Card[] = $state([]);
  let box: HTMLElement;

  function place() {
    const sn = ui.sideNotes, stage = reader.stage, M = reader.M;
    if (!sn || !stage) { cards = []; return; }
    const st = stage.getBoundingClientRect();
    const focusL = M.x0, focusR = M.x0 + M.focusW, mid = (focusL + focusR) / 2;
    // room beside the focus columns, clear of the dots in the gutter
    const clear = Math.min(M.G * 0.36, 14) + 14;
    const rightW = st.width - focusR - clear - EDGE, leftW = focusL - clear - EDGE;
    const out: Card[] = [];
    for (const id of sn.ids) {
      const a = noteOf(id);
      const dot = stage.querySelector<HTMLElement>(`.nd[data-a="${CSS.escape(id)}"]`);
      if (!a || !dot) continue;
      const r = dot.getBoundingClientRect();
      const x = r.left + r.width / 2 - st.left, y = r.top + r.height / 2 - st.top;
      if (x < focusL - 40 || x > focusR + 40) continue;
      const col = dot.closest('.col')!.getBoundingClientRect();
      const nearRight = col.left + col.width / 2 - st.left >= mid;
      const sides = nearRight ? [['r', rightW], ['l', leftW]] as const : [['l', leftW], ['r', rightW]] as const;
      const side = sides.find(([, w]) => w >= MIN_W);
      let left: number, width: number, top: number;
      if (side) {
        width = Math.min(MAX_W, side[1]);
        left = side[0] === 'r' ? focusR + clear : focusL - clear - width;
        top = y - M.lh / 2;
      } else {
        // no room beside: over the column, just below the end of its highlight
        width = Math.min(MAX_W + 40, col.width);
        left = Math.max(EDGE, Math.min(col.left - st.left, st.width - width - EDGE));
        let end = y + M.lh / 2;
        for (const m of stage.querySelectorAll<HTMLElement>(`mark[data-a="${CSS.escape(id)}"]`)) {
          const mr = m.getBoundingClientRect();
          if (mr.left >= col.left - 1 && mr.right <= col.right + 1) end = Math.max(end, mr.bottom - st.top);
        }
        top = end + 4;
      }
      out.push({ id, note: a.note, color: a.color, reader: a.reader, rc: a.rc, top, left, width });
    }
    cards = out.sort((p, q) => p.top - q.top);
  }

  /** Once drawn: stacked so none overlaps the one above, and all within the stage. */
  async function settle() {
    await tick();
    const els = [...box.querySelectorAll<HTMLElement>('.sn')];
    const H = reader.stage.clientHeight;
    let bottom = -Infinity;
    const tops = cards.map((c, i) => { const t = Math.max(c.top, bottom + GAP); bottom = t + els[i].offsetHeight; return t; });
    // the last one past the bottom lifts the stack, never above the top edge
    const over = bottom - (H - EDGE);
    if (over > 0) for (let i = 0; i < tops.length; i++) tops[i] = Math.max(EDGE, tops[i] - over);
    els.forEach((el, i) => (el.style.top = tops[i] + 'px'));
  }

  $effect(() => { ui.sideNotes; place(); settle(); });

  function edit(id: string) { if (id.includes('|')) return; ui.sideNotes = null; ui.noteFor = id; ui.sheet = 'note'; }

  onMount(() => {
    // a pinned note goes away at a press anywhere else
    const away = (e: PointerEvent) => { if (ui.sideNotes?.pinned && !(e.target as Element).closest?.('.sn, .nd')) ui.sideNotes = null; };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  });
</script>

<div class="sns" bind:this={box}>
  {#each cards as c (c.id)}
    <button class="sn lift r12 h{c.color}" class:theirs={!!c.reader} data-a={c.id} style="left:{c.left}px;top:{c.top}px;width:{c.width}px{c.rc ? `;--rc:var(--r${c.rc})` : ''}"
      onclick={() => edit(c.id)} transition:fade|global={{ duration: 120 }}
      aria-label={c.reader ? `${c.reader}’s note` : 'Your note. Press to edit it.'}>
      {#if c.reader}<span class="who">{c.reader}</span>{/if}
      <span class="txt">{c.note}</span>
    </button>
  {/each}
</div>

<style>
  .sns { position: absolute; inset: 0; pointer-events: none; z-index: 25; }
  .sn {
    all: unset; pointer-events: auto; position: absolute; box-sizing: border-box; cursor: pointer;
    padding: 10px 14px 11px 13px; border-radius: 12px; background: var(--paper); border: 1px solid var(--rule);
    border-left: 4px solid var(--accent); color: var(--ink);
  }
  .sn.h1 { border-left-color: var(--hs1); } .sn.h2 { border-left-color: var(--hs2); } .sn.h3 { border-left-color: var(--hs3); } .sn.h4 { border-left-color: var(--hs4); }
  .sn.theirs { border-left-color: var(--rc); cursor: default; display: grid; gap: 3px; }
  .who { font: 650 13px/1.2 var(--f-ui); color: var(--rc); }
  .sn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .txt { display: -webkit-box; -webkit-line-clamp: 12; line-clamp: 12; -webkit-box-orient: vertical; overflow: hidden; font: 500 15px/1.45 var(--f-ui); white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
