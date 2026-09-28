// The keeper's archive: one verified transcript per game, kept in a
// SessionStore. It takes only steps that `Session.receive` verifies, so it can
// delay or withhold them but never forge one. When two branches of a game meet,
// it keeps the one the channel would rank higher (support_turn, then seq), and
// it stores two different steps one seat signed at the same seq as
// equivocation evidence.
//
// With a referee key, it is also the referee of every timed game whose terms
// name that key: it stamps each step as it arrives and flags a seat whose time
// runs out. It never stamps a step at a seq it has already stamped, so it
// attests one branch only.
import { Referee, Session, actionHash, felt, hex, publicKey, signedStep, stateHash, verify } from '../sdk/src/index.mjs';
import { SessionStore } from '../sdk/src/store.mjs';

export class KeeperError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
export const fail = (status, message, data) => { throw new KeeperError(status, message, data); };

/** Whether envelope `a` beats `b` as a dispute candidate (`channel::receive`). */
export const outranks = (a, b) =>
  a.support_turn > b.support_turn || (a.support_turn === b.support_turn && a.seq > b.seq);

export const gameKey = ids => `${hex(ids.channel)}/${hex(ids.game_id)}`;
const EVIDENCE = 'keeper/evidence/', CLOSED = 'keeper/closed/', AUTHORIZED = 'keeper/authorized/';
const summary = session => ({ start: session.start.seq, seq: session.env.seq, transcript: session.env.transcript });
const position = session => ({ seq: session.start.seq, transcript: session.start.transcript });

/**
 * `games` maps channel addresses to game codecs. `verify(session)` checks a new
 * game's terms against its channel; `anchorHash(ids)` reads the channel's
 * anchor. Both throw a KeeperError to refuse. `referee` (`{ privateKey }`)
 * makes the archive the referee of the timed games that name its key; `now()`
 * is its wall clock in milliseconds.
 */
export class Archive {
  #loaded = new Map(); // key -> Session
  #locks = new Map(); // key -> promise tail
  #listeners = new Map(); // key -> Set of wake functions
  #referees = new Map(); // key -> Referee, for the timed games this archive referees
  #timers = new Map(); // key -> timeout that flags the due seat

  constructor(backend, { games, chainId, verify: verifyTerms, anchorHash, maxSteps = 4096, maxGames = 10000, referee = null,
    now = Date.now, log = () => {} }) {
    this.backend = backend;
    this.store = new SessionStore(backend);
    this.games = new Map([...games].map(([channel, game]) => [felt(channel), game]));
    this.chainId = felt(chainId);
    Object.assign(this, { verifyTerms, anchorHash, maxSteps, maxGames, now, log });
    this.refereeKey = referee ? felt(referee.privateKey) : null;
    this.referee = referee ? publicKey(referee.privateKey) : null;
    this.known = new Map(); // key -> ids
    this.closed = new Set();
  }

