import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPublisher } from '../src/publisher.js';
import { AuthError, LimitReachedError, TelegramError } from '../src/errors.js';
import { LIMIT_MESSAGE } from '../src/telegram.js';

const video = (id) => ({ id, name: `${id}.mp4`, mimeType: 'video/mp4', size: 10 });
const tags = (id) => ({ id, name: 'hashtags', mimeType: 'text/plain' });
const slot = (name, files) => ({ id: `slot-${name}`, name, files });
const day = (name, slots) => ({ id: `day-${name}`, name, slots });

const treeOf = () => [
  day('18-11-2026', [slot('01', [video('v18'), tags('t18')])]),
  day('17-11-2026', [slot('01', [video('v17'), tags('t17')])]),
];

async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'publisher-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { statePath: path.join(dir, 'processed.json'), tmpDir: path.join(dir, 'tmp') };
}

const readState = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const writeState = (p, s) => fs.writeFile(p, JSON.stringify(s));

const unconfirmedEntry = (overrides = {}) => ({
  day: '17-11-2026',
  slot: '01',
  fileName: 'v17.mp4',
  hashtagsFile: { id: 't17', mimeType: 'text/plain' },
  status: 'unconfirmed',
  publishId: 'pub-old',
  initAt: '2026-11-16T10:00:00.000Z',
  uploadedAt: null,
  telegramSent: false,
  ...overrides,
});

function makeFakes({ tree = treeOf(), hooks = {} } = {}) {
  const calls = { download: [], init: [], chunks: [], wait: [], status: [], send: [], readText: [] };
  let n = 0;
  const drive = {
    async scanTree() {
      return tree;
    },
    async downloadToFile(file, dest) {
      calls.download.push(file.id);
      if (hooks.download) await hooks.download(file, dest);
      await fs.writeFile(dest, 'bytes');
    },
    async readText(file) {
      calls.readText.push(file.id);
      if (hooks.readText) return hooks.readText(file);
      return `#tags-${file.id}`;
    },
  };
  const tiktok = {
    async initInboxUpload(size) {
      calls.init.push(size);
      if (hooks.init) await hooks.init(calls.init.length);
      n += 1;
      return { publishId: `pub-${n}`, uploadUrl: `https://up/${n}`, plan: { ranges: [] } };
    },
    async uploadChunks(args) {
      calls.chunks.push(args);
      if (hooks.uploadChunks) await hooks.uploadChunks(args);
    },
    async fetchStatus(publishId) {
      calls.status.push(publishId);
      if (hooks.fetchStatus) return hooks.fetchStatus(publishId);
      return { status: 'SEND_TO_USER_INBOX' };
    },
    async waitForInbox(publishId, opts) {
      calls.wait.push({ publishId, opts });
      if (hooks.waitForInbox) return hooks.waitForInbox(publishId);
      return { outcome: 'sent' };
    },
  };
  const telegram = {
    async send(text) {
      calls.send.push(text);
      if (hooks.send) await hooks.send(text, calls.send.length);
    },
  };
  return { drive, tiktok, telegram, calls };
}

const run = (fakes, paths, extra = {}) =>
  runPublisher({
    drive: fakes.drive,
    tiktok: fakes.tiktok,
    telegram: fakes.telegram,
    rootFolderId: 'root',
    ...paths,
    log: () => {},
    ...extra,
  });

test('envia vídeos pendentes em ordem e grava sent', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes();
  const summary = await run(fakes, paths, { waitOptions: { timeoutMs: 5 } });
  assert.deepEqual(summary.sent, ['17-11-2026/01', '18-11-2026/01']);
  assert.deepEqual(summary.failed, []);
  assert.equal(fakes.calls.send.length, 2);
  assert.match(fakes.calls.send[0], /17-11-2026 · vídeo 01/);
  assert.match(fakes.calls.send[0], /#tags-t17/);
  assert.deepEqual(fakes.calls.wait[0].opts, { timeoutMs: 5 });
  const state = await readState(paths.statePath);
  assert.deepEqual(Object.keys(state).sort(), ['v17', 'v18']);
  for (const entry of Object.values(state)) {
    assert.equal(entry.status, 'sent');
    assert.equal(entry.telegramSent, true);
    assert.ok(entry.uploadedAt);
  }
  assert.deepEqual(state.v17.hashtagsFile, { id: 't17', mimeType: 'text/plain' });
  assert.equal(state.v17.fileName, 'v17.mp4');
});

