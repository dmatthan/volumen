/** Sealed books and the notes that come back on them. The service holds only what the
 *  app sealed (core/share.ts): it cannot read a book or a note, and does not know their
 *  titles. A book is known by a random id; whoever has its link has the key, and a token
 *  derived from the key lets them send notes (the service keeps the token's hash). */
import { Fail, json, bytes, raw, sha256, sameHex, randomId, now, unb64url, API_HEADERS } from './http';
import { LIMITS, rate, count, stored, person, expiry } from './limits';
import type { Writer } from './auth';

const BOOK_MAGIC = 'VOLS';
const NOTES_MAGIC = 'VOLN';
const startsWith = (b: Uint8Array, m: string) => [...m].every((c, i) => b[i] === c.charCodeAt(0));

interface Book { id: string; writer: string; size: number; chunks: number; post: string; expires: number }

const ID = /^[\w-]{22}$/;
const READER = /^[0-9a-f]{32}$/;

async function live(env: Env, id: string): Promise<Book> {
  if (!ID.test(id)) throw new Fail(404, 'This link leads nowhere: it may be mistyped.');
  const b = await env.DB.prepare('SELECT id, writer, size, chunks, post, expires FROM books WHERE id = ?1 AND complete = 1').bind(id).first<Book>();
  if (!b) throw new Fail(404, 'This book is no longer shared: the writer withdrew it, or the link is mistyped.');
  if (b.expires < now()) throw new Fail(410, 'This link has expired: ask the writer for a new one.');
  return b;
}

/** One of this writer's books, expired or not (an expired one may be renewed until the
 *  daily sweep takes it). */
async function owned(env: Env, w: Writer, id: string): Promise<Book> {
  const b = ID.test(id) ? await env.DB.prepare('SELECT id, writer, size, chunks, post, expires FROM books WHERE id = ?1 AND complete = 1').bind(id).first<Book>() : null;
  if (!b || b.writer !== w.id) throw new Fail(404, 'That is not one of your shared books.');
  return b;
}

/* ---------- the writer ---------- */

/** The writer's shared books, what they may still share, and their readers. */
export async function list(env: Env, w: Writer): Promise<Response> {
  const books = (await env.DB.prepare(
    'SELECT b.id, b.size, b.created, b.expires, count(n.reader) AS readers, max(n.updated) AS updated FROM books b LEFT JOIN notes n ON n.book = b.id WHERE b.writer = ?1 AND b.complete = 1 GROUP BY b.id ORDER BY b.created DESC',
  ).bind(w.id).all()).results;
  const used = books.reduce((n, b) => n + (b.size as number), 0);
  return json({ name: w.name, books, used, maxBytes: w.max_bytes, maxBooks: w.max_books });
}

/** Keeps a sealed book; its link's id comes back. */
export async function publish(env: Env, req: Request, w: Writer): Promise<Response> {
  await rate(env.RL_WRITE, req, 'w:' + w.id);
  const post = req.headers.get('x-post') ?? '';
  if (!/^[0-9a-f]{64}$/.test(post)) throw new Fail(400, 'That request is damaged.');
  const size = Number(req.headers.get('content-length') ?? NaN);
  const mine = await env.DB.prepare('SELECT count(*) AS n, coalesce(sum(size), 0) AS bytes FROM books WHERE writer = ?1').bind(w.id).first<{ n: number; bytes: number }>();
  if ((mine?.n ?? 0) >= w.max_books) throw new Fail(403, `You share ${w.max_books} books already: withdraw one first.`);
  if ((mine?.bytes ?? 0) + (size || 0) > w.max_bytes) throw new Fail(403, 'That would pass the room you have: withdraw a book first.');
  if ((await stored(env.DB)) + (size || 0) > LIMITS.totalBytes) throw new Fail(503, 'The service is full just now.');
  const data = await raw(req, LIMITS.bookBytes);
  if (!startsWith(data, BOOK_MAGIC)) throw new Fail(400, 'Only books sealed by the app are kept here.');
  await count(env.DB, 'upload');
  const id = randomId(), chunks = Math.ceil(data.length / LIMITS.chunk), expires = expiry(LIMITS.bookDays);
  await env.DB.prepare('INSERT INTO books (id, writer, size, chunks, post, created, expires) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)')
    .bind(id, w.id, data.length, chunks, post, now(), expires).run();
  for (let i = 0; i < chunks; i++) {
    await env.DB.prepare('INSERT INTO chunks (book, n, data) VALUES (?1, ?2, ?3)').bind(id, i, data.subarray(i * LIMITS.chunk, (i + 1) * LIMITS.chunk)).run();
  }
  await env.DB.prepare('UPDATE books SET complete = 1 WHERE id = ?1').bind(id).run();
  return json({ id, expires });
}

/** A new draft to the same link (D8): sealed with the link's own key by the app, it takes
 *  the place of the one before, all at once (a reader fetching meanwhile gets one or the
 *  other, whole), and the book's version goes up. */
