// Proving workers: `max_concurrent` long-running backends, one job at a time
// each, each in its own cgroup v2 group with memory, swap, CPU and PID limits.
// An out-of-memory kill takes a worker's whole group and nothing else. A job
// that times out, runs out of memory or loses its backend fails with
// JOB_FAILED; the worker's group is killed and a fresh backend replaces it.
// Workers stay up between jobs, so the backend's class cache and precomputes
// stay warm.
//
// The groups live under a delegated cgroup subtree (`cgroup_root`). With
// "self", the gateway's own cgroup is the subtree (systemd `Delegate=yes`, or a
// container's private cgroup namespace): the gateway moves itself into a
// `gateway` leaf and runs its workers in sibling groups, as cgroup v2's
// no-internal-process rule requires. Workers keep network access: the
// in-process backend reads chain state from the RPC node while it proves.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const CGROUP_FS = '/sys/fs/cgroup';
const LEAF = 'gateway';
const PREFIX = 'worker-';

/** Runs worker processes in cgroups under a delegated root. */
export const cgroupSandbox = {
  name: 'cgroup',
  /** Resolve `root` ("self" or a directory) and enable the controllers workers need. */
  prepare(root) {
    let dir = root;
    if (root === 'self') {
      const line = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n').find(l => l.startsWith('0::'));
      if (!line) throw Error('Not on cgroup v2');
      dir = path.join(CGROUP_FS, line.slice(3).trim());
      if (path.basename(dir) === LEAF) dir = path.dirname(dir); // restarted inside the same group
      else {
        fs.mkdirSync(path.join(dir, LEAF), { recursive: true });
        fs.writeFileSync(path.join(dir, LEAF, 'cgroup.procs'), String(process.pid));
      }
    }
    try { fs.writeFileSync(path.join(dir, 'cgroup.subtree_control'), '+memory +cpu +pids'); }
    catch (e) { throw Error(`Cannot enable memory, cpu and pids for workers under ${dir} (is it delegated?): ${e.message}`); }
    // Keep some memory for the gateway, so workers under pressure reclaim from each other first.
    try { fs.writeFileSync(path.join(dir, LEAF, 'memory.min'), '256M'); } catch {}
    return dir;
  },
  /** Kill and remove worker groups a previous gateway left behind. */
  purge(root) {
    for (const name of fs.readdirSync(root)) if (name.startsWith(PREFIX)) removeGroup(path.join(root, name));
  },
  create(root, name, { memory, cpus, pids }) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) removeGroup(dir);
    fs.mkdirSync(dir);
    const set = (file, value) => fs.writeFileSync(path.join(dir, file), String(value));
    set('memory.max', memory);
    set('memory.swap.max', 0);
    set('memory.oom.group', 1);
    set('pids.max', pids);
    if (cpus) set('cpu.max', `${Math.round(cpus * 100000)} 100000`);
    return dir;
  },
  /** Start `command` inside the group: the shell joins it before exec, so every descendant is in it. */
  spawn(dir, command, args, env) {
    return spawn('/bin/sh', ['-c', 'echo $$ > "$0" && exec "$@"', path.join(dir, 'cgroup.procs'), command, ...args],
      { env, stdio: ['ignore', 'pipe', 'pipe'] });
  },
  kill(dir) { try { fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1'); } catch {} },
  remove: removeGroup,
  /** Out-of-memory kills so far, and the peak memory in bytes. */
  stats(dir) {
    const events = readKeyed(path.join(dir, 'memory.events'));
    const peak = Number(readOr(path.join(dir, 'memory.peak'), '0'));
    return { oomKills: (events.oom_kill ?? 0) + (events.oom_group_kill ?? 0), peak };
  },
  /**
   * A worker group can be created with a memory limit and a process started in
   * it lands there. The gateway refuses to start otherwise (no shared-limit fallback).
   */
  async selfTest(root) {
    const name = `${PREFIX}selftest-${process.pid}`;
    const dir = this.create(root, name, { memory: '64M', cpus: 1, pids: 16 });
    try {
      const child = this.spawn(dir, '/bin/cat', ['/proc/self/cgroup'], {});
      let out = '';
      child.stdout.on('data', d => { out += d; });
      const code = await new Promise(resolve => child.on('close', resolve));
      if (code !== 0 || !out.includes(`/${name}`)) throw Error(`Worker self-test did not run in its cgroup: ${out.trim() || `exit ${code}`}`);
    } finally { removeGroup(dir); }
  },
};

/** No isolation: plain child processes, killed by process group. For tests and hosts without delegation. */
export const processSandbox = {
  name: 'none',
  prepare: () => null,
  purge() {},
  create: () => null,
  spawn: (dir, command, args, env) => spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true }),
  kill(dir, child) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} },
  remove() {},
  stats: () => ({ oomKills: 0, peak: 0 }),
  async selfTest() {},
};

