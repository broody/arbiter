// Durable client sessions (`@arbiter/sdk/store`): transcripts, signing marks
// and session keys in a small async key-value backend. `memoryBackend` and
// `indexedDbBackend` are here; the Node file backend is `@arbiter/sdk/store/file`.
import { Session, actorOf, contextHash, felt, hex, publicKey, signedStep } from './index.mjs';

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

const gameKey = ids => `${hex(ids.chain_id)}/${hex(ids.channel)}/${hex(ids.game_id)}`;
const sessionKey = ids => `session/${gameKey(ids)}`;
// A transcript is stored as immutable pieces and a pointer. The start (terms,
// anchor envelope and witness) and each step are keyed by the position they
// reach, `seq` and transcript, which commit to the whole history before them:
// two branches never share a key, and a save writes only its new steps. The
// pointer under `sessionKey` names the start and the end, and is the only key
// a save overwrites.
const startKey = (ids, seq, transcript) => `start/${gameKey(ids)}/${seq}/${hex(transcript)}`;
const stepKey = (ids, seq, transcript) => `step/${gameKey(ids)}/${seq}/${hex(transcript)}`;
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
    // A transcript saved whole, before transcripts were saved in pieces.
    const record = stored.record ?? await this.#assemble(ids, stored);
    const session = Session.import(game, record);
    if (await this.#restore(session)) await this.save(session);
    return session;
  }

  // The exported transcript a pointer names: its start, then its steps, found
  // backwards from the end through each step's transcript.
  async #assemble(ids, pointer) {
    const start = await this.backend.get(startKey(ids, pointer.start.seq, pointer.start.transcript));
    check(start, 'Stored session is missing its start');
    const steps = [];
    let transcript = pointer.transcript;
    for (let seq = pointer.seq; seq > pointer.start.seq; seq--) {
      const step = await this.backend.get(stepKey(ids, seq, transcript));
      check(step, `Stored session is missing its step at seq ${seq - 1}`);
      steps.push(step.signed);
      transcript = step.transcript;
    }
    check(felt(transcript) === felt(pointer.start.transcript), 'Stored session does not reach its start');
    return { ...start, steps: steps.reverse() };
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
    const ids = session.terms, key = sessionKey(ids), { start, steps, env } = session;
    const stale = stored => !replace && stored && !session.includes(stored);
    const stored = await this.backend.get(key);
    check(!stale(stored), 'Stale session: the store holds a transcript this one does not extend');
    // Write what the stored pointer does not already reach: only new steps,
    // unless the start moved (a new anchor) or the store holds another branch.
    const sameStart = stored?.start && stored.start.seq === start.seq && felt(stored.start.transcript) === felt(start.transcript);
    if (!sameStart) {
      const { version, terms, witness } = session.export();
      await this.backend.put(startKey(ids, start.seq, start.transcript), { version, terms, start, witness, steps: [] });
    }
    const from = sameStart && !replace && stored.seq >= start.seq ? stored.seq - start.seq : 0;
    for (let i = from; i < steps.length; i++) {
      const after = steps[i + 1]?.transcript ?? env.transcript;
      await this.backend.put(stepKey(ids, steps[i].seq + 1, after), { transcript: steps[i].transcript, signed: signedStep(steps[i]) });
    }
    // The pointer commits the save, and is refused if another tab moved on.
    const pointer = { start: { seq: start.seq, transcript: start.transcript }, seq: env.seq, transcript: env.transcript };
    await this.backend.update(key, current => {
      check(!stale(current), 'Stale session: the store holds a transcript this one does not extend');
      return pointer;
    });
  }

  /**
   * Sign our step, store it as the seat's mark, apply it and save. Returns the
   * signed record to send. Throws without releasing a signature if the step
   * breaks the rules or would contradict a step this key already signed. In a
   * timed game the step is marked but not applied: it joins `session.pending`,
   * which the mark keeps too, until the referee's stamped record comes back
   * through `receive`.
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
        record = session.sign(step, privateKey);
        return session.timed ? { ...record, pending: session.pending } : record;
      });
    } catch (error) {
      session.lastSigned[seat] = later(before, stored);
      if (record) session.discard(record);
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
  // A timed game's marked steps need the referee's stamp: they go back into
  // `pending`, to resend.
  async #restore(session) {
    const marks = await Promise.all([0, 1].map(seat => this.backend.get(markKey(session.context, seat))));
    marks.forEach((mark, seat) => { session.lastSigned[seat] = later(session.lastSigned[seat], mark); });
    if (session.timed) {
      for (const mark of marks) if (mark?.pending) session.resume(mark.pending);
      return false;
    }
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
export function indexedDbBackend(name = 'arbiter', { indexedDB = globalThis.indexedDB } = {}) {
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
