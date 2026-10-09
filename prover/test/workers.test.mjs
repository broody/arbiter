// The gateway's proving workers without cgroups (the `none` sandbox): one job
// per worker, a failed job's worker replaced, the memory mode's environment.
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

test('each worker proves one job at a time with the memory mode\'s environment', async () => {
  const s = await setup({ config: { memory: 'bounded' } });
  try {
    const started = Date.now();
    const [a, b] = await Promise.all([job(s.gateway.url, '0x6'), job(s.gateway.url, '0x6')]);
    assert.notEqual(a.proof, b.proof, 'two workers served the two jobs');
    assert(Date.now() - started < 550, 'in parallel');
    const threads = String(Math.max(1, Math.floor(availableParallelism() / 2)));
    assert.deepEqual(a.env, { MAX_CONCURRENT_REQUESTS: '1', PROVER_BOUNDED_CAIRO_COLUMNS: '16', PROVER_BOUNDED_CIRCUIT_COLUMNS: '16',
      PROVER_IP: '127.0.0.1', PROVER_LOW_MEMORY: '1', PROVER_MALLOC_TRIM: '1', PROVER_PORT: a.env.PROVER_PORT,
      RAYON_NUM_THREADS: threads });
    const info = await s.info();
    assert.deepEqual(info.backend, { sandbox: 'none', workers: 2, restarts: 0, ready: 2, busy: 0 });
    assert.equal(info.limits.job_memory, '16G');
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

test('bounded memory, the default, needs a build with the current patches', async () => {
  await assert.rejects(setup({ patched: false }), /needs a backend built with the prover\/patches/);
  await assert.rejects(setup({ config: { memory: 'bounded' }, patched: 'stale' }), /built with the current prover\/patches/);
});

test('standard memory trims the heap with the current patches and sets an mmap threshold otherwise', async () => {
  for (const [patched, release] of [[true, { PROVER_MALLOC_TRIM: '1' }], ['stale', { MALLOC_MMAP_THRESHOLD_: '1048576' }],
    [false, { MALLOC_MMAP_THRESHOLD_: '1048576' }]]) {
    const s = await setup({ config: { memory: 'standard', max_concurrent: 1, workers: { job_cpus: 3 } }, patched });
    try {
      const { env } = await job(s.gateway.url);
      assert.deepEqual(env, { MAX_CONCURRENT_REQUESTS: '1', PROVER_IP: '127.0.0.1', PROVER_PORT: env.PROVER_PORT,
        RAYON_NUM_THREADS: '3', ...release });
    } finally { await s.close(); }
  }
});
