import fs from 'node:fs/promises';
import { LockError } from './errors.js';

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code !== 'ESRCH';
  }
}

async function tryCreate(lockPath) {
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
  try {
    await handle.writeFile(String(process.pid));
  } finally {
    await handle.close();
  }
  return true;
}

// Lock exclusivo por arquivo: impede duas execuções (ou `resolve` durante uma execução) de sobrescreverem o estado.
export async function withLock(lockPath, fn) {
  let acquired = await tryCreate(lockPath);
  if (!acquired) {
    const raw = await fs.readFile(lockPath, 'utf8').catch((err) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    const pid = raw === null ? NaN : Number.parseInt(raw, 10);
    if (raw === null || (Number.isInteger(pid) && !isAlive(pid))) {
      await fs.rm(lockPath, { force: true });
      acquired = await tryCreate(lockPath);
    }
    if (!acquired) {
      const who = Number.isInteger(pid) ? ` (pid ${pid})` : '';
      throw new LockError(`Outra execução está em andamento${who}. Se não estiver, apague ${lockPath}.`);
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true });
  }
}
