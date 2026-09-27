// Client for a referee keeper (`@referee/sdk/keeper`): archive a session, send
// our steps and fetch the other seat's, over the keeper's HTTP API. The keeper
// cannot forge steps (this client verifies each one it applies) but it can
// withhold them, so a client keeps its own copy (`@referee/sdk/store`). A
// keeper that referees a timed game also stamps each step it receives.
import { Session, felt, hex, signedStep } from './index.mjs';
import { parse, stringify } from './store.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };
const path = ids => `/games/${hex(ids.channel)}/${hex(ids.game_id)}`;

export class KeeperClient {
  constructor(url, { fetch = globalThis.fetch } = {}) {
    this.url = url.replace(/\/$/, '');
    this.fetch = fetch;
  }

  /** Archive `session`, or merge it into the keeper's copy. */
  register(session) { return this.#call('POST', '/games', { record: session.export() }); }

  /** Send `session`'s steps from seq `from` (default: every step). */
  send(session, from = session.start.seq) {
    from = Math.max(from, session.start.seq);
    const steps = session.steps.slice(from - session.start.seq).map(signedStep);
    return this.#call('POST', `${path(session.terms)}/steps`, { from, steps });
  }

  /**
   * In a timed game, send our steps awaiting a stamp (`session.pending`) to
   * the keeper that referees the game, then pull them back stamped, with
   * anything after them, as `pull` does. Sending again is harmless.
   */
  async submit(session, options = {}) {
    const pending = session.pending;
    if (pending.length) {
      await this.#call('POST', `${path(session.terms)}/steps`, { from: pending[0].seq, steps: pending.map(signedStep) });
    }
    return this.pull(session, options);
  }

  /**
   * Signed step records from seq `from`, as `{ start, seq, transcript, steps }`.
   * With `wait` (seconds), waits for at least one.
   */
  steps(ids, from, { wait = 0, signal } = {}) {
    return this.#call('GET', `${path(ids)}/steps?from=${from}&wait=${wait}`, undefined, signal);
  }

  /**
   * Apply the keeper's steps past `session`'s end, through `store`
   * (`SessionStore`) when given, and return them. Throws if the keeper holds
   * another branch.
   */
  async pull(session, { wait = 0, store, signal } = {}) {
    const { steps } = await this.steps(session.terms, session.env.seq, { wait, signal });
    for (const record of steps) {
      check(record.seq === session.env.seq && felt(record.transcript) === session.env.transcript,
        `The keeper holds another branch at seq ${record.seq}`);
      if (store) await store.receive(session, signedStep(record));
      else session.receive(signedStep(record));
    }
    return steps;
  }

  /** The keeper's copy of a game, with every signature verified. */
  async load(game, ids) {
    const { record } = await this.#call('GET', path(ids));
    return Session.import(game, record);
  }

  /** Equivocation evidence the keeper recorded for a game. */
  async evidence(ids) { return (await this.#call('GET', `${path(ids)}/evidence`)).evidence; }

  async #call(method, route, body, signal) {
    const response = await this.fetch(`${this.url}${route}`, {
      method, signal, body: body === undefined ? undefined : stringify(body),
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    });
    const text = await response.text();
    let data = null;
    try { data = text ? parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok) {
      throw Object.assign(Error(data?.error?.message ?? `HTTP ${response.status}`), { status: response.status, data: data?.error?.data });
    }
    return data;
  }
}
