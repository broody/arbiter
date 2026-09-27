// The keeper's archive: one verified transcript per game, kept in a
// SessionStore. It takes only steps that `Session.receive` verifies, so it can
// delay or withhold them but never forge one. When two branches of a game meet,
// it keeps the one the channel would rank higher (support_turn, then seq), and
// it stores two different steps one seat signed at the same seq as
// equivocation evidence.
import { Session, actionHash, felt, hex, stateHash, verify } from '../sdk/src/index.mjs';
import { SessionStore } from '../sdk/src/store.mjs';

export class KeeperError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
export const fail = (status, message, data) => { throw new KeeperError(status, message, data); };

/** Whether envelope `a` beats `b` as a dispute candidate (`channel::receive`). */
export const outranks = (a, b) =>
  a.support_turn > b.support_turn || (a.support_turn === b.support_turn && a.seq > b.seq);

export const gameKey = ids => `${hex(ids.channel)}/${hex(ids.game_id)}`;
const EVIDENCE = 'keeper/evidence/', CLOSED = 'keeper/closed/';
const signed = ({ step, signature }) => ({ step, signature });
const summary = session => ({ start: session.start.seq, seq: session.env.seq, transcript: session.env.transcript });
const position = session => ({ seq: session.start.seq, transcript: session.start.transcript });

/**
 * `games` maps channel addresses to game codecs. `verify(session)` checks a new
 * game's terms against its channel; `anchorHash(ids)` reads the channel's
 * anchor. Both throw a KeeperError to refuse.
 */
export class Archive {
  #loaded = new Map(); // key -> Session
  #locks = new Map(); // key -> promise tail
  #listeners = new Map(); // key -> Set of wake functions

  constructor(backend, { games, chainId, verify: verifyTerms, anchorHash, maxSteps = 4096, maxGames = 10000, log = () => {} }) {
    this.backend = backend;
    this.store = new SessionStore(backend);
    this.games = new Map([...games].map(([channel, game]) => [felt(channel), game]));
    this.chainId = felt(chainId);
    Object.assign(this, { verifyTerms, anchorHash, maxSteps, maxGames, log });
    this.known = new Map(); // key -> ids
    this.closed = new Set();
  }

  static async open(backend, options) {
    const archive = new Archive(backend, options);
    for (const ids of await archive.store.list()) {
      if (ids.chain_id === archive.chainId && archive.games.has(ids.channel)) archive.known.set(gameKey(ids), ids);
    }
    for (const key of await backend.keys(CLOSED)) archive.closed.add(key.slice(CLOSED.length));
    return archive;
  }

  ids(channel, gameId) { return { chain_id: this.chainId, channel: felt(channel), game_id: felt(gameId) }; }
  gameFor(channel) { return this.games.get(felt(channel)) ?? fail(404, `Channel ${hex(channel)} is not kept here`); }
  /** Archived games the watcher still follows. */
  open() { return [...this.known].filter(([key]) => !this.closed.has(key)).map(([, ids]) => ids); }

  /** The archived session, or null. Treat it as read-only. */
  async session(ids) {
    const key = gameKey(ids);
    return this.#loaded.get(key) ?? this.#exclusive(key, () => this.#load(ids));
  }

  /** Signed step records from `from` on, with the transcript's bounds. */
  async steps(ids, from) {
    const session = await this.session(ids) ?? fail(404, 'Unknown game');
    return { ...summary(session), steps: session.steps.slice(Math.max(0, from - session.start.seq)) };
  }

