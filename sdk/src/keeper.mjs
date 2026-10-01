// Client for an arbiter keeper (`@arbiter/sdk/keeper`): archive a session, send
// our steps and fetch the other seat's, over the keeper's HTTP API. The keeper
// cannot forge steps (this client verifies each one it applies) but it can
// withhold them, so a client keeps its own copy (`@arbiter/sdk/store`). A
// keeper that referees a timed game also stamps each step it receives. Steps
// arrive by long poll (`pull`) or as a server-sent event stream (`follow`).
import { Session, felt, hex, signedStep } from './index.mjs';
import { parse, stringify } from './store.mjs';

const check = (condition, message) => { if (!condition) throw Error(message); };
const path = ids => `/games/${hex(ids.channel)}/${hex(ids.game_id)}`;

export class KeeperClient {
  constructor(url, { fetch = globalThis.fetch } = {}) {
    this.url = url.replace(/\/$/, '');
    this.fetch = fetch;
  }

  /**
   * Archive `session`, or merge it into the keeper's copy. A game that no
   * channel anchors needs, the first time, each seat's wallet signature over
   * `termsTypedData(game, terms)`, in seat order.
   */
  register(session, { authorizations } = {}) {
    return this.#call('POST', '/games', { record: session.export(), ...(authorizations ? { authorizations } : {}) });
  }

  /**
   * The keeper's randomness tip for the game `ids` (`{ chain_id, channel,
   * game_id }`), as `{ rng_tip, signature }`: the tip of the referee's hash
   * chain and the referee's signature over it (`tipHash`). The last seat brings
   * both to `join` when the creator asked for the referee's randomness. A game
   * that no channel anchors passes its `config`, and puts the tip in its terms
   * (`clock.rng_tip`); each seat checks the signature before it signs them.
   */
  tip(ids, { config } = {}) {
    return this.#call('POST', `${path(ids)}/tip`, config === undefined ? {} : { config });
  }

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
    return this.#apply(session, steps, store);
  }

  /**
   * Follow the game's step stream (server-sent events): apply each step past
   * `session`'s end as the keeper gets it, as `pull` does, and call
   * `onSteps(records)` after each batch. Resolves when `signal` aborts or the
   * keeper ends the stream; rejects if the keeper holds another branch.
   */
  async follow(session, { store, signal, onSteps = () => {} } = {}) {
    const response = await this.fetch(`${this.url}${path(session.terms)}/events?from=${session.env.seq}`,
      { signal, headers: { Accept: 'text/event-stream' } });
    if (!response.ok) await failed(response);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += value.replace(/\r\n?/g, '\n');
        for (let end; (end = buffer.indexOf('\n\n')) >= 0;) {
          const event = parseEvent(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (event.type === 'steps') onSteps(await this.#apply(session, parse(event.data).steps, store));
        }
      }
    } catch (error) {
      if (signal?.aborted) return;
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  // Apply records past the session's end, skipping ones it already holds (a
  // stream may repeat our own steps back to us).
  async #apply(session, steps, store) {
    const applied = [];
    for (const record of steps) {
      if (record.seq < session.env.seq) {
        const held = session.steps[record.seq - session.start.seq];
        check(record.seq < session.start.seq || (held && held.message === felt(record.message)),
          `The keeper holds another branch at seq ${record.seq}`);
        continue;
      }
      check(record.seq === session.env.seq && felt(record.transcript) === session.env.transcript,
        `The keeper holds another branch at seq ${record.seq}`);
      if (store) await store.receive(session, signedStep(record));
      else session.receive(signedStep(record));
      applied.push(record);
    }
    return applied;
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
    if (!response.ok) await failed(response);
    const text = await response.text();
    return text ? parse(text) : null;
  }
}

// Throw the keeper's `{ error: { message, data } }` with its HTTP status.
async function failed(response) {
  let data = null;
  try { data = parse(await response.text()); } catch { /* not JSON */ }
  throw Object.assign(Error(data?.error?.message ?? `HTTP ${response.status}`), { status: response.status, data: data?.error?.data });
}

// One server-sent event block: its `event:` type and `data:` lines. Comment
// lines (heartbeats) start with a colon.
function parseEvent(block) {
  const event = { type: 'message', data: '' };
  const data = [];
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'event') event.type = value;
    else if (field === 'data') data.push(value);
  }
  event.data = data.join('\n');
  return event;
}
