// The gateway's workers in real cgroups: each worker's group has the job
// limits, a job over its memory budget is killed alone and reported as such,
// and a timeout kills a worker's whole group. Needs a delegated cgroup subtree,
// so run it with prover/test/cgroup.sh (a systemd user scope with
// Delegate=yes); skipped otherwise. Workers run mock-backend.mjs.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { JOB_FAILED } from '../server.mjs';
import { alive, childPid, code, job, until, workerGateway } from './helpers.mjs';

const skip = process.env.ARBITER_CGROUP_TEST !== '1' && 'needs a delegated cgroup: run prover/test/cgroup.sh';
const failed = reason => e => code(JOB_FAILED)(e) && e.rpcError.data.reason === reason;
// The delegated subtree: this process's cgroup, or its parent once the gateway has moved into `gateway`.
const root = () => {
  const dir = join('/sys/fs/cgroup', readFileSync('/proc/self/cgroup', 'utf8').match(/^0::(.*)$/m)[1]);
  return basename(dir) === 'gateway' ? dirname(dir) : dir;
};
const read = (group, file) => readFileSync(join(root(), group, file), 'utf8').trim();

test('each worker runs in its own group with the job limits', { skip }, async () => {
  const s = await workerGateway({ config: { workers: { job_memory: '512M', job_cpus: 2, pids_max: 64 } } });
  try {
    const pids = (await Promise.all([job(s.gateway.url, '0x6'), job(s.gateway.url, '0x6')])).map(r => r.proof);
    for (const group of ['worker-0', 'worker-1']) {
      assert.equal(read(group, 'memory.max'), String(512 << 20));
      assert.equal(read(group, 'memory.swap.max'), '0');
      assert.equal(read(group, 'memory.oom.group'), '1');
      assert.equal(read(group, 'pids.max'), '64');
      assert.equal(read(group, 'cpu.max'), '200000 100000');
    }
    assert.deepEqual([read('worker-0', 'cgroup.procs'), read('worker-1', 'cgroup.procs')].sort(), pids.sort());
    assert.equal((await s.info()).backend.sandbox, 'cgroup');
  } finally { await s.close(); }
  assert(!existsSync(join(root(), 'worker-0')), 'closing removes the groups');
});

test('a job over its memory budget fails alone and its worker is replaced', { skip }, async () => {
  const s = await workerGateway({ config: { workers: { job_memory: '256M' } } });
  try {
    const [hog, other] = await Promise.allSettled([job(s.gateway.url, '0x4'), job(s.gateway.url, '0x6')]);
    assert(failed('memory')(hog.reason), JSON.stringify(hog.reason?.rpcError));
    assert(hog.reason.rpcError.data.peak_bytes > 200 << 20);
    assert.equal(other.status, 'fulfilled');
    await until(async () => (await s.info()).backend.ready === 2);
    await Promise.all([job(s.gateway.url), job(s.gateway.url)]);
  } finally { await s.close(); }
});

test('a timeout kills the worker\'s whole group', { skip }, async () => {
  const s = await workerGateway({ config: { max_concurrent: 1, backend_timeout_ms: 500 } });
  try {
    await assert.rejects(job(s.gateway.url, '0x5'), failed('timeout'));
    const child = childPid();
    await until(() => !alive(child));
    await job(s.gateway.url);
  } finally { await s.close(); }
});

test('groups left by a previous gateway are removed at startup', { skip }, async () => {
  mkdirSync(join(root(), 'worker-7'));
  const s = await workerGateway({ config: { max_concurrent: 1 } });
  try { assert(!existsSync(join(root(), 'worker-7'))); } finally { await s.close(); }
});