function removeGroup(dir) {
  try { fs.writeFileSync(path.join(dir, 'cgroup.kill'), '1'); } catch {}
  for (let i = 0; i < 100; i++) {
    try { fs.rmdirSync(dir); return; } catch (e) { if (e.code === 'ENOENT') return; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw Error(`Cannot remove cgroup ${dir}`);
}
const readOr = (file, fallback) => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return fallback; } };
const readKeyed = file => Object.fromEntries(readOr(file, '').split('\n').filter(Boolean).map(l => l.split(' ')).map(([k, v]) => [k, Number(v)]));

/** A queue of idle workers: `offer` returns one, `acquire` waits for one (at most `maxQueued` waiters). */
export class Slots {
  constructor(maxQueued, busy) { this.idle = []; this.waiting = []; this.maxQueued = maxQueued; this.busy = busy; }
  offer(item) { const next = this.waiting.shift(); if (next) next(item); else this.idle.push(item); }
  take(item) { this.idle = this.idle.filter(x => x !== item); }
  acquire() {
    if (this.idle.length) return Promise.resolve(this.idle.shift());
    if (this.waiting.length >= this.maxQueued) return Promise.reject(this.busy());
    return new Promise(resolve => this.waiting.push(resolve));
  }
}

/** POST a JSON-RPC call with our own timeout (fetch's hidden 300 s header timeout would cut long proofs). */
export function post(url, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timedOut = false, settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (!error) return resolve(result);
      if (timedOut) Object.assign(error, { timedOut, message: `${method}: timed out after ${timeoutMs} ms` });
      reject(error);
    };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', d => { text += d; });
      res.on('error', settle);
      res.on('end', () => {
        let answer;
        try { answer = JSON.parse(text); } catch { return settle(Error(`${method}: HTTP ${res.statusCode}: ${text.slice(0, 240)}`)); }
        if (answer.error) settle(Object.assign(Error(`${method}: ${answer.error.message}`), { rpcError: answer.error }));
        else settle(null, answer.result);
      });
    });
    const timer = setTimeout(() => { timedOut = true; req.destroy(Error('timeout')); }, timeoutMs);
    req.on('error', settle);
    req.end(body);
  });
}

/**
 * Start `size` workers running `command args` with `env(port)`, listening on
 * `basePort + i`. Resolves once every worker answers `starknet_specVersion`.
 * `failed(reason, data)` builds the error a failed job throws; `busy()` the one
 * for a full queue. Returns { version, run(params, timeoutMs), status(), close() }.
 */