export async function newDraft(env: Env, req: Request, w: Writer, id: string): Promise<Response> {
  await rate(env.RL_WRITE, req, 'w:' + w.id);
  const b = await owned(env, w, id);
  const size = Number(req.headers.get('content-length') ?? NaN);
  const mine = await env.DB.prepare('SELECT coalesce(sum(size), 0) AS bytes FROM books WHERE writer = ?1').bind(w.id).first<{ bytes: number }>();
  if ((mine?.bytes ?? 0) - b.size + (size || 0) > w.max_bytes) throw new Fail(403, 'That would pass the room you have: withdraw a book first.');
  if ((await stored(env.DB)) - b.size + (size || 0) > LIMITS.totalBytes) throw new Fail(503, 'The service is full just now.');
  const data = await raw(req, LIMITS.bookBytes);
  if (!startsWith(data, BOOK_MAGIC)) throw new Fail(400, 'Only books sealed by the app are kept here.');
  await count(env.DB, 'upload');
  // the new pieces beside the old (numbered from NEXT), then swapped in one batch
  const NEXT = 100_000, chunks = Math.ceil(data.length / LIMITS.chunk);
  await env.DB.prepare('DELETE FROM chunks WHERE book = ?1 AND n >= ?2').bind(id, NEXT).run();
  for (let i = 0; i < chunks; i++) {
    await env.DB.prepare('INSERT INTO chunks (book, n, data) VALUES (?1, ?2, ?3)').bind(id, NEXT + i, data.subarray(i * LIMITS.chunk, (i + 1) * LIMITS.chunk)).run();
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM chunks WHERE book = ?1 AND n < ?2').bind(id, NEXT),
    env.DB.prepare('UPDATE chunks SET n = n - ?2 WHERE book = ?1').bind(id, NEXT),
    env.DB.prepare('UPDATE books SET size = ?2, chunks = ?3, version = version + 1 WHERE id = ?1').bind(id, data.length, chunks),
  ]);
  const v = await env.DB.prepare('SELECT version FROM books WHERE id = ?1').bind(id).first<{ version: number }>();
  return json({ version: v?.version ?? 1 });
}

/** The version of a shared book, for a reader to know there is a newer draft. */
export async function bookVersion(env: Env, req: Request, id: string): Promise<Response> {
  await rate(env.RL_READ, req);
  const b = await live(env, id);
  const v = await env.DB.prepare('SELECT version FROM books WHERE id = ?1').bind(b.id).first<{ version: number }>();
  return json({ version: v?.version ?? 1 });
}

export async function renew(env: Env, req: Request, w: Writer, id: string): Promise<Response> {
  await rate(env.RL_WRITE, req, 'w:' + w.id);
  await owned(env, w, id);
  const expires = expiry(LIMITS.bookDays);
  await env.DB.batch([
    env.DB.prepare('UPDATE books SET expires = ?1 WHERE id = ?2').bind(expires, id),
    // readers' passes last as long as the book
    env.DB.prepare('UPDATE passes SET expires = ?1 WHERE book = ?2').bind(expires, id),
  ]);
  return json({ expires });
}

/** Withdraws a book: the link stops working, and its notes go with it. */
export async function withdraw(env: Env, req: Request, w: Writer, id: string): Promise<Response> {
  await rate(env.RL_WRITE, req, 'w:' + w.id);
  await owned(env, w, id);
  await drop(env.DB, [id]);
  return json({});
}

export async function drop(db: D1Database, ids: string[]) {
  for (const id of ids) {
    await db.batch([
      db.prepare('DELETE FROM chunks WHERE book = ?1').bind(id),
      db.prepare('DELETE FROM notes WHERE book = ?1').bind(id),
      db.prepare('DELETE FROM passes WHERE book = ?1').bind(id),
      db.prepare('DELETE FROM books WHERE id = ?1').bind(id),
    ]);
  }
}

/** Every reader's notes on every one of the writer's books: who, when, how large. */
export async function inbox(env: Env, w: Writer): Promise<Response> {
  const notes = (await env.DB.prepare('SELECT n.book, n.reader, n.updated, n.size FROM notes n JOIN books b ON b.id = n.book WHERE b.writer = ?1 ORDER BY n.updated')
    .bind(w.id).all()).results;
  return json({ notes });
}

export async function readerNotes(env: Env, w: Writer, id: string, reader: string): Promise<Response> {
  if (!READER.test(reader)) throw new Fail(404, 'No such notes.');
  await owned(env, w, id);
  const n = await env.DB.prepare('SELECT data, size FROM notes WHERE book = ?1 AND reader = ?2').bind(id, reader).first<{ data: ArrayBuffer | number[]; size: number }>();
  if (!n) throw new Fail(404, 'No such notes.');
  // (D1 gives a blob as an array of numbers)
  return bytes(new Uint8Array(n.data), n.size);
}

