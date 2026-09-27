// SessionStore over each backend: persistence, the durable signing guard,
// crash recovery and session keys.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { IDBFactory } from 'fake-indexeddb';
import { Session, play, publicKey, rngChain, tag } from '../src/index.mjs';
import { SessionStore, indexedDbBackend, memoryBackend, parse, stringify } from '../src/store.mjs';
import { fileBackend } from '../src/store-file.mjs';
import { ADD, counter } from '../examples/counter.mjs';

const keys = [0x1a2b3cn, 0x4d5e6fn];
const chains = [rngChain(0x5eed0n, 8), rngChain(0x5eed1n, 8)];
const terms = {
  chain_id: tag('SN_TEST'), channel: 0xc4a11e1n, game_id: 7n, prover: 0xad0b7e5n, response_seconds: 3600,
  players: [0xa11cen, 0xb0bn], keys: keys.map(publicKey), rng_tips: chains.map(c => c[8]), config: { target: 20 },
};
const add = amount => play({ kind: ADD, amount });

// Each backend kind makes { backend, reopen(), shared(), done() }: `reopen`
// simulates a restart and `shared` a second tab (a second handle where the
// storage allows one).
const kinds = {
  memory: () => {
    const backend = memoryBackend();
    return { backend, reopen: async () => backend, shared: async () => backend, done: async () => {} };
  },
  file: async () => {
    const dir = await mkdtemp(join(tmpdir(), 'referee-store-'));
    let backend = await fileBackend(dir);
    return {
      backend,
      reopen: async () => { await backend.close(); return (backend = await fileBackend(dir)); },
      shared: async () => backend,
      done: async () => { await backend.close(); await rm(dir, { recursive: true, force: true }); },
    };
  },
  indexedDB: () => {
    const indexedDB = new IDBFactory();
    const handles = [indexedDbBackend('referee', { indexedDB })];
    const another = async () => { handles.push(indexedDbBackend('referee', { indexedDB })); return handles.at(-1); };
    return { backend: handles[0], reopen: another, shared: another, done: () => Promise.all(handles.map(h => h.close())) };
  },
};

