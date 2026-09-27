// Node file backend for `SessionStore` (`@referee/sdk/store/file`): one JSON
// file per key in a directory, replaced atomically and synced before a write
// resolves. One process owns a directory at a time; a LOCK file holds its pid.
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from './store.mjs';

const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
};

async function lock(dir) {
  const path = join(dir, 'LOCK');
  try {
    await writeFile(path, `${process.pid}\n`, { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(path, 'utf8'));
    if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw Error(`Session store ${dir} is in use by process ${pid}`);
    await writeFile(path, `${process.pid}\n`); // left by a process that exited
  }
  return path;
}

async function sync(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Open (creating) a store directory and take its lock; `close()` releases it. */
export async function fileBackend(dir) {
  await mkdir(dir, { recursive: true });
  const lockPath = await lock(dir);
  const path = key => join(dir, `${encodeURIComponent(key)}.json`);
  const read = async key => {
    try { return parse(await readFile(path(key), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const write = async (key, value) => {
    const tmp = `${path(key)}.tmp`;
    const handle = await open(tmp, 'w');
    try { await handle.writeFile(stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, path(key));
    await sync(dir).catch(() => {}); // persists the rename; not every platform can sync a directory
  };
  let tail = Promise.resolve();
  const serial = task => {
    const run = tail.then(task);
    tail = run.catch(() => {});
    return run;
  };
  return {
    get: read,
    put: (key, value) => serial(() => write(key, value)),
    update: (key, fn) => serial(async () => {
      const next = fn(await read(key));
      await write(key, next);
      return next;
    }),
    keys: async prefix => (await readdir(dir))
      .filter(file => file.endsWith('.json'))
      .map(file => decodeURIComponent(file.slice(0, -'.json'.length)))
      .filter(key => key.startsWith(prefix)),
    close: () => serial(() => rm(lockPath, { force: true })),
  };
}