  static async open(backend, options) {
    const archive = new Archive(backend, options);
    for (const ids of await archive.store.list()) {
      if (ids.chain_id === archive.chainId && archive.games.has(ids.channel)) archive.known.set(gameKey(ids), ids);
    }
    for (const key of await backend.keys(CLOSED)) archive.closed.add(key.slice(CLOSED.length));
    // A referee resumes the clocks of the games it referees.
    if (archive.referee !== null) for (const ids of archive.open()) await archive.session(ids);
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

  /** The wallet signatures an unanchored game was admitted with, or null. */
  async authorizations(ids) { return (await this.backend.get(`${AUTHORIZED}${gameKey(ids)}`)) ?? null; }

  /**
   * Archive an exported session, or merge it into the archived copy. A new
   * game's terms must pass `verify`, with `authorizations` for a game no
   * channel anchors, which are kept with it.
   */
  async register(record, authorizations) {
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
        await this.verifyTerms?.(incoming, authorizations);
        if (authorizations) await this.backend.put(`${AUTHORIZED}${key}`, authorizations);
        await this.store.save(incoming);
        this.known.set(key, ids);
        this.#adopt(key, incoming);
        this.#wake(key);
        this.log({ game: key, event: 'registered', seq: incoming.env.seq });
        return { ...summary(incoming), created: true };
      }
      if (incoming.context !== current.context) fail(409, 'The game is archived with other terms');
      // Merge where one transcript's start lies in the other's history.
      if (incoming.start.seq >= current.start.seq && current.includes(position(incoming)))
        return this.#merge(key, current, incoming.start.seq, incoming.steps.map(signedStep));
      if (incoming.start.seq < current.start.seq && incoming.includes(position(current)))
        return this.#merge(key, current, current.start.seq, incoming.steps.slice(current.start.seq - incoming.start.seq).map(signedStep));
      // Disjoint histories: only the channel's current anchor replaces the archive.
      const anchor = this.anchorHash ? await this.anchorHash(ids) : null;
      if (anchor == null || felt(anchor) !== stateHash(game, incoming.start))
        fail(409, 'The session neither overlaps the archived transcript nor starts at the channel anchor');
      await this.store.save(incoming, { replace: true });
      this.#adopt(key, incoming);
      this.#wake(key);
      this.log({ game: key, event: 'reanchored', start: incoming.start.seq, seq: incoming.env.seq });
      return { ...summary(incoming), reanchored: true };
    });
  }

  /**
   * Append signed steps (`{ step, signature }`, plus `stamp` and `attestation`
   * in a timed game) that start at seq `from`. As the referee of a timed game,
   * stamp each unstamped step as it arrives.
   */
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
    this.#disarm(key);
    this.#referees.delete(key);
    await this.backend.put(`${CLOSED}${key}`, { status });
  }

  /** Whether this archive referees the game `ids` (once loaded). */
  referees(ids) { return this.#referees.has(gameKey(ids)); }

  /** Cancel every flag timer. */
  stop() { for (const key of [...this.#timers.keys()]) this.#disarm(key); }

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

  /** Call `fn` whenever the game's transcript changes, until the returned function is called. */
  subscribe(ids, fn) {
    const key = gameKey(ids);
    const listeners = this.#listeners.get(key) ?? new Set();
    this.#listeners.set(key, listeners);
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
      if (!listeners.size && this.#listeners.get(key) === listeners) this.#listeners.delete(key);
    };
  }

  async #load(ids) {
    const key = gameKey(ids);
    if (this.#loaded.has(key)) return this.#loaded.get(key);
    if (!this.known.has(key)) return null;
    const session = await this.store.load(this.gameFor(ids.channel), ids);
    this.#adopt(key, session);
    return session;
  }

  // Keep `session` as the game's transcript and, for a timed game that names
  // our key, referee it from here. Its clock resumes where the last stamp left
  // it, so time the archive spent without this session is not charged.
  #adopt(key, session) {
    this.#loaded.set(key, session);
    this.#referees.delete(key);
    if (this.referee !== null && session.timed && felt(session.terms.clock.referee) === this.referee && !this.closed.has(key))
      this.#referees.set(key, new Referee(session, this.refereeKey, { now: this.now() }));
    this.#arm(key);
  }

  // Flag the due seat when its time runs out.
  #arm(key) {
    this.#disarm(key);
    const deadline = this.#referees.get(key)?.deadline() ?? null;
    if (deadline === null) return;
    const timer = setTimeout(() => this.#exclusive(key, () => this.#flag(key)).catch(e =>
      this.log({ game: key, event: 'flag', outcome: 'failed', error: e.message })), Math.max(0, deadline - this.now()));
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  #disarm(key) {
    clearTimeout(this.#timers.get(key));
    this.#timers.delete(key);
  }

  async #flag(key) {
    const referee = this.#referees.get(key);
    const record = referee?.flag(this.now());
    if (record) {
      await this.store.save(referee.session);
      this.#wake(key);
      this.log({ game: key, event: 'flagged', seq: record.seq });
    }
    this.#arm(key);
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
    // As the referee, stamp each step as it arrives, and flag a seat whose
    // time ran out before its step did.
    const referee = this.#referees.get(key);
    let accepted = 0, error = null, at = current.env.seq, flagged = false;
    for (const record of records.slice(i)) {
      at = current.env.seq;
      if (current.steps.length >= this.maxSteps) { error = `Transcripts are limited to ${this.maxSteps} steps`; break; }
      try {
        if (referee && record.stamp == null) {
          const now = this.now();
          if ((flagged = referee.flag(now) !== null)) { error = 'Flag fell: the seat\'s time ran out first'; break; }
          referee.stamp(record, now);
        } else current.receive(record);
        accepted++;
      } catch (e) { error = e.message; break; }
    }
    if (accepted || flagged) {
      await this.store.save(current);
      this.#wake(key);
      this.#arm(key);
    }
    if (error) fail(400, `Step ${at} rejected: ${error}`, { ...summary(current), accepted });
    return { ...summary(current), accepted };
  }

  // Records starting at `at` diverge from the archived step there.
  async #fork(key, current, at, records) {
    const { game, context, terms } = current, kept = current.steps[at - current.start.seq];
    const message = actionHash(game, context, at, kept.transcript, records[0].step);
    const seat = terms.keys.findIndex(k => verify(message, records[0].signature, k));
    if (seat < 0) fail(400, `Invalid session signature at seq ${at}`);
    const equivocated = seat === kept.seat;
    if (equivocated) await this.#record(key, kept, { seq: at, transcript: kept.transcript, message, seat, ...signedStep(records[0]) });
    // Replay the other branch from the shared prefix, as far as it verifies.
    const branch = Session.import(game, { ...current.export(), steps: current.steps.slice(0, at - current.start.seq).map(signedStep) });
    for (const record of records) {
      try { branch.receive(record); } catch { break; }
    }
    if (branch.env.seq === at || !outranks(branch.env, current.env))
      fail(409, `Conflicts with the archived step at seq ${at}`, { ...summary(current), archived: kept, equivocation: equivocated });
    await this.store.save(branch, { replace: true });
    this.#adopt(key, branch);
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