test('pula vídeos já enviados', async (t) => {
  const paths = await setup(t);
  await writeState(paths.statePath, {
    v17: unconfirmedEntry({ status: 'sent', uploadedAt: 'x', telegramSent: true }),
  });
  const fakes = makeFakes({ tree: [treeOf()[1]] });
  const summary = await run(fakes, paths);
  assert.equal(summary.skipped, 1);
  assert.equal(fakes.calls.init.length, 0);
  assert.deepEqual(summary.sent, []);
});

test('grava unconfirmed antes de subir as partes', async (t) => {
  const paths = await setup(t);
  let seen;
  const fakes = makeFakes({
    tree: [treeOf()[1]],
    hooks: {
      uploadChunks: async () => {
        seen = await readState(paths.statePath);
      },
    },
  });
  await run(fakes, paths, { now: () => new Date('2026-11-17T12:00:00.000Z') });
  assert.equal(seen.v17.status, 'unconfirmed');
  assert.equal(seen.v17.publishId, 'pub-1');
  assert.equal(seen.v17.initAt, '2026-11-17T12:00:00.000Z');
  assert.equal(seen.v17.uploadedAt, null);
  assert.equal(seen.v17.telegramSent, false);
});

test('FAILED remove a entrada para tentar de novo', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({
    tree: [treeOf()[1]],
    hooks: { waitForInbox: async () => ({ outcome: 'failed', failReason: 'file_format_check_failed' }) },
  });
  const summary = await run(fakes, paths);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].ref, '17-11-2026/01');
  assert.match(summary.failed[0].message, /file_format_check_failed/);
  assert.deepEqual(summary.sent, []);
  assert.deepEqual(await readState(paths.statePath), {});
  assert.equal(fakes.calls.send.length, 0);
});

test('resultado incerto fica unconfirmed e avisa no Telegram', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({
    tree: [treeOf()[1]],
    hooks: { waitForInbox: async () => ({ outcome: 'unconfirmed' }) },
  });
  const summary = await run(fakes, paths);
  assert.deepEqual(summary.unconfirmed, ['17-11-2026/01']);
  assert.deepEqual(summary.sent, []);
  const state = await readState(paths.statePath);
  assert.equal(state.v17.status, 'unconfirmed');
  assert.equal(state.v17.publishId, 'pub-1');
  assert.equal(fakes.calls.send.length, 1);
  assert.match(fakes.calls.send[0], /não confirmou/);
});

test('reconciliação confirma unconfirmed sem reenviar', async (t) => {
  const paths = await setup(t);
  await writeState(paths.statePath, { v17: unconfirmedEntry() });
  const fakes = makeFakes({ tree: [treeOf()[1]] });
  const summary = await run(fakes, paths);
  assert.deepEqual(fakes.calls.status, ['pub-old']);
  assert.equal(fakes.calls.init.length, 0);
  assert.deepEqual(summary.sent, ['17-11-2026/01']);
  assert.equal(summary.skipped, 1);
  const state = await readState(paths.statePath);
  assert.equal(state.v17.status, 'sent');
  assert.ok(state.v17.uploadedAt);
  assert.equal(state.v17.telegramSent, true);
  assert.equal(fakes.calls.send.length, 1);
});

test('reconciliação com FAILED reenvia na mesma execução', async (t) => {
  const paths = await setup(t);
  await writeState(paths.statePath, { v17: unconfirmedEntry() });
  const fakes = makeFakes({
    tree: [treeOf()[1]],
    hooks: { fetchStatus: async () => ({ status: 'FAILED', failReason: 'x' }) },
  });
  const summary = await run(fakes, paths);
  assert.equal(fakes.calls.init.length, 1);
  assert.deepEqual(summary.sent, ['17-11-2026/01']);
  assert.equal(summary.skipped, 0);
  const state = await readState(paths.statePath);
  assert.equal(state.v17.publishId, 'pub-1');
  assert.equal(state.v17.status, 'sent');
});

