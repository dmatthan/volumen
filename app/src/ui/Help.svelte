<script lang="ts">
  import Sheet from './Sheet.svelte';
  import { touchUI } from './touch';
  let { onclose }: { onclose: () => void } = $props();
  const touch = touchUI();
  /** On a touch screen: the gestures (the keys mean nothing there). */
  const gestures: [string, [string, string][]][] = [
    ['Reading', [
      ['Tap near an edge', 'The next page at the right, the one before at the left'],
      ['Swipe', 'Moves the page under your finger; let go and it settles on a page'],
      ['Tap the middle', 'The bar: back to the library, the map, the book’s notes, these settings. Tap again to put it away'],
      ['Pinch in', 'The map of the whole book'],
      ['Hold on a word', 'Selects it; drag to take more, word by word. Then highlight, note or copy'],
      ['Tap a note marker', 'The note beside its line'],
      ['Tap an image', 'Shown large'],
      ['Back', 'The system’s back gesture closes what is open, then the book'],
    ]],
    ['Map', [
      ['Swipe', 'Look along the book'],
      ['Tap a page', 'Travel there'],
      ['Back', 'Close the map, staying where you were'],
    ]],
    ['Library', [
      ['Tap a book', 'Open it'],
      ['⋯ on a cover', 'Its collections; remove it'],
      ['+', 'Add a book: EPUB, Word, Markdown or plain text'],
    ]],
  ];
  const keyGroups: [string, [string, string][]][] = [
    ['Reading', [
      ['Space  Shift+Space', 'Turn the whole set in view'],
      ['→  ←  (L J  H K)', 'One column'],
      ['Hold → or ←', 'Glide; let go and it lands on the next column'],
      ['C', 'Columns in view: Auto, one, two, three'],
      ['M', 'Map of the book'],
      ['Ctrl+F  /', 'Find in the book: Enter for the next match, Shift+Enter the one before, arrows walk the list, Esc ends'],
      ['N  Shift+N', 'With the find field put away: next or previous match (Esc ends the search)'],
      ['Hold on a word', 'Selects it; drag to take more, word by word'],
      ['then 1–4  N  C', 'Highlight in a colour, add a note, copy with reference'],
      ['V', 'Choose a paragraph with J and K: H highlights it, N adds a note, O opens its image or footnote'],
      ['Click a note marker', 'The note beside it; G goes to where it is printed'],
      [';', 'Your notes in view, each beside its line (a dot marks them; hover one to see it alone)'],
      ['M, Notebook', 'Send my notes: to the writer, for a book that came by link; otherwise a small file for whoever sent it. Notes from readers arrive by themselves on books you shared by link, or drop their file on the library or the book; the notebook’s Feedback side gathers them'],
      ['Click an image', 'Shown large; Esc puts it back'],
      ['S', 'Themes and reading settings'],
      ['F', 'Full screen'],
      ['Q', 'Close the book'],
    ]],
    ['Map', [
      ['←  →  H  L', 'Choose a column (Shift: ten at a time)'],
      ['[  ]', 'Previous or next chapter'],
      ['0', 'Back to where you are'],
      ['Enter', 'Travel there'],
      ['/  Ctrl+F', 'Find in the book: matches light up; ↑ ↓ choose one, Enter travels to it'],
      ['N  Shift+N', 'Next or previous match'],
      ['Tab', 'Move to the buttons and the marks view'],
      ['M  Esc', 'Close the map'],
    ]],
    ['Settings', [
      ['T  Shift+T', 'Next or previous theme'],
      ['C', 'Customise the theme'],
      ['B  J', 'Bold text, justified text'],
      ['−  +', 'Size'],
      ['P', 'Appearance: match the desktop, light, dark'],
      ['N', 'New theme'],
      ['0', 'Reset all but the theme'],
    ]],
    ['Library', [
      ['Arrows  H J K L', 'Move between books'],
      ['/', 'Search: titles and authors at once, and every book’s text beneath; ↓ to the results, Enter opens a book at a match'],
      ['[  ]', 'Previous or next shelf: All, Reading now, Finished, Not started, your collections'],
      ['A', 'The focused book’s collections (1–9 put it in or take it out); right-click does the same'],
      ['N', 'Notebook: every book’s highlights, notes and lines; / filters, Enter opens the book there'],
      ['Enter', 'Open'],
      ['O', 'Add a book'],
      ['X', 'Remove a book'],
    ]],
    ['Anywhere', [
      ['?', 'This list'],
      ['Esc', 'Close a sheet, leave a text field'],
      ['Ctrl+Q', 'Quit'],
    ]],
  ];
</script>

<Sheet label={touch ? 'Gestures' : 'Keyboard shortcuts'} {onclose} wide>
  {#if touch}
    <div><p class="eyebrow">Gestures</p><h2>How to move around</h2></div>
  {:else}
    <div><p class="eyebrow">Keyboard</p><h2>Everything has a key</h2></div>
  {/if}
  <div class="cols">
    {#each touch ? gestures : keyGroups as [name, keys]}
      <section>
        <h3>{name}</h3>
        <dl>
          {#each keys as [k, d]}<dt>{k}</dt><dd>{d}</dd>{/each}
        </dl>
      </section>
    {/each}
  </div>
  <p class="hint keys-only">Tapping the text does nothing on purpose. A trackpad or a drag moves the sheet under your hand; let go and it settles on the nearest column. A mouse wheel moves one column per notch.</p>
  <div class="acts"><button class="btn" data-autofocus onclick={onclose}>Done <kbd>Esc</kbd></button></div>
</Sheet>

<style>
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 22px 32px; }
  h3 { margin: 0 0 8px; font: 650 var(--t-m)/1.3 var(--f-ui); color: var(--ink); }
  dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 8px 16px; align-items: baseline; }
  dt { font: 650 var(--t-s)/1.3 var(--f-ui); color: var(--ink); white-space: pre; font-feature-settings: "tnum"; }
  dd { margin: 0; font: 500 var(--t-s)/1.4 var(--f-ui); color: var(--ink-2); }
</style>
