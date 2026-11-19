import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTikTokClient } from '../src/tiktok/client.js';
import { AuthError, LimitReachedError, TikTokApiError } from '../src/errors.js';

const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const okInit = {
  data: { publish_id: 'v_pub_file~v2.123', upload_url: 'https://upload.example.test/video' },
  error: { code: 'ok', message: '', log_id: 'x' },
};

function makeClient(responses, overrides = {}) {
  const calls = [];
  const queue = [...responses];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const next = queue.shift();
    if (!next) throw new Error('fetch inesperado');
    return typeof next === 'function' ? next(url, init) : next;
  };
  const sleeps = [];
  const sleep = async (ms) => {
    sleeps.push(ms);
  };
  const client = createTikTokClient({
    getAccessToken: async () => 'tok123',
    fetch,
    sleep,
    now: () => 1_000_000,
    ...overrides,
  });
  return { client, calls, sleeps };
}

test('initInboxUpload envia source_info correto', async () => {
  const { client, calls, sleeps } = makeClient([jsonResponse(200, okInit)]);
  const result = await client.initInboxUpload(18_200_000);

  assert.equal(result.publishId, 'v_pub_file~v2.123');
  assert.equal(result.uploadUrl, 'https://upload.example.test/video');
  assert.equal(result.plan.totalChunkCount, 1);
  assert.deepEqual(sleeps, []);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, INIT_URL);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok123');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json; charset=UTF-8');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    source_info: {
      source: 'FILE_UPLOAD',
      video_size: 18_200_000,
      chunk_size: 18_200_000,
      total_chunk_count: 1,
    },
  });
});

test('initInboxUpload mapeia o limite de pendentes', async () => {
  const { client } = makeClient([
    jsonResponse(403, {
      data: {},
      error: { code: 'spam_risk_too_many_pending_share', message: 'x', log_id: 'y' },
    }),
  ]);
  await assert.rejects(() => client.initInboxUpload(1000), LimitReachedError);
});

test('initInboxUpload mapeia access_token_invalid para AuthError', async () => {
  const { client } = makeClient([
    jsonResponse(401, { data: {}, error: { code: 'access_token_invalid', message: 'x' } }),
  ]);
  await assert.rejects(
    () => client.initInboxUpload(1000),
    (err) => err instanceof AuthError && err.service === 'tiktok',
  );
});

test('initInboxUpload converte outro erro em TikTokApiError', async () => {
  const { client } = makeClient([
    jsonResponse(400, { data: {}, error: { code: 'invalid_param', message: 'ruim' } }),
  ]);
  await assert.rejects(
    () => client.initInboxUpload(1000),
    (err) => err instanceof TikTokApiError && err.code === 'invalid_param' && err.httpStatus === 400,
  );
});

test('initInboxUpload trata corpo que não é JSON como invalid_response', async () => {
  const { client } = makeClient([new Response('<html>oops</html>', { status: 502 })]);
  await assert.rejects(
    () => client.initInboxUpload(1000),
    (err) => err instanceof TikTokApiError && err.code === 'invalid_response' && err.httpStatus === 502,
  );
});

test('initInboxUpload espera e repete no rate limit', async () => {
  const { client, calls, sleeps } = makeClient([
    jsonResponse(429, { data: {}, error: { code: 'rate_limit_exceeded', message: 'x' } }),
    jsonResponse(200, okInit),
  ]);
  const result = await client.initInboxUpload(1000);
  assert.equal(result.publishId, 'v_pub_file~v2.123');
  assert.equal(calls.length, 2);
  assert.ok(sleeps.includes(60000));
});

test('initInboxUpload desiste após 3 repetições no rate limit', async () => {
  const limited = () => jsonResponse(429, { data: {}, error: { code: 'rate_limit_exceeded', message: 'x' } });
  const { client, calls, sleeps } = makeClient([limited(), limited(), limited(), limited()]);
  await assert.rejects(
    () => client.initInboxUpload(1000),
    (err) => err instanceof TikTokApiError && err.code === 'rate_limit_exceeded' && err.httpStatus === 429,
  );
  assert.equal(calls.length, 4);
  assert.equal(sleeps.filter((ms) => ms === 60000).length, 3);
});

test('initInboxUpload respeita 10 s entre inits', async () => {
  const { client, sleeps } = makeClient([jsonResponse(200, okInit), jsonResponse(200, okInit)]);
  await client.initInboxUpload(1000);
  assert.deepEqual(sleeps, []);
  await client.initInboxUpload(1000);
  assert.deepEqual(sleeps, [10000]);
});

