import { optionsOf, STOCK, type Theme } from '../reader/themes.svelte';

/** The theme being made or edited in the theme sheet. */
class Editor {
  draft = $state<Theme | null>(null);
  isNew = $state(true);
  notes = $state<string[]>([]);

  /** A new theme starts as a copy of `base` as the reader has it, customisations included. */
  start(base: Theme, isNew: boolean) {
    const b = $state.snapshot(base) as Theme;
    this.isNew = isNew;
    this.notes = [];
    this.draft = isNew
      ? {
          ...b,
          id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
          name: 'My theme',
          builtin: false,
          desktop: false,
          options: { ...optionsOf(base) },
          light: b.light ?? { ...STOCK.light },
          dark: b.dark ?? { ...STOCK.dark },
        }
      : b;
  }
}
export const editor = new Editor();
