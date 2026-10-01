// The keeper's archive: one verified transcript per game, kept in a
// SessionStore. It takes only steps that `Session.receive` verifies, so it can
// delay or withhold them but never forge one. When two branches of a game meet,
// it keeps the one the channel would rank higher (support_turn, then seq), and
// it stores two different steps one seat signed at the same seq as
// equivocation evidence.
//
// With a referee key, it is also the referee of every timed game whose terms
// name that key: it stamps each step as it arrives, starts a clock nobody
// started, and flags a seat whose time runs out. It never stamps a step at a
// seq it has already stamped, so it attests one branch only.
//
// With a randomness secret too, it gives such games their randomness: it signs
// the tip of a hash chain for each game that asks (`tip`), and reveals the
// chain's next value as soon as it stamps a step that asks for a roll. Each
// chain comes from the secret and the game's ids, so nothing is stored.
//
// Only open games live in memory. A settled, cancelled or evicted game stays on
// disk, readable, and no longer counts against capacity.
import {
  Reader, Referee, RngChain, Session, actionHash, encodeEnvelope, encodeWitness, felt, forcedOn, hex, outranks, poseidon,
  publicKey, readStep, rebase, reveal, sign, signedStep, stateHash, tag, tipHash, verify,
} from '../sdk/src/index.mjs';
import { SessionStore } from '../sdk/src/store.mjs';

export { outranks };

export class KeeperError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data; }
}
export const fail = (status, message, data) => { throw new KeeperError(status, message, data); };

export const gameKey = ids => `${hex(ids.channel)}/${hex(ids.game_id)}`;
const EVIDENCE = 'keeper/evidence/', CLOSED = 'keeper/closed/', AUTHORIZED = 'keeper/authorized/', EXTRAS = 'keeper/extras/';
const ADMITTED = 'keeper/admitted/', CLOCK = 'keeper/clock/';
const summary = session => ({ start: session.start.seq, seq: session.env.seq, transcript: session.env.transcript });
const position = session => ({ seq: session.start.seq, transcript: session.start.transcript });

/**
 * `games` maps channel addresses to game codecs, or to entries `{ game,
 * anchored, maxSteps, startGraceMs, admit }`:
 * - `anchored: false` for games no channel holds;
 * - `maxSteps` caps a transcript (default: the archive's `maxSteps`), and
 *   refuses a game whose codec's `maxSteps(config) + 1` exceeds it;
 * - `startGraceMs` is how long the referee waits before it starts a clock;
 * - `admit(ids, terms)` returns a priority: above 0, a game may use the
 *   `reservedGames` of capacity.
 *
 * `verify(session, authorizations)` checks a new game's terms against its
 * channel, or its seats' wallet signatures (`authorizations`) when no channel
 * holds it, and returns `{ opened }`; `anchorHash(ids)` reads the channel's
 * anchor; `created(ids)` reads the `{ config, clock }` a channel holds, or
 * null for a game no channel has opened. Each throws a KeeperError to refuse.
 * `referee` (`{ privateKey, rngSecret }`) makes the archive the referee of the
 * timed games that name its key, and with `rngSecret` the source of their
 * randomness; `now()` is its wall clock in milliseconds. At most
 * `maxOpenGames` games are open at once, and each wallet plays at most
 * `maxOpenPerPlayer` games that no channel holds: unanchored ones, which close
 * once finished, and ones not opened yet, until they open. Either closes
 * after `unanchoredTtlMs` without a step, unless it is finished and waits to
 * settle.
 */
export class Archive {
  #loaded = new Map(); // key -> Session
  #locks = new Map(); // key -> promise tail
  #listeners = new Map(); // key -> Set of wake functions
  #referees = new Map(); // key -> Referee, for the timed games this archive referees
  #chains = new Map(); // key -> RngChain, the referee's hash chain for a game
  #timers = new Map(); // key -> timeout that flags the due seat, or starts the clock
  #clocks = new Map(); // key -> { epoch, phase }: in forced play onchain, resumed from it, or started since
  #graces = new Map(); // key -> wall time at which the referee starts the clock itself
  #casual = new Map(); // key -> { players, touched }, for unanchored games
  #players = new Map(); // wallet -> open unanchored games it plays

