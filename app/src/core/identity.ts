/** Who this reader is: an id of their own (so their notes replace, not duplicate, their
 *  earlier ones at the writer's) and the name they give. Kept apart from settings, which
 *  reset. */
import { kv } from './kv';

/** A random id; `crypto.randomUUID` exists only on secure pages (https, localhost), not on
 *  a phone trying the app over the local network. */
function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

export interface Me { id: string; name: string }
export function me(): Me {
  let m = kv.get<Me | null>('me', null);
  if (!m) { m = { id: newId(), name: '' }; kv.set('me', m); }
  return m;
}
export function setName(name: string) { kv.set('me', { ...me(), name: name.trim().replace(/\s+/g, ' ').slice(0, 60) }); }
