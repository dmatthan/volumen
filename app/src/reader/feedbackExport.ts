/** Readers' feedback taken out to where the writer works (docs/PLAN.md N14): into their
 *  own Word file as Word comments (crates/ingest/src/annotate.rs), into their Markdown as
 *  CriticMarkup, or as a report (Markdown) or a spreadsheet (CSV). What is exported is
 *  what the writer's view shows: readers they have hidden are left out, and with `open`
 *  only passages not yet marked done or won't change. */
import type { BookData, WordComment } from '../core/types';
import type { Feedback } from './feedback';

type Passage = ReturnType<Feedback['passages']>[number];

const said = (v: Passage['voices'][number]) => v.note || (v.kind === 'mark' ? 'Marked this paragraph' : 'Highlighted');
const iso = (t: number) => new Date(t || Date.now()).toISOString().replace(/\.\d+Z$/, 'Z');
const pick = (fb: Feedback, open: boolean) => fb.passages().filter(p => !open || !p.st);
const STATUS = { done: 'Done', wont: 'Won’t change' } as const;

/** Every note as a Word comment on its own words. */
export function wordComments(fb: Feedback, open: boolean): WordComment[] {
  return pick(fb, open).flatMap(p => p.voices.map(v => ({ quote: v.n.quote, prefix: v.n.prefix, suffix: v.n.suffix, author: v.reader, text: said(v), date: iso(v.n.updated) })));
}

/** A report, chapter by chapter: each passage, then what each reader said of it. */
export function feedbackMarkdown(book: BookData, fb: Feedback, open: boolean): string {
  const ps = pick(fb, open);
  const readers = fb.list().filter(r => !fb.hidden.has(r.id));
  const day = new Date().toISOString().slice(0, 10);
  const out = [`# Feedback on ${book.title}`, '', `${readers.map(r => `${r.name} (${r.count})`).join(', ')}. Exported ${day}${open ? ', open passages only' : ''}.`];
  let sec = -1;
  for (const p of ps) {
    if (p.sec !== sec) { out.push('', `## ${p.where}`); sec = p.sec; }
    out.push('', ...p.quote.split('\n').map(l => `> ${l}`), '');
    for (const v of p.voices) out.push(`- **${v.reader}:** ${said(v).replace(/\n+/g, ' ')}`);
    if (p.st) out.push('', `*${STATUS[p.st]}*`);
  }
  return out.join('\n') + '\n';
}

/** One row a note, for a spreadsheet. */
export function feedbackCsv(fb: Feedback, open: boolean): string {
  const cell = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const rows = [['Chapter', 'Passage', 'Reader', 'Note', 'Status', 'Place'].join(',')];
  for (const p of pick(fb, open)) for (const v of p.voices) {
    rows.push([p.where, v.n.quote, v.reader, said(v), p.st ? STATUS[p.st] : 'Open', v.n.pos != null ? `${Math.round(v.n.pos * 100)}%` : ''].map(x => cell(String(x))).join(','));
  }
  // (a byte order mark, so a spreadsheet takes it as UTF-8)
  return '﻿' + rows.join('\r\n') + '\r\n';
}

/** The writer's Markdown with the notes in CriticMarkup: `{==the words==}{>>Ann: …<<}`;
 *  where notes overlap, the later ones as comments only. Notes whose words are not
 *  found (changed since, or across markup) are counted, not guessed. */
export function criticMarkup(source: string, comments: WordComment[]): { text: string; placed: number; unplaced: number } {
  // the source's characters without inline markup, each with its place in the source
  const plain: string[] = [], at: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if ('*_`'.includes(source[i])) continue;
    plain.push(source[i].replace(/[‘’]/, "'").replace(/[“”]/, '"')); at.push(i);
  }
  const hay = plain.join('');
  const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  const found: { s: number; e: number; c: WordComment }[] = [];
  let unplaced = 0;
  for (const c of comments) {
    const q = norm(c.quote.trim());
    if (q.length < 2) { unplaced++; continue; }
    // the occurrence that agrees best with the words before it and after
    let best = -1, score = -1;
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + 1)) {
      const before = hay.slice(Math.max(0, i - 40), i), after = hay.slice(i + q.length, i + q.length + 40);
      const pre = norm(c.prefix), suf = norm(c.suffix);
      let k = 0; while (k < before.length && k < pre.length && before[before.length - 1 - k] === pre[pre.length - 1 - k]) k++;
      let m = 0; while (m < after.length && m < suf.length && after[m] === suf[m]) m++;
      if (k + m > score) { score = k + m; best = i; }
    }
    if (best < 0) { unplaced++; continue; }
    found.push({ s: at[best], e: at[best + q.length - 1] + 1, c });
  }
  found.sort((a, b) => a.s - b.s || a.e - b.e);
  // CriticMarkup highlights do not nest: a note overlapping one before it is a comment
  let reach = -1;
  const edits: { at: number; text: string; order: number }[] = [];
  for (const f of found) {
    const note = `{>>${f.c.author}: ${f.c.text.replace(/\n+/g, ' ').replace(/<</g, '‹‹')}<<}`;
    if (f.s >= reach) {
      edits.push({ at: f.s, text: '{==', order: 1 }, { at: f.e, text: '==}' + note, order: 0 });
      reach = f.e;
    } else edits.push({ at: Math.max(f.e, reach), text: note, order: 0 });
  }
  // (from the end; at one place, an opening is inserted first so a closing ends up before it)
  edits.sort((a, b) => b.at - a.at || b.order - a.order);
  let text = source;
  for (const e of edits) text = text.slice(0, e.at) + e.text + text.slice(e.at);
  return { text, placed: found.length, unplaced };
}
