/** Writers: invited, signed in with a passkey (WebAuthn: phishing-proof, nothing to
 *  guess or leak), kept signed in by a session cookie the page's code cannot read.
 *  Nobody can sign up: an invitation (scripts/service.sh) is a random code given to
 *  one person, used once, and short-lived; only its hash is kept. */
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import type { RegistrationResponseJSON, AuthenticationResponseJSON } from '@simplewebauthn/server';
import { Fail, json, body, sha256, randomId, now } from './http';
import { LIMITS, rate, count, person, expiry } from './limits';

const COOKIE = '__Host-vol';
const CEREMONY = 5 * 60_000;

export interface Writer { id: string; name: string; max_books: number; max_bytes: number; credential: string | null }

const rp = (req: Request) => { const u = new URL(req.url); return { id: u.hostname, origin: u.origin }; };

function cookieOf(req: Request): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return null;
}

/** The writer whose session this request carries, or null. */
export async function writerOf(env: Env, req: Request): Promise<Writer | null> {
  const c = cookieOf(req);
  if (!c || !/^[\w-]{43}$/.test(c)) return null;
  return env.DB.prepare('SELECT w.id, w.name, w.max_books, w.max_bytes, s.credential FROM sessions s JOIN writers w ON w.id = s.writer WHERE s.hash = ?1 AND s.expires > ?2 AND w.disabled = 0')
    .bind(await sha256(c), now()).first<Writer>();
}

export async function mustWriter(env: Env, req: Request): Promise<Writer> {
  const w = await writerOf(env, req);
  if (!w) throw new Fail(401, 'Sign in to share books.');
  return w;
}

async function session(env: Env, writer: string, name: string, credential: string): Promise<Response> {
  const token = randomId(32);
  await env.DB.prepare('INSERT INTO sessions (hash, writer, expires, credential) VALUES (?1, ?2, ?3, ?4)').bind(await sha256(token), writer, expiry(LIMITS.sessionDays), credential).run();
  return json({ name }, 200, { 'set-cookie': `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${LIMITS.sessionDays * 86400}` });
}

/** A ceremony's challenge, used once. */
async function takeChallenge(env: Env, id: unknown) {
  if (typeof id !== 'string' || !/^[\w-]{22}$/.test(id)) throw new Fail(400, 'That request is damaged.');
  const c = await env.DB.prepare('DELETE FROM challenges WHERE id = ?1 RETURNING challenge, invite, writer, name, expires').bind(id)
    .first<{ challenge: string; invite: string | null; writer: string | null; name: string | null; expires: number }>();
  if (!c || c.expires < now()) throw new Fail(400, 'That took too long: start again.');
  return c;
}

