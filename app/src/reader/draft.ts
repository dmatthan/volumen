/** A new draft of a book already in the library (docs/PLAN.md N14 d): the same title and
 *  author, and something worth carrying (readers' feedback, one's own notes, a share).
 *  Everything goes to the new draft, found again by its words (crates/engine/src/
 *  anchor.rs): one's own highlights, marks and place; readers' feedback, each reader's
 *  newer set winning; what the writer decided about passages; the share, so notes from
 *  readers still on the earlier draft arrive on this one. */
import type { BookData, Core, LibEntry } from '../core/types';
import { kv } from '../core/kv';
import { Annotations, type Annotation } from './annotations';
import { Feedback } from './feedback';
import { notebookOf, saveDigest } from './notebook';
import { anchorAt } from './reread';
import { joinedOf, fetchSealed } from '../core/service';
import { unseal } from '../core/share';

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const worth = (id: string) =>
  Object.keys(kv.get<Record<string, unknown>>('fb.' + id, {})).length > 0 || !!kv.get('share.' + id, null) ||
  kv.get<unknown[]>('ann.' + id, []).length > 0 || kv.get<unknown[]>('marks.' + id, []).length > 0;

/** The earlier draft of a book just added, if there is one with something to carry. */
export function earlierDraft(added: LibEntry, library: LibEntry[]): LibEntry | null {
  const t = norm(added.title), a = norm(added.author);
  if (!t) return null;
  const same = library.filter(e => e.id !== added.id && !e.sample && norm(e.title) === t && (!a || !norm(e.author) || norm(e.author) === a) && worth(e.id));
  // (the most recently added of them: the draft before this one)
  return same.sort((x, y) => y.added - x.added)[0] ?? null;
}

export interface Carried { mine: number; mineLost: number; readers: number; theirs: number; theirsLost: number; shared: boolean }

const indexOf = (book: BookData) => {
  const m = new Map<string, [number, number]>();
  book.sections.forEach((s, si) => s.blocks.forEach((b, bi) => m.set(b.key, [si, bi])));
  return m;
};

export async function carryOver(core: Core, from: LibEntry, to: LibEntry): Promise<Carried> {
  const old = await core.open(from.id);
  const book = await core.open(to.id);
  const keyIndex = indexOf(book);

  // one's own highlights: copied, then placed on the new words
  const had = kv.get<Annotation[]>('ann.' + to.id, []);
  const ids = new Set(had.map(a => a.id));
  kv.set('ann.' + to.id, [...had, ...kv.get<Annotation[]>('ann.' + from.id, []).filter(a => !ids.has(a.id)).map(a => ({ ...a }))]);
  const ann = new Annotations(book, keyIndex);
  await ann.place(core);

  // the place and marked paragraphs, by their words
  const pos = kv.get<{ key?: string; off?: number } | null>('pos.' + from.id, null);
  const marks = kv.get<string[]>('marks.' + from.id, []);
  const anchors = [], what: ('pos' | 'mark')[] = [];
  if (pos?.key && !kv.get('pos.' + to.id, null)) { const a = anchorAt(old, pos.key, pos.off ?? 0); if (a) { anchors.push(a); what.push('pos'); } }
  for (const k of marks) { const a = anchorAt(old, k, 0); if (a) { anchors.push(a); what.push('mark'); } }
  if (anchors.length) {
    const placed = await core.place(to.id, anchors);
    const next = new Set(kv.get<string[]>('marks.' + to.id, []));
    placed.forEach((p, i) => {
      if (!p || p.how === 'lost') return;
      if (what[i] === 'pos') kv.set('pos.' + to.id, { key: p.key, off: p.s });
      else next.add(p.key);
    });
    kv.set('marks.' + to.id, [...next]);
  }
  saveDigest(book, notebookOf(book, keyIndex, ann.list, kv.get<string[]>('marks.' + to.id, [])));

  // readers' feedback, and what the writer decided about it
  const fbOld = kv.get<Record<string, { sent: number }>>('fb.' + from.id, {});
  const fbNew = kv.get<Record<string, { sent: number }>>('fb.' + to.id, {});
  for (const [r, v] of Object.entries(fbOld)) if (!fbNew[r] || fbNew[r].sent < v.sent) fbNew[r] = v;
  kv.set('fb.' + to.id, fbNew);
  kv.set('fbst.' + to.id, { ...kv.get<Record<string, string>>('fbst.' + from.id, {}), ...kv.get<Record<string, string>>('fbst.' + to.id, {}) });
  const fb = new Feedback(book, keyIndex);
  await fb.place(core);
  const rs = fb.list();

  // the share: notes still arriving on the earlier draft come to this one
  // (it still carries the earlier draft until the writer sends this one: ShareSheet)
  const share = kv.get<{ book?: string } | null>('share.' + from.id, null);
  if (share && !kv.get('share.' + to.id, null)) { kv.set('share.' + to.id, { ...share, book: share.book ?? from.id }); kv.set('share.' + from.id, null); }
  // a reader's book from a link: the link goes with the new draft
  const joined = kv.get('joined.' + from.id, null);
  if (joined && !kv.get('joined.' + to.id, null)) { kv.set('joined.' + to.id, joined); kv.set('joined.' + from.id, null); }
  // and the reader's word on sending how far they read
  const far = kv.get<boolean | null>('progress.' + from.id, null);
  if (far !== null) kv.set('progress.' + to.id, far);

  core.idle?.();
  return {
    mine: ann.list.filter(a => !a.lost).length, mineLost: ann.list.filter(a => a.lost).length,
    readers: rs.length, theirs: rs.reduce((n, r) => n + r.count, 0), theirsLost: rs.reduce((n, r) => n + r.lost, 0),
    shared: !!share,
  };
}

/** A reader's book from a link, whose writer has sent a newer draft (D8): fetched, its
 *  reader's notes carried over, the earlier one removed. The new draft's entry. */
export async function takeNewDraft(core: Core, old: LibEntry, version: number): Promise<{ entry: LibEntry; carried: Carried }> {
  const j = joinedOf(old.id);
  if (!j) throw new Error('this book did not come by link');
  const f = await unseal(await fetchSealed(j.id), j.key);
  if (typeof f === 'string') throw new Error(f);
  const entry = await core.importFile(f.bytes, f.name);
  const carried = await carryOver(core, old, entry);
  kv.set('joined.' + entry.id, { ...j, version });
  // a reader's welcome was for the earlier draft: not again
  kv.set('welcomed.' + entry.id, Date.now());
  return { entry, carried };
}

/** What is kept about a book that is gone from the library (as Library's remove). */
export function forgetState(id: string) {
  for (const k of ['pos.', 'marks.', 'seen.', 'far.', 'progress.', 'lines.', 'session.', 'state.', 'opened.', 'nb.', 'joined.', 'welcomed.']) kv.del(k + id);
}
