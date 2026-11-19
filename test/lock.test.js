import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withLock } from '../src/lock.js';

async function tmpLock(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lock-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return path.join(dir, 'processed.json.lock');
}

test('withLock adquire, grava o pid, executa e libera', async (t) => {
  const lockPath = await tmpLock(t);
  const result = await withLock(lockPath, async () => {
    assert.equal(await fs.readFile(lockPath, 'utf8'), String(process.pid));
    return 'ok';
  });
  assert.equal(result, 'ok');
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});

test('withLock libera o lock quando a função falha', async (t) => {
  const lockPath = await tmpLock(t);
  await assert.rejects(
    withLock(lockPath, async () => {
      throw new Error('boom');
    }),
    { message: 'boom' },
  );
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});

test('segundo withLock enquanto o primeiro segura falha com mensagem em português', async (t) => {
  const lockPath = await tmpLock(t);
  await withLock(lockPath, async () => {
    let ran = false;
    await assert.rejects(
      withLock(lockPath, async () => {
        ran = true;
      }),
      {
        name: 'LockError',
        message: `Outra execução está em andamento (pid ${process.pid}). Se não estiver, apague ${lockPath}.`,
      },
    );
    assert.equal(ran, false);
    assert.equal(await fs.readFile(lockPath, 'utf8'), String(process.pid));
  });
});

test('lock de um pid que não existe mais é recuperado', async (t) => {
  const lockPath = await tmpLock(t);
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
  await fs.writeFile(lockPath, child.stdout.toString());
  let ran = false;
  await withLock(lockPath, async () => {
    ran = true;
    assert.equal(await fs.readFile(lockPath, 'utf8'), String(process.pid));
  });
  assert.equal(ran, true);
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});