/* ---------- readers ---------- */

/** The sealed book, to whoever has its link (the id; the key never comes here). */
export async function fetchBook(env: Env, req: Request, id: string): Promise<Response> {
  await rate(env.RL_READ, req);
  const b = await live(env, id);
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    async pull(c) {
      if (i >= b.chunks) { c.close(); return; }
      const r = await env.DB.prepare('SELECT data FROM chunks WHERE book = ?1 AND n = ?2').bind(b.id, i++).first<{ data: ArrayBuffer | number[] }>();
      if (!r) { c.error(new Error('missing piece')); return; }
      c.enqueue(new Uint8Array(r.data));
    },
  });
  return bytes(stream, b.size);
}

/** A reader's notes, replacing theirs: with the link's token, and a person's check the
 *  first time (then a pass, good as long as the book is shared). */
export async function sendNotes(env: Env, req: Request, id: string, reader: string): Promise<Response> {
  await rate(env.RL_WRITE, req);
  if (!READER.test(reader)) throw new Fail(400, 'That request is damaged.');
  const b = await live(env, id);
  const auth = /^Post ([\w-]{43})$/.exec(req.headers.get('authorization') ?? '');
  if (!auth || !sameHex(await sha256(unb64url(auth[1])), b.post)) throw new Fail(403, 'This link does not let notes be sent.');
  // a pass from an earlier send, or a person's check (and a pass for next time)
  let pass: string | undefined;
  const held = req.headers.get('x-pass');
  if (held) {
    if (!/^[\w-]{43}$/.test(held)) throw new Fail(403, 'This pass is not valid: send again.');
    const p = await env.DB.prepare('SELECT 1 AS ok FROM passes WHERE hash = ?1 AND book = ?2 AND reader = ?3 AND expires > ?4').bind(await sha256(held), id, reader, now()).first();
    if (!p) throw new Fail(403, 'This pass is not valid: send again.');
  } else {
    await person(env, req, req.headers.get('x-turnstile'), 'notes');
    pass = randomId(32);
  }
  const size = Number(req.headers.get('content-length') ?? NaN);
  const had = await env.DB.prepare('SELECT size FROM notes WHERE book = ?1 AND reader = ?2').bind(id, reader).first<{ size: number }>();
  if (!had) {
    const n = await env.DB.prepare('SELECT count(*) AS n FROM notes WHERE book = ?1').bind(id).first<{ n: number }>();
    if ((n?.n ?? 0) >= LIMITS.readersPerBook) throw new Fail(403, 'This book has all the readers it can take notes from.');
  }
  if ((await stored(env.DB)) - (had?.size ?? 0) + (size || 0) > LIMITS.totalBytes) throw new Fail(503, 'The service is full just now.');
  const data = await raw(req, LIMITS.notesBytes);
  if (!startsWith(data, NOTES_MAGIC)) throw new Fail(400, 'Only notes sealed by the app are kept here.');
  await count(env.DB, 'notes');
  await env.DB.prepare('INSERT INTO notes (book, reader, data, size, updated) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (book, reader) DO UPDATE SET data = ?3, size = ?4, updated = ?5')
    .bind(id, reader, data, data.length, now()).run();
  if (pass) await env.DB.prepare('INSERT INTO passes (hash, book, reader, expires) VALUES (?1, ?2, ?3, ?4)').bind(await sha256(pass), id, reader, b.expires).run();
  return json({ sent: now(), pass });
}

/* ---------- the writer's vault (sealed by their passkey; see migration 0003) ---------- */

const VAULT_MAGIC = 'VOLV';

export async function getVault(env: Env, w: Writer): Promise<Response> {
  if (!w.credential) return json({ error: 'Sign in again to open your shares here.' }, 404);
  const v = await env.DB.prepare('SELECT data, size FROM vaults WHERE credential = ?1 AND writer = ?2').bind(w.credential, w.id).first<{ data: ArrayBuffer | number[]; size: number }>();
  if (!v) return new Response(null, { status: 204, headers: API_HEADERS });
  return bytes(new Uint8Array(v.data), v.size);
}

export async function putVault(env: Env, req: Request, w: Writer): Promise<Response> {
  await rate(env.RL_WRITE, req, 'w:' + w.id);
  if (!w.credential) throw new Fail(400, 'Sign in again to keep your shares here.');
  const data = await raw(req, LIMITS.vaultBytes);
  if (!startsWith(data, VAULT_MAGIC)) throw new Fail(400, 'Only vaults sealed by the app are kept here.');
  await count(env.DB, 'vault');
  await env.DB.prepare('INSERT INTO vaults (credential, writer, data, size, updated) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (credential) DO UPDATE SET data = ?3, size = ?4, updated = ?5 WHERE writer = ?2')
    .bind(w.credential, w.id, data, data.length, now()).run();
  return json({});
}
