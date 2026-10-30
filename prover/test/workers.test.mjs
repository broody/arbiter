// The gateway's proving workers without cgroups (the `none` sandbox): one job
// per worker, a failed job's worker replaced, the environment they start with.
// Workers run mock-backend.mjs. cgroup.test.mjs repeats the isolation checks
// under real cgroups.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { availableParallelism } from 'node:os';
import { JOB_FAILED, SERVICE_BUSY } from '../server.mjs';
import { processSandbox } from '../workers.mjs';
import { alive, childPid, code, job, until, workerGateway } from './helpers.mjs';

const setup = (options = {}) => workerGateway({ sandbox: processSandbox, ...options });
const failed = reason => e => code(JOB_FAILED)(e) && e.rpcError.data.reason === reason;

test('each worker proves one job at a time, with its share of the cores', async () => {
  const s = await setup();
  try {
    const started = Date.now();
    const [a, b] = await Promise.all([job(s.gateway.url, '0x6'), job(s.gateway.url, '0x6')]);
    assert.notEqual(a.proof, b.proof, 'two workers served the two jobs');
    assert(Date.now() - started < 550, 'in parallel');
    const threads = String(Math.max(1, Math.floor(availableParallelism() / 2)));
    assert.deepEqual(a.env, { MAX_CONCURRENT_REQUESTS: '1', PROVER_IP: '127.0.0.1', PROVER_PORT: a.env.PROVER_PORT,
      RAYON_NUM_THREADS: threads });
    const info = await s.info();
    assert.deepEqual(info.backend, { sandbox: 'none', workers: 2, restarts: 0, ready: 2, busy: 0 });
    assert.equal(info.limits.job_memory, '12G');
    assert.equal(info.limits.job_threads, Number(threads));
  } finally { await s.close(); }
});

test('a job that times out fails, and its worker and children are replaced', async () => {
  const s = await setup({ config: { max_concurrent: 1, backend_timeout_ms: 500 } });
  try {
    const before = Number((await job(s.gateway.url)).proof);
    await assert.rejects(job(s.gateway.url, '0x5'), failed('timeout'));
    const child = childPid();
    await until(() => !alive(before) && !alive(child));
    const after = Number((await job(s.gateway.url)).proof);
    assert.notEqual(after, before);
    assert.equal((await s.info()).backend.restarts, 1);
    assert(s.logs.some(e => e.event === 'restart' && e.reason === 'timeout'));
  } finally { await s.close(); }
});

test('a worker that stops mid-job fails that job only and is replaced', async () => {
  const s = await setup();
  try {
    const [crash, other] = await Promise.allSettled([job(s.gateway.url, '0x3'), job(s.gateway.url, '0x6')]);
    assert(failed('exited')(crash.reason));
    assert.equal(other.status, 'fulfilled');
    await until(async () => (await s.info()).backend.ready === 2);
    await Promise.all([job(s.gateway.url), job(s.gateway.url)]);
  } finally { await s.close(); }
});

test('an idle worker that dies is replaced', async () => {
  const s = await setup({ config: { max_concurrent: 1 } });
  try {
    const pid = Number((await job(s.gateway.url)).proof);
    process.kill(pid, 'SIGKILL');
    await until(async () => { const b = (await s.info()).backend; return b.restarts === 1 && b.ready === 1; });
    assert.notEqual(Number((await job(s.gateway.url)).proof), pid);
  } finally { await s.close(); }
});

test('a full queue answers busy', async () => {
  const s = await setup({ config: { max_concurrent: 1, max_queued: 1 } });
  try {
    const results = await Promise.allSettled([1, 2, 3].map(() => job(s.gateway.url, '0x6')));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
    assert(code(SERVICE_BUSY)(results.find(r => r.status === 'rejected').reason));
  } finally { await s.close(); }
});

test('workers start only from a build with the current patches', async () => {
  // A build without build.json, or a PROOF1 build's (other patches), would prove with other pins.
  await assert.rejects(setup({ patched: false }), /not built with the prover\/patches: rerun prover\/build.sh/);
  await assert.rejects(setup({ patched: 'stale' }), /not built with the current prover\/patches: rerun prover\/build.sh/);
});

test('job_cpus gives each worker that many threads', async () => {
  const s = await setup({ config: { max_concurrent: 1, workers: { job_cpus: 3 } } });
  try {
    const { env } = await job(s.gateway.url);
    assert.deepEqual(env, { MAX_CONCURRENT_REQUESTS: '1', PROVER_IP: '127.0.0.1', PROVER_PORT: env.PROVER_PORT, RAYON_NUM_THREADS: '3' });
  } finally { await s.close(); }
});