export async function startWorkers({ size, maxQueued, command, args = [], env, basePort, limits, cgroupRoot = 'self',
  sandbox = cgroupSandbox, startupMs = 300000, failed, busy, log = () => {} }) {
  const root = sandbox.prepare(cgroupRoot);
  sandbox.purge(root);
  await sandbox.selfTest(root);
  const slots = new Slots(maxQueued, busy);
  let closing = false, restarts = 0;

  class Worker {
    constructor(index) { this.index = index; this.port = basePort + index; this.url = `http://127.0.0.1:${this.port}`; this.state = 'starting'; }
    async start() {
      this.state = 'starting';
      this.dir = sandbox.create(root, `${PREFIX}${this.index}`, limits);
      const child = this.child = sandbox.spawn(this.dir, command, args, env(this.port));
      const tag = `worker-${this.index}: `;
      for (const stream of [child.stdout, child.stderr]) {
        let rest = '';
        stream.setEncoding('utf8');
        stream.on('data', d => { const lines = (rest + d).split('\n'); rest = lines.pop(); for (const l of lines) process.stderr.write(tag + l + '\n'); });
      }
      this.exited = new Promise(resolve => child.on('exit', (code, signal) => resolve({ code, signal })));
      this.exited.then(() => { if (this.child === child) this.onExit(); });
      const deadline = Date.now() + startupMs;
      for (;;) {
        const exited = await Promise.race([this.exited, new Promise(r => setTimeout(r, 250, null))]);
        if (exited) throw Error(`worker ${this.index} exited during startup (${exited.signal ?? `code ${exited.code}`})`);
        try { this.version = await post(this.url, 'starknet_specVersion', [], 5000); break; } catch {}
        if (Date.now() > deadline) throw Error(`worker ${this.index} did not answer within ${startupMs} ms`);
      }
      this.state = 'ready';
      slots.offer(this);
    }
    /** An idle worker that dies is replaced; a busy one is handled by its job. */
    onExit() {
      if (this.state === 'ready' && !closing) { slots.take(this); this.replace('exited while idle'); }
    }
    /** Kill the whole group and start a fresh backend, retrying with backoff. */
    async replace(reason) {
      this.state = 'restarting';
      restarts++;
      log({ worker: this.index, event: 'restart', reason });
      const child = this.child; this.child = null;
      sandbox.kill(this.dir, child);
      await this.exited;
      sandbox.remove(this.dir);
      for (let delay = 1000; !closing; delay = Math.min(delay * 2, 30000)) {
        try { await this.start(); return; }
        catch (e) {
          log({ worker: this.index, event: 'start_failed', error: e.message });
          if (this.child) { const c = this.child; this.child = null; sandbox.kill(this.dir, c); await this.exited; sandbox.remove(this.dir); }
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
  }

  const workers = Array.from({ length: size }, (_, i) => new Worker(i));
  try { await Promise.all(workers.map(w => w.start())); }
  catch (e) { closing = true; await Promise.all(workers.map(w => w.child && (sandbox.kill(w.dir, w.child), w.exited))); workers.forEach(w => w.dir && sandbox.remove(w.dir)); throw e; }

  async function run(params, timeoutMs) {
    const worker = await slots.acquire();
    worker.state = 'busy';
    const before = sandbox.stats(worker.dir);
    try {
      const result = await post(worker.url, 'starknet_proveTransaction', params, timeoutMs);
      worker.state = 'ready'; slots.offer(worker);
      return result;
    } catch (e) {
      // The backend answered with an error: it is healthy, the request was not.
      if (e.rpcError) { worker.state = 'ready'; slots.offer(worker); throw e; }
      const exited = await Promise.race([worker.exited, new Promise(r => setTimeout(r, 1000, null))]);
      const after = sandbox.stats(worker.dir);
      const reason = after.oomKills > before.oomKills ? 'memory' : e.timedOut ? 'timeout' : exited ? 'exited' : 'unreachable';
      const data = { reason, worker: worker.index, ...(after.peak ? { peak_bytes: after.peak } : {}), ...(exited ? { exit: exited } : {}) };
      worker.replace(reason); // in the background; the worker rejoins the pool when ready
      throw failed(reason, data);
    }
  }

  const status = () => ({
    sandbox: sandbox.name, workers: size, restarts,
    ready: workers.filter(w => w.state === 'ready').length, busy: workers.filter(w => w.state === 'busy').length,
  });
  async function close() {
    closing = true;
    await Promise.all(workers.map(async w => { if (w.child) { sandbox.kill(w.dir, w.child); await w.exited; } if (w.dir) sandbox.remove(w.dir); }));
  }
  return { version: workers[0].version, run, status, close, root };
}
