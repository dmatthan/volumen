import { kv } from '../core/kv';

/** What is kept about each book, as `<prefix><book id>`: the place and how far one got,
 *  what one has seen, marked and highlighted, the library's copy of the notebook, where
 *  one stands (shelves), when it was opened, whether to send progress; readers' feedback
 *  and what the writer decided about it; a book that came by link, and its welcome. */
const KEPT = ['pos.', 'far.', 'seen.', 'marks.', 'ann.', 'nb.', 'state.', 'opened.', 'progress.', 'fb.', 'fbst.', 'joined.', 'welcomed.'];

/** Forgets what is kept about a book gone from the library (the remove sheet says so:
 *  "your place, highlights and notes for this book are removed too"). A share is not
 *  forgotten: its link lives at the service and in the writer's vault, and is withdrawn
 *  there (ShareSheet). */
export function forgetBookState(id: string) {
  for (const k of KEPT) kv.del(k + id);
}
