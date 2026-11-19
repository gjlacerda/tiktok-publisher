import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { waitForCallback } from '../src/auth/loopback.js';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Espera o servidor subir antes de chamar o callback.
const tick = () => new Promise((resolve) => setTimeout(resolve, 50));

test('waitForCallback devolve o code com state correto', async () => {
  const port = await freePort();
  const pending = waitForCallback({ port, path: '/cb', expectedState: 's' });
  await tick();
  const res = await fetch(`http://127.0.0.1:${port}/cb?code=abc&state=s`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Login concluído, pode fechar esta aba\./);
  assert.deepEqual(await pending, { code: 'abc' });
});

test('waitForCallback rejeita state diferente', async () => {
  const port = await freePort();
  const pending = waitForCallback({ port, path: '/cb', expectedState: 's' });
  const assertion = assert.rejects(pending, /state/);
  await tick();
  await fetch(`http://127.0.0.1:${port}/cb?code=abc&state=outro`);
  await assertion;
});

test('waitForCallback rejeita quando vem error', async () => {
  const port = await freePort();
  const pending = waitForCallback({ port, path: '/cb', expectedState: 's' });
  const assertion = assert.rejects(pending, /access_denied/);
  await tick();
  await fetch(`http://127.0.0.1:${port}/cb?error=access_denied&state=s`);
  await assertion;
});

test('waitForCallback rejeita no timeout', async () => {
  const port = await freePort();
  await assert.rejects(
    waitForCallback({ port, path: '/cb', expectedState: 's', timeoutMs: 50 }),
    /Tempo esgotado/,
  );
});

test('waitForCallback responde 404 em outros caminhos sem encerrar', async () => {
  const port = await freePort();
  const pending = waitForCallback({ port, path: '/cb', expectedState: 's' });
  await tick();
  const other = await fetch(`http://127.0.0.1:${port}/outro?code=x&state=s`);
  assert.equal(other.status, 404);
  await fetch(`http://127.0.0.1:${port}/cb?code=abc&state=s`);
  assert.deepEqual(await pending, { code: 'abc' });
});
