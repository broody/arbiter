// Client for a referee keeper (`@referee/sdk/keeper`): archive a session, send
// our steps and fetch the other seat's, over the keeper's HTTP API. The keeper
// cannot forge steps (this client verifies each one it applies) but it can
// withhold them, so a client keeps its own copy (`@referee/sdk/store`).
import { Session, felt, hex } from './index.mjs';
import { parse, stringify } from './store.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };
const path = ids => `/games/${hex(ids.channel)}/${hex(ids.game_id)}`;
const signed = ({ step, signature }) => ({ step, signature });

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
    const steps = session.steps.slice(from - session.start.seq).map(signed);
    return this.#call('POST', `${path(session.terms)}/steps`, { from, steps });
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
      if (store) await store.receive(session, signed(record));
      else session.receive(signed(record));
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