  constructor(backend, { games, chainId, verify: verifyTerms, anchorHash, created, maxSteps = 4096, maxGames = 10000,
    maxOpenGames = maxGames, reservedGames = 0, maxOpenPerPlayer = 4, unanchoredTtlMs = 86_400_000, startGraceMs = 120_000,
    referee = null, now = Date.now, log = () => {} }) {
    this.backend = backend;
    this.store = new SessionStore(backend);
    this.games = new Map([...games].map(([channel, value]) => {
      const entry = value.tag ? { game: value } : value;
      return [felt(channel), { game: entry.game, anchored: entry.anchored ?? true, maxSteps: entry.maxSteps ?? maxSteps,
        startGraceMs: entry.startGraceMs ?? startGraceMs, admit: entry.admit ?? null }];
    }));
    this.chainId = felt(chainId);
    Object.assign(this, { verifyTerms, anchorHash, created, maxOpenGames, reservedGames, maxOpenPerPlayer, unanchoredTtlMs,
      now, log });
    this.refereeKey = referee ? felt(referee.privateKey) : null;
    this.referee = referee ? publicKey(referee.privateKey) : null;
    this.rngSecret = referee?.rngSecret != null ? felt(referee.rngSecret) : null;
    this.known = new Map(); // key -> ids, for open games
  }

  static async open(backend, options) {
    const archive = new Archive(backend, options);
    const closed = new Set((await backend.keys(CLOSED)).map(key => key.slice(CLOSED.length)));
    for (const ids of await archive.store.list()) {
      const key = gameKey(ids);
      if (ids.chain_id === archive.chainId && archive.games.has(ids.channel) && !closed.has(key)) archive.known.set(key, ids);
    }
    // Open games no channel holds count against their wallets' caps.
    for (const [key, ids] of archive.known) {
      const anchored = archive.#entry(ids.channel).anchored, admitted = await backend.get(`${ADMITTED}${key}`);
      if (anchored && !admitted?.unopened) continue;
      const players = admitted?.players ?? (await archive.store.load(archive.gameFor(ids.channel), ids))?.terms.players ?? [];
      archive.#track(key, players.map(felt), anchored);
    }
    // A referee resumes the clocks of the games it referees.
    if (archive.referee !== null) for (const ids of archive.open()) await archive.session(ids);
    return archive;
  }