async function withTempFile(bytes, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tt-chunks-'));
  const filePath = path.join(dir, 'v.mp4');
  await fs.writeFile(filePath, bytes);
  try {
    return await fn(filePath);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const plan25 = {
  chunkSize: 10,
  totalChunkCount: 2,
  ranges: [
    { start: 0, end: 9 },
    { start: 10, end: 24 },
  ],
};

test('uploadChunks envia Content-Range de cada parte', async () => {
  const data = Buffer.from(Array.from({ length: 25 }, (_, i) => i));
  await withTempFile(data, async (filePath) => {
    const { client, calls } = makeClient([
      new Response(null, { status: 206 }),
      new Response(null, { status: 201 }),
    ]);
    await client.uploadChunks({
      uploadUrl: 'https://upload.example.test/video',
      filePath,
      mimeType: 'video/mp4',
      plan: plan25,
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, 'https://upload.example.test/video');
    assert.equal(calls[0].init.method, 'PUT');
    assert.equal(calls[0].init.headers['Content-Type'], 'video/mp4');
    assert.equal(calls[0].init.headers['Content-Length'], '10');
    assert.equal(calls[0].init.headers['Content-Range'], 'bytes 0-9/25');
    assert.equal(calls[0].init.headers.Authorization, undefined);
    assert.deepEqual(Buffer.from(calls[0].init.body), data.subarray(0, 10));
    assert.equal(calls[1].init.headers['Content-Length'], '15');
    assert.equal(calls[1].init.headers['Content-Range'], 'bytes 10-24/25');
    assert.deepEqual(Buffer.from(calls[1].init.body), data.subarray(10, 25));
  });
});

test('uploadChunks falha se a última parte não devolver 201', async () => {
  await withTempFile(Buffer.alloc(25, 1), async (filePath) => {
    const { client } = makeClient([
      new Response(null, { status: 206 }),
      new Response(null, { status: 206 }),
    ]);
    await assert.rejects(
      () =>
        client.uploadChunks({
          uploadUrl: 'https://upload.example.test/video',
          filePath,
          mimeType: 'video/mp4',
          plan: plan25,
        }),
      (err) => err instanceof TikTokApiError && err.code === 'upload_failed' && err.httpStatus === 206,
    );
  });
});

test('uploadChunks falha se uma parte intermediária não devolver 206', async () => {
  await withTempFile(Buffer.alloc(25, 1), async (filePath) => {
    const { client, calls } = makeClient([new Response(null, { status: 500 })]);
    await assert.rejects(
      () =>
        client.uploadChunks({
          uploadUrl: 'https://upload.example.test/video',
          filePath,
          mimeType: 'video/mp4',
          plan: plan25,
        }),
      (err) => err instanceof TikTokApiError && err.code === 'upload_failed' && err.httpStatus === 500,
    );
    assert.equal(calls.length, 1);
  });
});

function statusResponse(status, failReason) {
  return jsonResponse(200, {
    data: { status, fail_reason: failReason },
    error: { code: 'ok', message: '', log_id: 'z' },
  });
}

test('fetchStatus devolve status e failReason', async () => {
  const { client, calls } = makeClient([statusResponse('FAILED', 'file_format_check_failed')]);
  const result = await client.fetchStatus('pid');
  assert.deepEqual(result, { status: 'FAILED', failReason: 'file_format_check_failed' });
  assert.equal(calls[0].url, STATUS_URL);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok123');
  assert.deepEqual(JSON.parse(calls[0].init.body), { publish_id: 'pid' });
});

test('fetchStatus mapeia access_token_invalid para AuthError', async () => {
  const { client } = makeClient([
    jsonResponse(401, { data: {}, error: { code: 'access_token_invalid', message: 'x' } }),
  ]);
  await assert.rejects(() => client.fetchStatus('pid'), AuthError);
});

test('waitForInbox mapeia SEND_TO_USER_INBOX, FAILED e timeout', async () => {
  // sent (após uma consulta ainda processando)
  {
    const { client, sleeps } = makeClient([
      statusResponse('PROCESSING_UPLOAD'),
      statusResponse('SEND_TO_USER_INBOX'),
    ]);
    const result = await client.waitForInbox('pid', { intervalMs: 5000, timeoutMs: 120000 });
    assert.deepEqual(result, { outcome: 'sent' });
    assert.deepEqual(sleeps, [5000]);
  }
  // PUBLISH_COMPLETE também é sent
  {
    const { client } = makeClient([statusResponse('PUBLISH_COMPLETE')]);
    assert.deepEqual(await client.waitForInbox('pid'), { outcome: 'sent' });
  }
  // failed
  {
    const { client } = makeClient([statusResponse('FAILED', 'picture_size_check_failed')]);
    const result = await client.waitForInbox('pid');
    assert.deepEqual(result, { outcome: 'failed', failReason: 'picture_size_check_failed' });
  }
  // timeout: `now` avança a cada sleep
  {
    let t = 0;
    const responses = Array.from({ length: 50 }, () => statusResponse('PROCESSING_UPLOAD'));
    const { client } = makeClient(responses, {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
    const result = await client.waitForInbox('pid', { intervalMs: 5000, timeoutMs: 20000 });
    assert.deepEqual(result, { outcome: 'unconfirmed' });
    assert.equal(t, 20000);
  }
});

test('waitForInbox ignora erros não-auth e continua', async () => {
  const { client } = makeClient([
    new Response('boom', { status: 500 }),
    statusResponse('SEND_TO_USER_INBOX'),
  ]);
  assert.deepEqual(await client.waitForInbox('pid'), { outcome: 'sent' });
});

test('waitForInbox propaga AuthError', async () => {
  const { client } = makeClient([
    jsonResponse(401, { data: {}, error: { code: 'access_token_invalid', message: 'x' } }),
  ]);
  await assert.rejects(() => client.waitForInbox('pid'), AuthError);
});
