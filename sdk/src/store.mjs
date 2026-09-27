// Durable client sessions (`@referee/sdk/store`): transcripts, signing marks
// and session keys in a small async key-value backend. `memoryBackend` and
// `indexedDbBackend` are here; the Node file backend is `@referee/sdk/store/file`.
import { Session, actorOf, contextHash, felt, hex, publicKey } from './index.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };

/**
 * A backend is an async key-value store of plain data (objects, arrays,
 * strings, numbers, booleans, BigInts):
 * - `get(key)`: the value, or undefined;
 * - `put(key, value)`;
 * - `update(key, fn)`: writes `fn(current)` and returns it, with no other write
 *   to `key` in between, even from another tab or handle on the same storage.
 *   `fn` is synchronous; if it throws, nothing is written;
 * - `keys(prefix)`: the keys that start with `prefix`.
 * Writes resolve once they are durable.
 */

const sessionKey = ids => `session/${hex(ids.chain_id)}/${hex(ids.channel)}/${hex(ids.game_id)}`;
const markKey = (context, seat) => `signed/${hex(context)}/${seat}`;
const secretKey = key => `key/${hex(key)}`;
// The stored mark wins ties: it is what was durable before a signature left.
const later = (mark, stored) => (stored && (!mark || stored.seq >= mark.seq) ? stored : mark);

/**
 * Each game's transcript, the last step this client signed for each seat
 * (`Session.lastSigned`), and the client's session keys.
 * - `move` records the step it signs as the seat's mark before returning it,
 *   and refuses to sign where the session does not extend the stored mark, even
 *   when another tab or a stale copy has moved on since.
 * - `load` verifies the whole transcript (`Session.import`) and re-applies a
 *   signed step that never reached it (a crash between the two writes).
 * - Marks are stored apart from transcripts, so restoring an old transcript
 *   from a backup, the other seat or a keeper never rolls one back.
 *
 * Session keys: a session key moves in one game (its terms bind it) and holds
 * no funds, so keeping it here (`saveKey`) is the intended tradeoff; anything
 * that can run script on the page can read it, as with any JS-held key. Never
 * put it in a transcript, an export or a URL. Keep the seat's randomness seed
 * with it: without the seed the seat cannot reveal and loses on time. Use a key
 * on one device at a time, because two stores holding the same key do not share
 * marks and can equivocate. To switch devices, move the key and its marks
 * together and stop using the old copy.
 */
export class SessionStore {
  constructor(backend) { this.backend = backend; }

  /** The stored session for `ids` (`{ chain_id, channel, game_id }`, e.g. its terms), or null. */
  async load(game, ids) {
    const stored = await this.backend.get(sessionKey(ids));
    if (!stored) return null;
    const session = Session.import(game, stored.record);
    if (await this.#restore(session)) await this.save(session);
    return session;
  }

  /**
   * The stored session for these terms or, if there is none, a new one saved
   * with `options` as for `new Session` (an existing one ignores them).
   */
  async open(game, terms, options) {
    const found = await this.load(game, terms);
    if (found) {
      check(found.context === contextHash(game, terms), 'Stored session has other terms');
      return found;
    }
    const session = new Session(game, terms, options);
    await this.#restore(session);
    await this.save(session);
    return session;
  }

  /**
   * Save the transcript. Refuses to replace a stored transcript this one does
   * not extend (another tab moved on) unless `replace`.
   */
  async save(session, { replace = false } = {}) {
    const value = { record: session.export(), seq: session.env.seq, transcript: session.env.transcript };
    await this.backend.update(sessionKey(session.terms), stored => {
      check(replace || !stored || session.includes(stored), 'Stale session: the store holds a transcript this one does not extend');
      return value;
    });
  }

  /**
   * Sign our step, store it as the seat's mark, apply it and save. Returns the
   * signed record to send. Throws without releasing a signature if the step
   * breaks the rules or would contradict a step this key already signed. In a
   * timed game the step is marked but not applied: send it to the referee and
   * `receive` the stamped record it returns.
   */
  async move(session, step, privateKey) {
    const seat = actorOf(session.game, session.env, step);
    check(seat === 0 || seat === 1, 'Invalid seat');
    const before = session.lastSigned[seat];
    let stored, record;
    try {
      await this.backend.update(markKey(session.context, seat), mark => {
        stored = mark;
        session.lastSigned[seat] = later(before, mark);
        return (record = session.sign(step, privateKey));
      });
    } catch (error) {
      session.lastSigned[seat] = later(before, stored);
      throw error;
    }
    if (session.timed) return record;
    session.receive(record);
    await this.save(session);
    return record;
  }

  /** Verify and apply a signed step (the other seat's, or a stamped one from the referee), then save. */
  async receive(session, signed) {
    const record = session.receive(signed);
    await this.save(session);
    return record;
  }

  /** Keep a session key, with anything else the seat must not lose (e.g. its randomness seed). */
  async saveKey(privateKey, secrets = {}) {
    await this.backend.put(secretKey(publicKey(privateKey)), { ...secrets, privateKey: felt(privateKey) });
  }

  /** `{ seat, privateKey, ...secrets }` for the first seat of `terms` whose key is stored, or null. */
  async keyFor(terms) {
    for (const [seat, key] of terms.keys.entries()) {
      const found = await this.backend.get(secretKey(key));
      if (found) return { ...found, seat };
    }
    return null;
  }

  /** `{ chain_id, channel, game_id }` of every stored session. */
  async list() {
    return (await this.backend.keys('session/')).map(key => {
      const [chain_id, channel, game_id] = key.split('/').slice(1).map(BigInt);
      return { chain_id, channel, game_id };
    });
  }

  // Attach the stored marks, and apply any marked step the transcript lacks.
  // A timed game's marked step needs the referee's stamp: resend it instead.
  async #restore(session) {
    const marks = await Promise.all([0, 1].map(seat => this.backend.get(markKey(session.context, seat))));
    marks.forEach((mark, seat) => { session.lastSigned[seat] = later(session.lastSigned[seat], mark); });
    if (session.timed) return false;
    let recovered = false, mark;
    while ((mark = marks.find(m => m?.seq === session.env.seq && felt(m.transcript) === felt(session.env.transcript)))) {
      session.receive(mark);
      recovered = true;
    }
    return recovered;
  }
}