  ids(channel, gameId) { return { chain_id: this.chainId, channel: felt(channel), game_id: felt(gameId) }; }
  gameFor(channel) { return this.#entry(channel).game; }
  /** Open games: the ones the watcher follows. */
  open() { return [...this.known.values()]; }

  /** Open games and free slots; `free_unreserved` is what a game without priority can use. */
  capacity() {
    const open = this.known.size, free = Math.max(0, this.maxOpenGames - open);
    return { open, max_open_games: this.maxOpenGames, reserved_games: this.reservedGames, free,
      free_unreserved: Math.max(0, free - this.reservedGames) };
  }

  /** The archived session, or null; a closed game is read from disk. Treat it as read-only. */
  async session(ids) {
    const key = gameKey(ids);
    return this.#loaded.get(key) ?? await this.#exclusive(key, () => this.#load(ids)) ?? await this.#closed(ids);
  }

  /** Signed step records from `from` on, with the transcript's bounds. */
  async steps(ids, from) {
    const session = await this.session(ids) ?? fail(404, 'Unknown game');
    return { ...summary(session), steps: session.steps.slice(Math.max(0, from - session.start.seq)) };
  }

  /** The wallet signatures a game was admitted with, or null. */
  async authorizations(ids) { return (await this.backend.get(`${AUTHORIZED}${gameKey(ids)}`)) ?? null; }

  /** What a game registered with for its game module's `openCall` (opaque here), or null. */
  async extras(ids) { return (await this.backend.get(`${EXTRAS}${gameKey(ids)}`)) ?? null; }

  /**
   * Archive an exported session, or merge it into the archived copy. A new
   * game's terms must pass `verify`, with `authorizations` for a game no
   * channel holds (unanchored, or not opened yet), which are kept with it: the
   * keeper opens a game with them when it settles it.
   */
  async register(record, authorizations, extras = null) {
    if (!record?.terms || !Array.isArray(record.steps)) fail(400, 'Expected { record: session.export() }');
    try { ['chain_id', 'channel', 'game_id'].forEach(k => felt(record.terms[k])); } catch { fail(400, 'Invalid terms'); }
    const entry = this.#entry(record.terms.channel);
    if (felt(record.terms.chain_id) !== this.chainId) fail(400, `Terms are for chain ${hex(record.terms.chain_id)}`);
    if (record.steps.length > entry.maxSteps) fail(413, `Transcripts are limited to ${entry.maxSteps} steps`);
    let incoming;
    try { incoming = Session.import(entry.game, record); } catch (e) { fail(400, e.message); }
    const ids = this.ids(record.terms.channel, record.terms.game_id), key = gameKey(ids);
    return this.#exclusive(key, async () => {
      const current = await this.#load(ids);
      if (!current) {
        if (await this.#isClosed(key)) fail(409, 'The game is closed here');
        return this.#admit(key, ids, entry, incoming, authorizations, extras);
      }
      if (incoming.context !== current.context) fail(409, 'The game is archived with other terms');
      // Merge where one transcript's start lies in the other's history.
      if (incoming.start.seq >= current.start.seq && current.includes(position(incoming)))
        return this.#merge(key, current, incoming.start.seq, incoming.steps.map(signedStep));
      if (incoming.start.seq < current.start.seq && incoming.includes(position(current)))
        return this.#merge(key, current, current.start.seq, incoming.steps.slice(current.start.seq - incoming.start.seq).map(signedStep));
      // Disjoint histories: only the channel's current anchor replaces the archive.
      const anchor = this.anchorHash ? await this.anchorHash(ids) : null;
      if (anchor == null || felt(anchor) !== stateHash(entry.game, incoming.start))
        fail(409, 'The session neither overlaps the archived transcript nor starts at the channel anchor');
      await this.store.save(incoming, { replace: true });
      this.#adopt(key, incoming);
      this.#wake(key);
      this.log({ game: key, event: 'reanchored', start: incoming.start.seq, seq: incoming.env.seq });
      await this.#roll(key);
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
      const current = await this.#load(ids)
        ?? (await this.#isClosed(key) ? fail(409, 'The game is closed here') : fail(404, 'Unknown game'));
      return this.#merge(key, current, from, records);
    });
  }

  /**
   * Follow forced play the keeper did not see, read back from the chain.
   * `transitions` are the channel's `force` and `roll` calls since a state the
   * archive holds, oldest first: `{ kind, from, to, calldata }`, with `kind`
   * 'force' or 'roll', the state hashes the call started from and reached, and
   * its calldata. Each call's steps are replayed from the state it started at
   * and checked against the state the channel recorded; the transcript then
   * starts at the last. Returns whether it does.
   */
  follow(ids, transitions) {
    const key = gameKey(ids);
    return this.#exclusive(key, async () => {
      const current = await this.#load(ids);
      if (!current || !transitions.length) return false;
      const { game } = current;
      let base = rebase(current, transitions[0].from);
      if (!base) return false;
      for (const { kind, to, calldata } of transitions) {
        // The call's arguments: the game, the epoch, the state it starts from, then its steps or the roll.
        const state = [...encodeEnvelope(game, base.start), ...encodeWitness(game, base.startWitness)];
        const given = calldata.map(felt);
        if (given[0] !== ids.game_id || given.length < 2 + state.length || state.some((value, i) => value !== given[2 + i]))
          fail(409, 'The call does not start from the state the channel held');
        const r = new Reader(given.slice(2 + state.length));
        const steps = kind === 'roll' ? [reveal(r.next())] : Array.from({ length: r.num() }, () => readStep(game, r));
        r.done();
        base = forcedOn(base, steps);
        if (base.stateHash() !== felt(to)) fail(409, 'The steps played onchain do not reach the channel\'s state');
      }
      await this.store.save(base, { replace: true });
      this.#adopt(key, base);
      this.#wake(key);
      this.log({ game: key, event: 'followed', calls: transitions.length, seq: base.env.seq });
      await this.#roll(key);
      return true;
    });
  }

  /** Equivocation evidence recorded for a game. */
  async evidence(ids) {
    const prefix = `${EVIDENCE}${gameKey(ids)}/`;
    const entries = await Promise.all((await this.backend.keys(prefix)).map(key => this.backend.get(key)));
    return entries.sort((a, b) => a.seq - b.seq);
  }

  /** Close a game the channel settled or cancelled: it leaves memory and stays on disk. */
  close(ids, status) {
    const key = gameKey(ids);
    return this.#exclusive(key, () => this.#close(key, status));
  }

  /**
   * The tip of the referee's hash chain for the game `ids`, with the referee's
   * signature over it (`tipHash`): what a game's terms carry, and `open_game`
   * checks, when it takes the referee's randomness. The same game always gets
   * the same tip. The chain covers every roll the game's config allows: an
   * opened game's config is read from its channel, another's is `config`.
   */
  async tip(ids, config) {
    if (this.referee === null || this.rngSecret === null) fail(404, 'This keeper gives no randomness');
    const entry = this.#entry(ids.channel);
    const created = entry.anchored && this.created ? await this.created(ids) : null;
    if (created) {
      const clock = created.clock;
      if (clock == null || felt(clock.referee) !== this.referee || felt(clock.rng_tip ?? 0) === 0n)
        fail(409, 'The game did not ask this referee for randomness');
      config = created.config;
    }
    // A chain costs a hash per step the config allows: no longer than a game this keeper would admit.
    let steps;
    try { steps = entry.game.maxSteps(config); } catch { steps = NaN; }
    if (!Number.isSafeInteger(steps) || steps < 0) fail(400, 'Invalid config');
    if (steps + 1 > entry.maxSteps)
      fail(409, `The game can run to ${steps + 1} steps; this keeper keeps at most ${entry.maxSteps} per game on channel ${hex(ids.channel)}`);
    const chain = this.#chain(ids, config);
    const message = tipHash(entry.game, ids.chain_id, ids.channel, ids.game_id, chain.tip);
    return { rng_tip: chain.tip, signature: sign(message, this.refereeKey) };
  }

  /** Whether this archive referees the game `ids` (once loaded). */
  referees(ids) { return this.#referees.has(gameKey(ids)); }

  /** The referee's `acknowledge` signature for a game's dispute at `epoch` ending at `deadline`, or null. */
  acknowledgement(ids, epoch, deadline) { return this.#referees.get(gameKey(ids))?.acknowledgement(epoch, deadline) ?? null; }

  /** The referee's signature returning a game from forced play at `epoch`, from the anchor `anchorHash`, or null. */
  resumeSignature(ids, epoch, anchorHash) {
    return this.#referees.get(gameKey(ids))?.resumeSignature(epoch, anchorHash) ?? null;
  }

  /**
   * The channel of a game this archive referees is in forced play at `epoch`.
   * No clock runs offchain meanwhile: the referee neither flags nor stamps
   * until the channel resumes. Returns whether this changed anything.
   */
  forced(ids, epoch) {
    const key = gameKey(ids);
    return this.#exclusive(key, async () => {
      await this.#load(ids);
      const clock = this.#clocks.get(key);
      // A stale read of the channel can't undo a resume.
      if (!this.#referees.has(key) || (clock && clock.epoch >= epoch)) return false;
      await this.#setClock(key, { epoch, phase: 'forced' });
      this.#graces.delete(key);
      this.#arm(key);
      this.log({ game: key, event: 'forced', epoch });
      return true;
    });
  }

  /**
   * The channel returned from forced play at `epoch`. The last stamp is stale
   * and would charge the forced period to the due seat, and flags wait until
   * the clock restarts: with one `start` after the start grace, or from the
   * last stamp when the due seat's step comes first. Once per epoch. Returns
   * whether this changed anything.
   */
  resumed(ids, epoch) {
    const key = gameKey(ids);
    return this.#exclusive(key, async () => {
      await this.#load(ids);
      const clock = this.#clocks.get(key);
      if (!this.#referees.has(key) || clock?.phase !== 'forced' || epoch <= clock.epoch) return false;
      await this.#setClock(key, { epoch, phase: 'resumed' });
      this.#graces.delete(key);
      this.#arm(key);
      this.log({ game: key, event: 'resumed', epoch });
      // A roll a seat asked for onchain is answered at once.
      await this.#roll(key);
      return true;
    });
  }

  /**
   * Close the games no channel holds that went without a step for longer than
   * `unanchoredTtlMs`, but not a finished one waiting to settle. Returns how many.
   */
  async sweep() {
    const cutoff = this.now() - this.unanchoredTtlMs, idle = [];
    for (const [key, casual] of [...this.#casual]) {
      if (casual.touched >= cutoff) continue;
      // A finished game waiting to open settles: loaded from disk if need be.
      if (casual.anchored && this.known.has(key) && (await this.session(this.known.get(key)))?.env.outcome.finished) continue;
      idle.push(key);
    }
    for (const key of idle) this.#forget(key);
    await Promise.all(idle.map(key => this.backend.put(`${CLOSED}${key}`, { status: 'idle' })));
    for (const key of idle) this.log({ game: key, event: 'evicted', reason: 'idle' });
    return idle.length;
  }

  /** A channel now holds the game `ids`: its wallets' caps stop counting it. */
  async opened(ids) {
    const key = gameKey(ids);
    if (!this.#casual.get(key)?.anchored) return;
    this.#untrack(key);
    await this.backend.put(`${ADMITTED}${key}`, null);
  }

  /** Cancel every timer. */
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

  #entry(channel) { return this.games.get(felt(channel)) ?? fail(404, `Channel ${hex(channel)} is not kept here`); }

  async #load(ids) {
    const key = gameKey(ids);
    if (this.#loaded.has(key)) return this.#loaded.get(key);
    if (!this.known.has(key)) return null;
    const session = await this.store.load(this.gameFor(ids.channel), ids);
    const clock = await this.backend.get(`${CLOCK}${key}`);
    if (clock) this.#clocks.set(key, clock);
    this.#adopt(key, session);
    // A roll the keeper owed when it stopped.
    await this.#roll(key);
    return session;
  }

  async #isClosed(key) { return (await this.backend.get(`${CLOSED}${key}`)) !== undefined; }

  // A closed game, read from disk without keeping it in memory.
  async #closed(ids) {
    if (!this.games.has(ids.channel) || !(await this.#isClosed(gameKey(ids)))) return null;
    return this.store.load(this.gameFor(ids.channel), ids);
  }

  // Admit a new game: within its entry's step cap, its wallets' caps if no
  // channel holds it, and the keeper's capacity, whose reserved slots only go
  // to games that `admit` ranks above 0.
  async #admit(key, ids, entry, session, authorizations, extras) {
    const { terms } = session;
    const needs = entry.game.maxSteps(terms.config) + 1;
    if (needs > entry.maxSteps)
      fail(409, `The game can run to ${needs} steps; this keeper keeps at most ${entry.maxSteps} per game on channel ${hex(ids.channel)}`);
    // The terms against the channel, or the wallets' signatures when no
    // channel holds the game: an unopened one counts against their caps until
    // it opens.
    const verified = await this.verifyTerms?.(session, authorizations);
    const unopened = entry.anchored && verified?.opened === false;
    const players = entry.anchored && !unopened ? [] : terms.players.map(felt);
    const busy = () => players.find(player => (this.#players.get(player) ?? 0) >= this.maxOpenPerPlayer);
    if (busy() !== undefined) await this.sweep();
    const player = busy();
    if (player !== undefined) fail(429, `Wallet ${hex(player)} already plays ${this.maxOpenPerPlayer} open games here that no channel holds`);
    const room = priority => {
      const free = this.maxOpenGames - this.known.size;
      return free > 0 && (free > this.reservedGames || priority > 0);
    };
    if (!room(0)) await this.sweep();
    if (this.known.size >= this.maxOpenGames) fail(503, 'The keeper is full');
    // We can roll only from our own chain for this game.
    const clock = terms.clock;
    if (this.referee !== null && clock != null && felt(clock.referee) === this.referee && felt(clock.rng_tip ?? 0) !== 0n
      && (this.rngSecret === null || this.#chain(ids, terms.config).tip !== felt(clock.rng_tip)))
      fail(409, 'The game\'s randomness tip is not this referee\'s');
    const priority = room(0) ? 0 : Number(await entry.admit?.(ids, terms)) || 0;
    if (!room(priority)) fail(503, this.known.size < this.maxOpenGames
      ? 'The keeper is full: its reserved capacity is for priority games' : 'The keeper is full');
    // Take the slot before writing, so concurrent registrations can't overfill.
    this.known.set(key, ids);
    if (players.length) this.#track(key, players, entry.anchored);
    try {
      if (authorizations) await this.backend.put(`${AUTHORIZED}${key}`, authorizations);
      if (extras != null) await this.backend.put(`${EXTRAS}${key}`, extras);
      if (players.length) await this.backend.put(`${ADMITTED}${key}`, { players, ...(unopened ? { unopened } : {}) });
      await this.store.save(session);
    } catch (e) {
      this.#forget(key);
      throw e;
    }
    this.#adopt(key, session);
    this.#wake(key);
    this.log({ game: key, event: 'registered', seq: session.env.seq, ...(priority > 0 ? { priority } : {}) });
    await this.#settled(key, session);
    return { ...summary(session), created: true };
  }

  // Count a game no channel holds against its wallets' caps. `anchored`: it
  // waits to open on its entry's channel, so it settles there once finished.
  #track(key, players, anchored = false) {
    this.#casual.set(key, { players, anchored, touched: this.now() });
    for (const player of new Set(players)) this.#players.set(player, (this.#players.get(player) ?? 0) + 1);
  }

  #untrack(key) {
    const casual = this.#casual.get(key);
    if (!casual) return;
    this.#casual.delete(key);
    for (const player of new Set(casual.players)) {
      const left = this.#players.get(player) - 1;
      if (left > 0) this.#players.set(player, left);
      else this.#players.delete(player);
    }
  }

  // Drop an open game from memory.
  #forget(key) {
    this.#disarm(key);
    for (const map of [this.#referees, this.#chains, this.#loaded, this.#clocks, this.#graces, this.known]) map.delete(key);
    this.#untrack(key);
  }

  async #close(key, status) {
    await this.backend.put(`${CLOSED}${key}`, { status });
    this.#forget(key);
  }

  // Note a step in a game no channel holds. An unanchored one closes once
  // finished: no channel will settle it. One waiting to open settles there.
  async #settled(key, session) {
    const casual = this.#casual.get(key);
    if (!casual) return;
    casual.touched = this.now();
    if (!session.env.outcome.finished || casual.anchored) return;
    await this.#close(key, 'finished');
    this.log({ game: key, event: 'evicted', reason: 'finished' });
  }

  async #setClock(key, clock) {
    await this.backend.put(`${CLOCK}${key}`, clock);
    this.#clocks.set(key, clock);
  }

  // Keep `session` as the game's transcript and, for a timed game that names
  // our key, referee it from here. Its clock resumes where the last stamp left
  // it, so time the archive spent without this session is not charged.
  #adopt(key, session) {
    this.#loaded.set(key, session);
    this.#referees.delete(key);
    if (this.referee !== null && session.timed && felt(session.terms.clock.referee) === this.referee && this.known.has(key))
      this.#referees.set(key, new Referee(session, this.refereeKey, { now: this.now(), rng: this.#rng(session) }));
    this.#arm(key);
  }

  // The referee's hash chain for a game: from the randomness secret and the
  // game's ids, with a value for every roll its config allows (a roll takes
  // two steps). Rebuilt when needed, which costs one hash per value.
  #chain(ids, config) {
    const key = gameKey(ids), length = Math.floor(this.gameFor(ids.channel).maxSteps(config) / 2) + 2;
    let chain = this.#chains.get(key);
    if (chain?.length !== length) {
      const seed = poseidon([tag('KEEPER_RNG_V1'), this.rngSecret, ids.chain_id, ids.channel, ids.game_id]);
      chain = new RngChain(seed, length);
      // The chains of games that never registered don't pile up.
      for (const old of this.#chains.keys()) {
        if (this.#chains.size < this.known.size + 1024) break;
        if (!this.known.has(old)) this.#chains.delete(old);
      }
      this.#chains.set(key, chain);
    }
    return chain;
  }

  // What a Referee rolls from, in a game that takes its randomness from us.
  #rng(session) {
    const { terms } = session;
    if (this.rngSecret === null || felt(terms.clock.rng_tip ?? 0) === 0n) return null;
    return { before: head => this.#chain(this.ids(terms.channel, terms.game_id), terms.config).before(head) };
  }

  // Answer a roll the transcript waits for: one the keeper owed when it
  // stopped, or one a seat asked for onchain in forced play. Not while the
  // channel is still in forced play: nothing is stamped then.
  async #roll(key) {
    const referee = this.#referees.get(key);
    if (!referee || this.#clocks.get(key)?.phase === 'forced') return;
    let record;
    try { record = referee.roll(this.now()); } catch (e) {
      this.log({ game: key, event: 'roll', outcome: 'failed', error: e.message });
      return;
    }
    if (!record) return;
    await this.store.save(referee.session);
    this.#wake(key);
    this.log({ game: key, event: 'rolled', seq: record.seq });
    await this.#settled(key, referee.session);
    this.#arm(key);
  }

  // A transcript at its entry's cap takes no more steps, a flag included.
  #full(session) { return session.steps.length >= this.#entry(session.terms.channel).maxSteps; }

  // Set the game's one timer:
  // - none once the game is over, or while it is in forced play onchain;
  // - the start of a clock nobody started (a new game), or of one resumed from
  //   forced play, after the start grace; flags wait for it;
  // - otherwise the due seat's flag, when its time runs out.
  // A game whose transcript is at its cap is no longer refereed.
  #arm(key) {
    this.#disarm(key);
    const referee = this.#referees.get(key);
    if (!referee || referee.session.env.outcome.finished) return;
    const session = referee.session, phase = this.#clocks.get(key)?.phase;
    if (this.#full(session)) {
      this.#referees.delete(key);
      this.log({ game: key, event: 'unrefereed', reason: 'the transcript is at its step cap' });
      return;
    }
    if (phase === 'forced') return;
    if (phase === 'resumed' || session.env.clock.stamp === 0) {
      const at = this.#graces.get(key) ?? this.now() + this.#entry(session.terms.channel).startGraceMs;
      this.#graces.set(key, at);
      this.#schedule(key, at, () => this.#start(key));
      return;
    }
    this.#graces.delete(key);
    const deadline = referee.deadline();
    if (deadline !== null) this.#schedule(key, deadline, () => this.#flag(key));
  }

  #schedule(key, at, task) {
    const timer = setTimeout(() => this.#exclusive(key, task).catch(e =>
      this.log({ game: key, event: 'timer', outcome: 'failed', error: e.message })), Math.max(0, at - this.now()));
    timer.unref?.();
    this.#timers.set(key, timer);
  }

  #disarm(key) {
    clearTimeout(this.#timers.get(key));
    this.#timers.delete(key);
  }

  async #flag(key) {
    const referee = this.#referees.get(key);
    const record = referee && !this.#full(referee.session) ? referee.flag(this.now()) : null;
    if (record) {
      await this.store.save(referee.session);
      this.#wake(key);
      this.log({ game: key, event: 'flagged', seq: record.seq });
      await this.#settled(key, referee.session);
    }
    this.#arm(key);
  }

  // Start a clock nobody started, or one resumed from forced play.
  async #start(key) {
    const referee = this.#referees.get(key);
    if (!referee) return;
    const session = referee.session, clock = this.#clocks.get(key), resumed = clock?.phase === 'resumed';
    if ((resumed || session.env.clock.stamp === 0) && !this.#full(session)) {
      if (resumed) await this.#setClock(key, { epoch: clock.epoch, phase: 'started' });
      const record = referee.start(this.now());
      await this.store.save(session);
      this.#wake(key);
      this.log({ game: key, event: 'started', seq: record.seq, ...(resumed ? { epoch: clock.epoch } : {}) });
      await this.#settled(key, session);
    }
    this.#graces.delete(key);
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
    // time ran out before its step did. Nothing is stamped during forced play.
    let referee = this.#referees.get(key);
    const clock = this.#clocks.get(key);
    if (referee && clock?.phase === 'forced' && i < records.length)
      fail(409, 'The game is in forced play onchain: steps wait until the channel resumes', summary(current));
    const limit = this.#entry(current.terms.channel).maxSteps;
    let accepted = 0, error = null, at = current.env.seq, flagged = false;
    for (const record of records.slice(i)) {
      at = current.env.seq;
      if (current.steps.length >= limit) { error = `Transcripts are limited to ${limit} steps`; break; }
      try {
        if (referee && record.stamp == null) {
          const now = this.now();
          // The first step after forced play, before the start: the seat
          // signed it after the last stamp, so a `start` can't go before it.
          // The clock restarts from that stamp instead, charging the forced
          // period to no one, as it does after the keeper's own downtime.
          if (this.#clocks.get(key)?.phase === 'resumed') {
            await this.#setClock(key, { epoch: clock.epoch, phase: 'started' });
            referee = new Referee(current, this.refereeKey, { now, rng: this.#rng(current) });
            this.#referees.set(key, referee);
            this.log({ game: key, event: 'restarted', seq: at, epoch: clock.epoch });
          }
          if ((flagged = referee.flag(now) !== null)) { error = 'Flag fell: the seat\'s time ran out first'; break; }
          referee.stamp(record, now);
        } else current.receive(record);
        accepted++;
      } catch (e) { error = e.message; break; }
    }
    if (accepted || flagged) {
      await this.store.save(current);
      this.#wake(key);
      await this.#settled(key, current);
    }
    this.#arm(key);
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
    await this.#settled(key, branch);
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