  /** Archive an exported session, or merge it into the archived copy. */
  async register(record) {
    if (!record?.terms || !Array.isArray(record.steps)) fail(400, 'Expected { record: session.export() }');
    try { ['chain_id', 'channel', 'game_id'].forEach(k => felt(record.terms[k])); } catch { fail(400, 'Invalid terms'); }
    const game = this.gameFor(record.terms.channel);
    if (felt(record.terms.chain_id) !== this.chainId) fail(400, `Terms are for chain ${hex(record.terms.chain_id)}`);
    if (record.steps.length > this.maxSteps) fail(413, `Transcripts are limited to ${this.maxSteps} steps`);
    let incoming;
    try { incoming = Session.import(game, record); } catch (e) { fail(400, e.message); }
    const ids = this.ids(record.terms.channel, record.terms.game_id), key = gameKey(ids);
    return this.#exclusive(key, async () => {
      const current = await this.#load(ids);
      if (!current) {
        if (this.known.size >= this.maxGames) fail(503, 'The keeper is full');
        await this.verifyTerms?.(incoming);
        await this.store.save(incoming);
        this.known.set(key, ids);
        this.#loaded.set(key, incoming);
        this.#wake(key);
        this.log({ game: key, event: 'registered', seq: incoming.env.seq });
        return { ...summary(incoming), created: true };
      }
      if (incoming.context !== current.context) fail(409, 'The game is archived with other terms');
      // Merge where one transcript's start lies in the other's history.
      if (incoming.start.seq >= current.start.seq && current.includes(position(incoming)))
        return this.#merge(key, current, incoming.start.seq, incoming.steps.map(signed));
      if (incoming.start.seq < current.start.seq && incoming.includes(position(current)))
        return this.#merge(key, current, current.start.seq, incoming.steps.slice(current.start.seq - incoming.start.seq).map(signed));
      // Disjoint histories: only the channel's current anchor replaces the archive.
      if (!this.anchorHash || felt(await this.anchorHash(ids)) !== stateHash(game, incoming.start))
        fail(409, 'The session neither overlaps the archived transcript nor starts at the channel anchor');
      await this.store.save(incoming, { replace: true });
      this.#loaded.set(key, incoming);
      this.#wake(key);
      this.log({ game: key, event: 'reanchored', start: incoming.start.seq, seq: incoming.env.seq });
      return { ...summary(incoming), reanchored: true };
    });
  }

  /** Append signed steps (`{ step, signature }`) that start at seq `from`. */
  async append(ids, from, records) {
    if (!Number.isSafeInteger(from) || !Array.isArray(records)) fail(400, 'Expected { from, steps }');
    const key = gameKey(ids);
    return this.#exclusive(key, async () => {
      const current = await this.#load(ids) ?? fail(404, 'Unknown game');
      return this.#merge(key, current, from, records);
    });
  }

  /** Equivocation evidence recorded for a game. */
  async evidence(ids) {
    const prefix = `${EVIDENCE}${gameKey(ids)}/`;
    const entries = await Promise.all((await this.backend.keys(prefix)).map(key => this.backend.get(key)));
    return entries.sort((a, b) => a.seq - b.seq);
  }

  /** Stop watching a game the channel settled or cancelled. */
  async close(ids, status) {
    const key = gameKey(ids);
    this.closed.add(key);
    await this.backend.put(`${CLOSED}${key}`, { status });
  }

  /**
   * Resolves once the transcript grows past `seq` or changes branch, or after
   * `ms`. `cancel()` releases the waiter early.
   */
  wait(ids, seq, ms) {
    const key = gameKey(ids);
    let done;
    const promise = new Promise(resolve => {
      const listeners = this.#listeners.get(key) ?? new Set();
      this.#listeners.set(key, listeners);
      const timer = setTimeout(() => done(), ms);
      done = () => {
        clearTimeout(timer);
        listeners.delete(done);
        if (!listeners.size) this.#listeners.delete(key);
        resolve();
      };
      listeners.add(done);
      if ((this.#loaded.get(key)?.env.seq ?? -1) > seq) done();
    });
    return { promise, cancel: () => done() };
  }

  async #load(ids) {
    const key = gameKey(ids);
    if (this.#loaded.has(key)) return this.#loaded.get(key);
    if (!this.known.has(key)) return null;
    const session = await this.store.load(this.gameFor(ids.channel), ids);
    this.#loaded.set(key, session);
    return session;
  }

  async #merge(key, current, from, records) {
    const { game, context } = current, start = current.start.seq;
    if (from < start || from > current.env.seq)
      fail(409, `Steps must start between seq ${start} and ${current.env.seq}`, summary(current));
    const same = (record, seq) => {
      const kept = current.steps[seq - start];
      try { return actionHash(game, context, seq, kept.transcript, record.step) === kept.message; }
      catch (e) { fail(400, `Invalid step at seq ${seq}: ${e.message}`); }
    };
    let i = 0;
    for (; i < records.length && from + i < current.env.seq; i++) {
      if (!same(records[i], from + i)) return this.#fork(key, current, from + i, records.slice(i));
    }
    let accepted = 0, error = null;
    for (const record of records.slice(i)) {
      if (current.steps.length >= this.maxSteps) { error = `Transcripts are limited to ${this.maxSteps} steps`; break; }
      try { current.receive(record); accepted++; } catch (e) { error = e.message; break; }
    }
    if (accepted) {
      await this.store.save(current);
      this.#wake(key);
    }
    if (error) fail(400, `Step ${current.env.seq} rejected: ${error}`, { ...summary(current), accepted });
    return { ...summary(current), accepted };
  }

  // Records starting at `at` diverge from the archived step there.
  async #fork(key, current, at, records) {
    const { game, context, terms } = current, kept = current.steps[at - current.start.seq];
    const message = actionHash(game, context, at, kept.transcript, records[0].step);
    const seat = terms.keys.findIndex(k => verify(message, records[0].signature, k));
    if (seat < 0) fail(400, `Invalid session signature at seq ${at}`);
    const equivocated = seat === kept.seat;
    if (equivocated) await this.#record(key, kept, { seq: at, transcript: kept.transcript, message, seat, ...signed(records[0]) });
    // Replay the other branch from the shared prefix, as far as it verifies.
    const branch = Session.import(game, { ...current.export(), steps: current.steps.slice(0, at - current.start.seq).map(signed) });
    for (const record of records) {
      try { branch.receive(record); } catch { break; }
    }
    if (branch.env.seq === at || !outranks(branch.env, current.env))
      fail(409, `Conflicts with the archived step at seq ${at}`, { ...summary(current), archived: kept, equivocation: equivocated });
    await this.store.save(branch, { replace: true });
    this.#loaded.set(key, branch);
    this.#wake(key);
    this.log({ game: key, event: 'switched', at, seq: branch.env.seq, equivocation: equivocated });
    return { ...summary(branch), accepted: branch.env.seq - at, switched: at };
  }

  async #record(key, kept, other) {
    const entry = await this.backend.update(`${EVIDENCE}${key}/${kept.seq}`, stored => {
      const steps = stored?.steps ?? [kept];
      if (!steps.some(s => felt(s.message) === other.message)) steps.push(other);
      return { seq: kept.seq, seat: kept.seat, transcript: kept.transcript, steps };
    });
    this.log({ game: key, event: 'equivocation', seq: kept.seq, seat: kept.seat, steps: entry.steps.length });
  }

  #wake(key) { for (const done of [...(this.#listeners.get(key) ?? [])]) done(); }

  #exclusive(key, task) {
    const run = (this.#locks.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch(() => {});
    this.#locks.set(key, tail);
    tail.then(() => { if (this.#locks.get(key) === tail) this.#locks.delete(key); });
    return run;
  }
}