for (const [name, make] of Object.entries(kinds)) {
  const run = (title, body) => test(`${name}: ${title}`, async () => {
    const k = await make();
    try { await body(k); } finally { await k.done(); }
  });

  run('a session survives a restart with its marks', async k => {
    const store = new SessionStore(k.backend);
    const session = await store.open(counter, terms);
    await store.move(session, add(3), keys[0]);
    const theirs = new Session(counter, terms);
    theirs.receive(session.steps[0]);
    await store.receive(session, theirs.move(add(2), keys[1]));

    const restored = await new SessionStore(await k.reopen()).load(counter, terms);
    assert.equal(restored.stateHash(), session.stateHash());
    assert.deepEqual(restored.lastSigned[0], session.lastSigned[0]);
    assert.equal(restored.lastSigned[1], null);
    assert.equal(await new SessionStore(k.backend).load(counter, { ...terms, game_id: 8n }), null);
  });

  run('a second tab cannot sign a different step at a signed seq', async k => {
    const tabA = new SessionStore(k.backend), tabB = new SessionStore(await k.shared());
    await tabA.open(counter, terms);
    const a = await tabA.load(counter, terms), b = await tabB.load(counter, terms);
    const sent = await tabA.move(a, add(3), keys[0]);
    await assert.rejects(tabB.move(b, add(1), keys[0]), /Would equivocate: this key signed a different step at seq 0/);
    assert.equal(b.env.seq, 0);
    assert.equal(b.lastSigned[0].seq, 0);
    // The same step is not equivocation, and brings tab B level with tab A.
    assert.deepEqual((await tabB.move(b, add(3), keys[0])).signature, sent.signature);
    assert.equal(b.stateHash(), a.stateHash());
  });

  run('a stale transcript does not replace a later one', async k => {
    const store = new SessionStore(k.backend);
    await store.open(counter, terms);
    const stale = await store.load(counter, terms), fresh = await store.load(counter, terms);
    await store.move(fresh, add(3), keys[0]);
    await store.move(fresh, add(2), keys[1]);
    await assert.rejects(store.save(stale), /Stale session/);
    // Restoring an old transcript never rolls back the marks: they re-apply
    // the steps they signed...
    await store.save(stale, { replace: true });
    assert.equal((await store.load(counter, terms)).stateHash(), fresh.stateHash());
    // ...and where they cannot bridge the gap, nothing is signed behind them.
    await store.move(fresh, add(1), keys[0]);
    await store.save(stale, { replace: true });
    const old = await store.load(counter, terms);
    assert.equal(old.env.seq, 0);
    await assert.rejects(store.move(old, add(3), keys[0]), /Session is behind seq 2, which this key signed/);
    assert.equal(old.env.seq, 0);
  });

  run('a crash between the mark and the transcript is recovered on load', async k => {
    const store = new SessionStore(k.backend);
    await store.open(counter, terms);
    let failures = 1;
    const flaky = {
      ...k.backend,
      update: (key, fn) => (key.startsWith('session/') && failures-- > 0 ? Promise.reject(Error('disk full')) : k.backend.update(key, fn)),
    };
    const session = await new SessionStore(flaky).load(counter, terms);
    await assert.rejects(new SessionStore(flaky).move(session, add(3), keys[0]), /disk full/);

    const restored = await new SessionStore(await k.reopen()).load(counter, terms);
    assert.equal(restored.env.seq, 1);
    assert.equal(restored.stateHash(), session.stateHash());
    assert.equal((await new SessionStore(k.backend).load(counter, terms)).env.seq, 1, 'recovery was saved');
  });

  run('load verifies every signature', async k => {
    const store = new SessionStore(k.backend);
    const session = await store.open(counter, terms);
    await store.move(session, add(3), keys[0]);
    const key = (await k.backend.keys('session/'))[0];
    await k.backend.update(key, stored => {
      stored.record.steps[0].signature.s ^= 1n;
      return stored;
    });
    await assert.rejects(new SessionStore(k.backend).load(counter, terms), /Invalid session signature/);
  });

  run('session keys and ids are stored with their BigInts', async k => {
    const store = new SessionStore(k.backend);
    await store.saveKey(keys[1], { seed: 0x5eed1n, length: 8 });
    assert.deepEqual(await store.keyFor(terms), { seat: 1, privateKey: keys[1], seed: 0x5eed1n, length: 8 });
    assert.equal(await store.keyFor({ ...terms, keys: [1n, 2n] }), null);
    await store.open(counter, terms);
    assert.deepEqual(await store.list(), [{ chain_id: terms.chain_id, channel: terms.channel, game_id: terms.game_id }]);
    assert.equal((await store.open(counter, terms)).env.seq, 0);
    await assert.rejects(store.open(counter, { ...terms, response_seconds: 60 }), /Stored session has other terms/);
  });
}

test('file: one process owns a store directory', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'referee-store-'));
  try {
    const backend = await fileBackend(dir);
    await assert.rejects(fileBackend(dir), new RegExp(`in use by process ${process.pid}`));
    await backend.close();
    await (await fileBackend(dir)).close();
    // A lock left by a process that exited is taken over.
    const { pid } = spawnSync(process.execPath, ['-e', '']);
    await writeFile(join(dir, 'LOCK'), `${pid}\n`);
    const again = await fileBackend(dir);
    assert.equal(Number(await readFile(join(dir, 'LOCK'), 'utf8')), process.pid);
    await again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stored JSON keeps BigInts, including negative ones', () => {
  const value = { a: [1n, -2n, 3], b: { $n: 'x', c: 4 }, d: (1n << 251n) + 5n };
  assert.deepEqual(parse(stringify(value)), value);
});