/** JSON that keeps BigInts (as `{ "$n": "<decimal>" }`), for backends that store text. */
export const stringify = value => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? { $n: v.toString() } : v));
export const parse = text => JSON.parse(text, (_, v) =>
  v !== null && typeof v === 'object' && typeof v.$n === 'string' && Object.keys(v).length === 1 ? BigInt(v.$n) : v);

/** A backend in memory, for tests and short-lived clients. */
export function memoryBackend() {
  const map = new Map();
  return {
    get: async key => structuredClone(map.get(key)),
    put: async (key, value) => { map.set(key, structuredClone(value)); },
    update: async (key, fn) => {
      const next = fn(structuredClone(map.get(key)));
      map.set(key, structuredClone(next));
      return next;
    },
    keys: async prefix => [...map.keys()].filter(key => key.startsWith(prefix)),
  };
}

/**
 * A backend in an IndexedDB database, for browsers. Tabs of one origin share
 * it: `update` is one readwrite transaction, and writes resolve after a
 * strict-durability commit.
 */
export function indexedDbBackend(name = 'referee', { indexedDB = globalThis.indexedDB } = {}) {
  const STORE = 'records';
  let db;
  const connect = () => (db ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
  // Run `body(store, done, fail)` in one transaction, resolving once it commits.
  const run = async (mode, body) => {
    const tx = (await connect()).transaction(STORE, mode, { durability: 'strict' });
    return new Promise((resolve, reject) => {
      let result, failure;
      tx.oncomplete = () => resolve(result);
      tx.onabort = () => reject(failure ?? tx.error);
      body(tx.objectStore(STORE), value => { result = value; }, error => { failure = error; tx.abort(); });
    });
  };
  const get = key => run('readonly', (store, done) => {
    const request = store.get(key);
    request.onsuccess = () => done(request.result);
  });
  return {
    get,
    put: (key, value) => run('readwrite', (store, done, fail) => {
      try { store.put(value, key); } catch (error) { fail(error); }
    }),
    update: (key, fn) => run('readwrite', (store, done, fail) => {
      const request = store.get(key);
      request.onsuccess = () => {
        try {
          const next = fn(request.result);
          store.put(next, key);
          done(next);
        } catch (error) { fail(error); }
      };
    }),
    keys: prefix => run('readonly', (store, done) => {
      const request = store.getAllKeys();
      request.onsuccess = () => done(request.result.filter(key => typeof key === 'string' && key.startsWith(prefix)));
    }),
    close: async () => { if (db) (await db).close(); db = undefined; },
  };
}