test('reconciliação ainda incerta (ou com erro) mantém unconfirmed e avisa', async (t) => {
  const paths = await setup(t);
  await writeState(paths.statePath, { v17: unconfirmedEntry() });
  const fakes = makeFakes({
    tree: [treeOf()[1]],
    hooks: {
      fetchStatus: async () => {
        throw new Error('rede');
      },
    },
  });
  const summary = await run(fakes, paths);
  assert.deepEqual(summary.unconfirmed, ['17-11-2026/01']);
  assert.equal(fakes.calls.init.length, 0);
  assert.equal(summary.skipped, 1);
  assert.equal((await readState(paths.statePath)).v17.status, 'unconfirmed');
  assert.match(fakes.calls.send[0], /não confirmou/);
});

test('limite de pendentes para o laço e avisa', async (t) => {
  const paths = await setup(t);
  const tree = ['17', '18', '19'].map((d) => day(`${d}-11-2026`, [slot('01', [video(`v${d}`)])]));
  const fakes = makeFakes({
    tree,
    hooks: {
      init: async (count) => {
        if (count === 2) throw new LimitReachedError();
      },
    },
  });
  const summary = await run(fakes, paths);
  assert.equal(summary.limitReached, true);
  assert.deepEqual(summary.sent, ['17-11-2026/01']);
  assert.equal(fakes.calls.init.length, 2);
  assert.deepEqual(fakes.calls.download, ['v17', 'v18']);
  assert.ok(fakes.calls.send.includes(LIMIT_MESSAGE));
  assert.deepEqual(Object.keys(await readState(paths.statePath)), ['v17']);
});

test('falha no Telegram mantém o vídeo enviado e reenvia a mensagem na próxima execução', async (t) => {
  const paths = await setup(t);
  const tree = [treeOf()[1]];
  const first = makeFakes({
    tree,
    hooks: {
      send: async () => {
        throw new TelegramError('fora do ar');
      },
    },
  });
  const s1 = await run(first, paths);
  assert.deepEqual(s1.sent, ['17-11-2026/01']);
  assert.equal(s1.warnings.length, 1);
  assert.match(s1.warnings[0], /Telegram/);
  const state1 = await readState(paths.statePath);
  assert.equal(state1.v17.status, 'sent');
  assert.equal(state1.v17.telegramSent, false);

  const second = makeFakes({ tree });
  const s2 = await run(second, paths);
  assert.equal(second.calls.init.length, 0);
  assert.equal(second.calls.send.length, 1);
  assert.match(second.calls.send[0], /#tags-t17/);
  assert.equal((await readState(paths.statePath)).v17.telegramSent, true);
  assert.deepEqual(s2.warnings, []);
});

test('falha ao ler hashtags vira aviso e tenta de novo na próxima execução', async (t) => {
  const paths = await setup(t);
  const tree = [treeOf()[1]];
  const first = makeFakes({
    tree,
    hooks: {
      readText: async () => {
        throw new Error('403');
      },
    },
  });
  const s1 = await run(first, paths);
  assert.equal(s1.warnings.length, 1);
  assert.equal(first.calls.send.length, 0);
  assert.equal((await readState(paths.statePath)).v17.telegramSent, false);
  const second = makeFakes({ tree });
  await run(second, paths);
  assert.equal(second.calls.send.length, 1);
});

test('vídeo sem arquivo de hashtags envia mensagem sem hashtags', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({ tree: [day('17-11-2026', [slot('01', [video('v17')])])] });
  await run(fakes, paths);
  assert.equal(fakes.calls.readText.length, 0);
  assert.match(fakes.calls.send[0], /sem hashtags/);
  assert.equal((await readState(paths.statePath)).v17.hashtagsFile, null);
});

