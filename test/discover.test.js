import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDayName, isHashtagsFile, buildQueue } from '../src/drive/discover.js';

const video = (id) => ({ id, name: `${id}.mp4`, mimeType: 'video/mp4', size: 10 });
const tags = (id = 'tags') => ({ id, name: 'hashtags', mimeType: 'text/plain' });
const slot = (name, files) => ({ id: `slot-${name}`, name, files });
const day = (name, slots) => ({ id: `day-${name}`, name, slots });

test('parseDayName aceita DD-MM-YYYY válido e rejeita o resto', () => {
  const d = parseDayName('17-11-2026');
  assert.ok(d instanceof Date);
  assert.equal(d.toISOString(), '2026-11-17T00:00:00.000Z');
  assert.equal(parseDayName('2026-11-17'), null);
  assert.equal(parseDayName('31-02-2026'), null);
  assert.equal(parseDayName('dia 1'), null);
});

test('isHashtagsFile reconhece hashtags com ou sem .txt', () => {
  assert.equal(isHashtagsFile('hashtags'), true);
  assert.equal(isHashtagsFile('Hashtags.txt'), true);
  assert.equal(isHashtagsFile('hashtag.txt'), true);
  assert.equal(isHashtagsFile('hashtags.doc'), false);
  assert.equal(isHashtagsFile('tags'), false);
});

test('buildQueue ordena por data real entre meses e anos', () => {
  const names = ['18-11-2026', '05-01-2027', '17-11-2026', '01-12-2026'];
  const tree = names.map((n) => day(n, [slot('01', [video(`v-${n}`)])]));
  const { items, warnings } = buildQueue(tree);
  assert.deepEqual(items.map((i) => i.day), ['17-11-2026', '18-11-2026', '01-12-2026', '05-01-2027']);
  assert.deepEqual(warnings, []);
});

test('buildQueue ordena slots numericamente', () => {
  const tree = [day('17-11-2026', ['10', '02', '01'].map((s) => slot(s, [video(`v${s}`)])))];
  const { items } = buildQueue(tree);
  assert.deepEqual(items.map((i) => i.slot), ['01', '02', '10']);
});

test('buildQueue pareia vídeo e hashtags e aceita falta de hashtags', () => {
  const tree = [
    day('17-11-2026', [
      slot('01', [video('a'), tags('t1'), { id: 'x', name: 'capa.jpg', mimeType: 'image/jpeg' }]),
      slot('02', [video('b')]),
    ]),
  ];
  const { items, warnings } = buildQueue(tree);
  assert.equal(items.length, 2);
  assert.equal(items[0].video.id, 'a');
  assert.equal(items[0].hashtags.id, 't1');
  assert.equal(items[0].day, '17-11-2026');
  assert.equal(items[0].slot, '01');
  assert.equal(items[1].video.id, 'b');
  assert.equal(items[1].hashtags, null);
  assert.deepEqual(warnings, []);
});

test('buildQueue pula e avisa slot sem vídeo ou com dois vídeos', () => {
  const tree = [
    day('17-11-2026', [
      slot('01', [tags()]),
      slot('02', [video('a'), video('b')]),
      slot('03', [video('c')]),
    ]),
  ];
  const { items, warnings } = buildQueue(tree);
  assert.deepEqual(items.map((i) => i.video.id), ['c']);
  assert.equal(warnings.length, 2);
});

test('buildQueue ignora e avisa pasta de dia com nome inválido', () => {
  const tree = [
    day('rascunhos', [slot('01', [video('a')])]),
    day('17-11-2026', [slot('01', [video('b')])]),
  ];
  const { items, warnings } = buildQueue(tree);
  assert.deepEqual(items.map((i) => i.video.id), ['b']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /rascunhos/);
});

test('buildQueue ignora e avisa pasta de slot com nome inválido', () => {
  const tree = [day('17-11-2026', [slot('abc', [video('a')]), slot('01', [video('b')])])];
  const { items, warnings } = buildQueue(tree);
  assert.deepEqual(items.map((i) => i.video.id), ['b']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /abc/);
});
