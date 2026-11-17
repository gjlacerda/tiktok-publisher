import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadState, saveState, resolveEntry } from '../src/state.js';

async function tmpFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'state-test-'));
  return path.join(dir, 'processed.json');
}

function entry(overrides = {}) {
  return {
    day: '17-11-2026',
    slot: '01',
    fileName: 'video.mp4',
    hashtagsFile: { id: 'h1', mimeType: 'text/plain' },
    status: 'unconfirmed',
    publishId: 'p1',
    initAt: '2026-11-17T10:00:00.000Z',
    uploadedAt: null,
    telegramSent: false,
    ...overrides,
  };
}

test('loadState sem arquivo devolve {}', async () => {
  const file = await tmpFile();
  assert.deepEqual(await loadState(file), {});
});

test('saveState e loadState fazem ida e volta', async () => {
  const file = await tmpFile();
  const state = { drive1: entry() };
  await saveState(file, state);
  assert.deepEqual(await loadState(file), state);
  await assert.rejects(fs.access(`${file}.tmp`), { code: 'ENOENT' });
  const raw = await fs.readFile(file, 'utf8');
  assert.equal(raw, JSON.stringify(state, null, 2));
});

test('loadState com JSON inválido lança erro e não devolve {}', async () => {
  const file = await tmpFile();
  await fs.writeFile(file, '{ nao eh json');
  await assert.rejects(loadState(file), /corrompido/);
  await assert.rejects(loadState(file), (err) => err.message.includes(file));
});

test('resolveEntry sent marca enviado e deixa Telegram pendente', () => {
  const state = { drive1: entry({ telegramSent: true }) };
  const next = resolveEntry(state, '17-11-2026/01', 'sent');
  assert.equal(next.drive1.status, 'sent');
  assert.equal(next.drive1.telegramSent, false);
  assert.match(next.drive1.uploadedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(state.drive1.status, 'unconfirmed');
  assert.equal(state.drive1.uploadedAt, null);
});

test('resolveEntry sent preserva uploadedAt já existente', () => {
  const state = { drive1: entry({ uploadedAt: '2026-11-17T11:00:00.000Z' }) };
  const next = resolveEntry(state, '17-11-2026/01', 'sent');
  assert.equal(next.drive1.uploadedAt, '2026-11-17T11:00:00.000Z');
});

test('resolveEntry retry remove a entrada', () => {
  const state = { drive1: entry(), drive2: entry({ slot: '02' }) };
  const next = resolveEntry(state, '17-11-2026/01', 'retry');
  assert.deepEqual(Object.keys(next), ['drive2']);
  assert.ok('drive1' in state);
});

test('resolveEntry com ref desconhecida lança erro', () => {
  const state = { drive1: entry() };
  assert.throws(
    () => resolveEntry(state, '18-11-2026/01', 'sent'),
    { name: 'ResolveError', message: 'Nenhum vídeo não confirmado registrado como 18-11-2026/01' },
  );
});

test('resolveEntry retry em entrada sent lança erro e não altera o estado', () => {
  const state = { drive1: entry({ status: 'sent', uploadedAt: 'x', telegramSent: true }) };
  const before = structuredClone(state);
  assert.throws(
    () => resolveEntry(state, '17-11-2026/01', 'retry'),
    { name: 'ResolveError', message: '17-11-2026/01 já está como enviado; nada a resolver.' },
  );
  assert.deepEqual(state, before);
});

test('resolveEntry sent em entrada sent lança erro', () => {
  const state = { drive1: entry({ status: 'sent', uploadedAt: 'x', telegramSent: true }) };
  assert.throws(
    () => resolveEntry(state, '17-11-2026/01', 'sent'),
    { name: 'ResolveError', message: '17-11-2026/01 já está como enviado; nada a resolver.' },
  );
});

test('resolveEntry com duas entradas na mesma ref resolve só a unconfirmed', () => {
  const state = {
    drive1: entry({ status: 'sent', uploadedAt: 'x', telegramSent: true }),
    drive2: entry({ publishId: 'p2' }),
  };
  const retried = resolveEntry(state, '17-11-2026/01', 'retry');
  assert.deepEqual(Object.keys(retried), ['drive1']);
  const sent = resolveEntry(state, '17-11-2026/01', 'sent');
  assert.equal(sent.drive1.telegramSent, true);
  assert.equal(sent.drive2.status, 'sent');
  assert.equal(state.drive2.status, 'unconfirmed');
});