test('AuthError interrompe a execução', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({
    hooks: {
      init: async () => {
        throw new AuthError('tiktok');
      },
    },
  });
  await assert.rejects(run(fakes, paths), AuthError);
  assert.equal(fakes.calls.init.length, 1);
  assert.deepEqual(await readState(paths.statePath).catch(() => ({})), {});
});

test('AuthError na reconciliação interrompe a execução', async (t) => {
  const paths = await setup(t);
  await writeState(paths.statePath, { v17: unconfirmedEntry() });
  const fakes = makeFakes({
    hooks: {
      fetchStatus: async () => {
        throw new AuthError('tiktok');
      },
    },
  });
  await assert.rejects(run(fakes, paths), AuthError);
  assert.equal((await readState(paths.statePath)).v17.status, 'unconfirmed');
});

test('erro antes do init vai para failed, sem entrada, e o laço continua', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({
    hooks: {
      download: async (file) => {
        if (file.id === 'v17') throw new Error('download quebrou');
      },
    },
  });
  const summary = await run(fakes, paths);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].ref, '17-11-2026/01');
  assert.match(summary.failed[0].message, /download quebrou/);
  assert.deepEqual(summary.sent, ['18-11-2026/01']);
  assert.deepEqual(Object.keys(await readState(paths.statePath)), ['v18']);
});

test('erro no uploadChunks mantém unconfirmed, entra em failed e o laço continua', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({
    hooks: {
      uploadChunks: async (args) => {
        if (args.uploadUrl === 'https://up/1') throw new Error('parte 2 falhou');
      },
    },
  });
  const summary = await run(fakes, paths);
  assert.equal(summary.failed.length, 1);
  assert.equal(summary.failed[0].ref, '17-11-2026/01');
  assert.match(summary.failed[0].message, /parte 2 falhou/);
  assert.deepEqual(summary.sent, ['18-11-2026/01']);
  const state = await readState(paths.statePath);
  assert.equal(state.v17.status, 'unconfirmed');
  assert.equal(state.v17.publishId, 'pub-1');
  assert.equal(state.v18.status, 'sent');
  assert.equal(fakes.calls.send.length, 1);
});

test('dry-run não altera nada', async (t) => {
  const paths = await setup(t);
  const initial = {
    v16: unconfirmedEntry({ day: '16-11-2026', fileName: 'v16.mp4', publishId: 'pub-x' }),
  };
  await writeState(paths.statePath, initial);
  const before = await fs.readFile(paths.statePath, 'utf8');
  const fakes = makeFakes();
  const summary = await run(fakes, paths, { dryRun: true });
  assert.deepEqual(summary.planned, ['16-11-2026/01', '17-11-2026/01', '18-11-2026/01']);
  assert.deepEqual(summary.sent, []);
  assert.equal(await fs.readFile(paths.statePath, 'utf8'), before);
  assert.equal(fakes.calls.init.length, 0);
  assert.equal(fakes.calls.send.length, 0);
  assert.equal(fakes.calls.download.length, 0);
  assert.equal(fakes.calls.status.length, 0);
});

test('avisos da fila entram em summary.warnings', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({ tree: [day('dia errado', [])] });
  const summary = await run(fakes, paths);
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0], /dia errado/);
});

test('apaga o arquivo temporário mesmo com erro no upload', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({
    tree: [treeOf()[1]],
    hooks: {
      uploadChunks: async () => {
        throw new Error('quebrou');
      },
    },
  });
  await run(fakes, paths);
  assert.deepEqual(await fs.readdir(paths.tmpDir), []);
});

test('apaga o arquivo temporário também quando um AuthError propaga', async (t) => {
  const paths = await setup(t);
  const fakes = makeFakes({
    tree: [treeOf()[1]],
    hooks: {
      uploadChunks: async () => {
        throw new AuthError('tiktok');
      },
    },
  });
  await assert.rejects(run(fakes, paths), AuthError);
  assert.deepEqual(await fs.readdir(paths.tmpDir), []);
});