/** Begins making a passkey with an invitation. */
export async function registerBegin(env: Env, req: Request): Promise<Response> {
  await rate(env.RL_AUTH, req);
  const b = await body<{ invite?: string; name?: string; turnstile?: string }>(req);
  if (typeof b.invite !== 'string' || !/^[\w-]{22,64}$/.test(b.invite)) throw new Fail(400, 'That invitation is mistyped.');
  const name = typeof b.name === 'string' ? b.name.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  await person(env, req, b.turnstile, 'register');
  const hash = await sha256(b.invite);
  const inv = await env.DB.prepare('SELECT name, writer FROM invites WHERE hash = ?1 AND used IS NULL AND expires > ?2').bind(hash, now())
    .first<{ name: string; writer: string | null }>();
  if (!inv) throw new Fail(403, 'This invitation has been used, has expired, or is mistyped.');
  await count(env.DB, 'register');
  const writer = inv.writer ?? randomId();
  const shown = name || inv.name;
  const existing = inv.writer ? (await env.DB.prepare('SELECT id FROM passkeys WHERE writer = ?1').bind(writer).all<{ id: string }>()).results : [];
  const options = await generateRegistrationOptions({
    rpName: 'Volumen', rpID: rp(req).id, userName: shown, userDisplayName: shown,
    userID: new TextEncoder().encode(writer) as Uint8Array<ArrayBuffer>,
    attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    excludeCredentials: existing.map(p => ({ id: p.id })),
    timeout: CEREMONY,
  });
  const cid = randomId();
  await env.DB.prepare('INSERT INTO challenges (id, challenge, invite, writer, name, expires) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(cid, options.challenge, hash, writer, shown, now() + CEREMONY).run();
  return json({ cid, options });
}

/** Keeps the new passkey, uses up the invitation, signs in. */
export async function registerFinish(env: Env, req: Request): Promise<Response> {
  await rate(env.RL_AUTH, req);
  const b = await body<{ cid?: string; response?: RegistrationResponseJSON }>(req, 32768);
  const c = await takeChallenge(env, b.cid);
  if (!c.invite || !c.writer || !b.response) throw new Fail(400, 'That request is damaged.');
  const { origin, id } = rp(req);
  const v = await verifyRegistrationResponse({ response: b.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: id, requireUserVerification: true })
    .catch(() => ({ verified: false as const }));
  if (!v.verified) throw new Fail(403, 'The passkey could not be checked: try again.');
  // the invitation is used up here, once, whoever gets here first
  const used = await env.DB.prepare('UPDATE invites SET used = ?1 WHERE hash = ?2 AND used IS NULL AND expires > ?1').bind(now(), c.invite).run();
  if (used.meta.changes !== 1) throw new Fail(403, 'This invitation has been used, has expired, or is mistyped.');
  const cred = v.registrationInfo.credential;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO writers (id, name, created) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING').bind(c.writer, c.name ?? 'Writer', now()),
    env.DB.prepare('INSERT INTO passkeys (id, writer, pub, counter, transports, created) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
      .bind(cred.id, c.writer, cred.publicKey, cred.counter, JSON.stringify(cred.transports ?? []), now()),
  ]);
  const w = await env.DB.prepare('SELECT name FROM writers WHERE id = ?1').bind(c.writer).first<{ name: string }>();
  return session(env, c.writer, w?.name ?? '', cred.id);
}

/** Begins signing in: any of this site's passkeys on the device. A person's check first,
 *  so no script can use up the day's sign-ins. */
export async function loginBegin(env: Env, req: Request): Promise<Response> {
  await rate(env.RL_AUTH, req);
  const b = await body<{ turnstile?: string }>(req);
  await person(env, req, b.turnstile, 'login');
  await count(env.DB, 'login');
  const options = await generateAuthenticationOptions({ rpID: rp(req).id, userVerification: 'required', timeout: CEREMONY });
  const cid = randomId();
  await env.DB.prepare('INSERT INTO challenges (id, challenge, expires) VALUES (?1, ?2, ?3)').bind(cid, options.challenge, now() + CEREMONY).run();
  return json({ cid, options });
}

export async function loginFinish(env: Env, req: Request): Promise<Response> {
  await rate(env.RL_AUTH, req);
  const b = await body<{ cid?: string; response?: AuthenticationResponseJSON }>(req, 32768);
  const c = await takeChallenge(env, b.cid);
  if (c.invite || !b.response || typeof b.response.id !== 'string') throw new Fail(400, 'That request is damaged.');
  const pk = await env.DB.prepare('SELECT p.id, p.writer, p.pub, p.counter, p.transports, w.name FROM passkeys p JOIN writers w ON w.id = p.writer WHERE p.id = ?1 AND w.disabled = 0')
    .bind(b.response.id).first<{ id: string; writer: string; pub: ArrayBuffer; counter: number; transports: string; name: string }>();
  if (!pk) throw new Fail(403, 'This passkey is not one of this service’s.');
  const { origin, id } = rp(req);
  const v = await verifyAuthenticationResponse({
    response: b.response, expectedChallenge: c.challenge, expectedOrigin: origin, expectedRPID: id, requireUserVerification: true,
    credential: { id: pk.id, publicKey: new Uint8Array(pk.pub), counter: pk.counter, transports: JSON.parse(pk.transports || '[]') },
  }).catch(() => ({ verified: false as const }));
  if (!v.verified) throw new Fail(403, 'The passkey could not be checked: try again.');
  await env.DB.prepare('UPDATE passkeys SET counter = ?1, used = ?2 WHERE id = ?3').bind(v.authenticationInfo.newCounter, now(), pk.id).run();
  return session(env, pk.writer, pk.name, pk.id);
}

export async function logout(env: Env, req: Request): Promise<Response> {
  const c = cookieOf(req);
  if (c) await env.DB.prepare('DELETE FROM sessions WHERE hash = ?1').bind(await sha256(c)).run();
  return json({}, 200, { 'set-cookie': `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0` });
}

