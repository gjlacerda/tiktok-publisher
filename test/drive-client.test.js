import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDriveClient } from '../src/drive/client.js';
import { AuthError } from '../src/errors.js';

const FOLDER = 'application/vnd.google-apps.folder';
const DOC = 'application/vnd.google-apps.document';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// Fake fetch: grava as chamadas e responde por função de roteiro.
function makeClient(respond) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return respond(new URL(String(url)), options, calls.length);
  };
  const client = createDriveClient({ getAccessToken: async () => 'tok-123', fetch });
  return { client, calls };
}

test('listChildren segue nextPageToken', async () => {
  const { client, calls } = makeClient((url, _o, n) =>
    n === 1
      ? json({
          nextPageToken: 'PAGE2',
          files: [
            { id: 'a', name: 'a.mp4', mimeType: 'video/mp4', size: '100' },
            { id: 'b', name: 'b.mp4', mimeType: 'video/mp4', size: '200' },
          ],
        })
      : json({ files: [{ id: 'c', name: 'c.mp4', mimeType: 'video/mp4', size: '300' }] }),
  );
  const files = await client.listChildren('folder1');
  assert.equal(files.length, 3);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get('pageToken'), 'PAGE2');
  assert.deepEqual(files[0], { id: 'a', name: 'a.mp4', mimeType: 'video/mp4', size: 100 });
});

test('listChildren exclui a lixeira', async () => {
  const { client, calls } = makeClient(() => json({ files: [] }));
  await client.listChildren('folder1');
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://www.googleapis.com/drive/v3/files');
  assert.equal(url.searchParams.get('q'), "'folder1' in parents and trashed = false");
  assert.equal(url.searchParams.get('fields'), 'nextPageToken, files(id, name, mimeType, size)');
  assert.equal(url.searchParams.get('pageSize'), '1000');
  assert.equal(url.searchParams.get('supportsAllDrives'), 'true');
  assert.equal(url.searchParams.get('includeItemsFromAllDrives'), 'true');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer tok-123');
});

test('listChildren deixa size indefinido quando ausente', async () => {
  const { client } = makeClient(() => json({ files: [{ id: 'd', name: 'doc', mimeType: DOC }] }));
  const [file] = await client.listChildren('folder1');
  assert.equal(file.size, undefined);
});

test('readText exporta Google Docs como texto', async () => {
  const { client, calls } = makeClient(() => new Response('#tag1 #tag2'));
  const text = await client.readText({ id: 'doc1', name: 'hashtags', mimeType: DOC });
  assert.equal(text, '#tag1 #tag2');
  assert.ok(calls[0].url.includes('/files/doc1/export?mimeType=text%2Fplain'), calls[0].url);
});

test('readText baixa arquivo comum com alt=media', async () => {
  const { client, calls } = makeClient(() => new Response('#a #b'));
  const text = await client.readText({
    id: 'f1',
    name: 'hashtags.txt',
    mimeType: 'application/octet-stream',
  });
  assert.equal(text, '#a #b');
  assert.ok(calls[0].url.includes('/files/f1?'), calls[0].url);
  assert.equal(new URL(calls[0].url).searchParams.get('alt'), 'media');
});

test('downloadToFile grava o corpo no arquivo por stream', async () => {
  const { client, calls } = makeClient(() => new Response('bytes'));
  const dest = path.join(tmpdir(), `drive-client-test-${process.pid}-${Date.now()}.bin`);
  try {
    await client.downloadToFile({ id: 'v1', name: 'v.mp4', mimeType: 'video/mp4' }, dest);
    assert.equal(await readFile(dest, 'utf8'), 'bytes');
    assert.equal(new URL(calls[0].url).searchParams.get('alt'), 'media');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer tok-123');
  } finally {
    await rm(dest, { force: true });
  }
});

test('scanTree monta dias e slots', async () => {
  const children = {
    root: [
      { id: 'd1', name: '10-11-2026', mimeType: FOLDER },
      { id: 'loose', name: 'solto.txt', mimeType: 'text/plain' },
    ],
    d1: [{ id: 's1', name: '1', mimeType: FOLDER }],
    s1: [
      { id: 'v1', name: 'a.mp4', mimeType: 'video/mp4', size: '10' },
      { id: 'h1', name: 'hashtags.txt', mimeType: 'text/plain', size: '5' },
      { id: 'sub', name: 'subpasta', mimeType: FOLDER },
    ],
  };
  const { client } = makeClient((url) => {
    const q = url.searchParams.get('q');
    const id = /^'([^']+)' in parents/.exec(q)[1];
    return json({ files: children[id] });
  });
  const tree = await client.scanTree('root');
  assert.deepEqual(tree, [
    {
      id: 'd1',
      name: '10-11-2026',
      slots: [
        {
          id: 's1',
          name: '1',
          files: [
            { id: 'v1', name: 'a.mp4', mimeType: 'video/mp4', size: 10 },
            { id: 'h1', name: 'hashtags.txt', mimeType: 'text/plain', size: 5 },
          ],
        },
      ],
    },
  ]);
});

test('401 vira AuthError google', async () => {
  const { client } = makeClient(() => new Response('unauthorized', { status: 401 }));
  await assert.rejects(
    () => client.listChildren('folder1'),
    (err) => err instanceof AuthError && err.service === 'google',
  );
});

test('resposta não-2xx vira Error com status e corpo', async () => {
  const { client } = makeClient(() => new Response('boom', { status: 500 }));
  await assert.rejects(
    () => client.readText({ id: 'x', name: 'x', mimeType: 'text/plain' }),
    (err) => err instanceof Error && err.message.includes('500') && err.message.includes('boom'),
  );
});
