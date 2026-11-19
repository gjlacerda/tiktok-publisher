import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AuthError } from '../src/errors.js';
import {
  createPkcePair,
  buildAuthorizeUrl,
  exchangeCode,
  refreshTokens,
  createTikTokTokenProvider,
} from '../src/auth/tiktok.js';

const REDIRECT = 'http://localhost:3455/callback/';

function makeConfig(tokensDir = '/nonexistent') {
  return {
    tiktok: { clientKey: 'ck', clientSecret: 'cs', redirectUri: REDIRECT, port: 3455 },
    paths: { tokensDir },
  };
}

// fetch falso: registra as chamadas e devolve a resposta configurada.
function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, form: new URLSearchParams(init.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

function tokenResponse(overrides = {}) {
  return {
    access_token: 'access-1',
    expires_in: 7200,
    open_id: 'open-1',
    refresh_token: 'refresh-1',
    refresh_expires_in: 31536000,
    scope: 'user.info.basic,video.upload',
    token_type: 'Bearer',
    ...overrides,
  };
}

async function tempTokensDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'tiktok-auth-'));
}

test('createPkcePair gera verifier válido e challenge hex', () => {
  const { verifier, challenge } = createPkcePair();
  assert.equal(verifier.length, 64);
  assert.match(verifier, /^[A-Za-z0-9\-._~]+$/);
  assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('hex'));
  assert.match(challenge, /^[0-9a-f]{64}$/);
});

test('buildAuthorizeUrl inclui escopos e PKCE', () => {
  const url = new URL(
    buildAuthorizeUrl({ clientKey: 'ck', redirectUri: REDIRECT, state: 'st', challenge: 'ch' }),
  );
  assert.equal(`${url.origin}${url.pathname}`, 'https://www.tiktok.com/v2/auth/authorize/');
  const p = url.searchParams;
  assert.equal(p.get('client_key'), 'ck');
  assert.equal(p.get('scope'), 'user.info.basic,video.upload');
  assert.equal(p.get('response_type'), 'code');
  assert.equal(p.get('redirect_uri'), 'http://localhost:3455/callback/');
  assert.equal(p.get('state'), 'st');
  assert.equal(p.get('code_challenge'), 'ch');
  assert.equal(p.get('code_challenge_method'), 'S256');
});

test('exchangeCode envia code_verifier e calcula expirações', async () => {
  const fetch = fakeFetch(tokenResponse());
  const tokens = await exchangeCode({
    config: makeConfig(),
    code: 'the-code',
    verifier: 'the-verifier',
    fetch,
    now: () => 1000,
  });

  assert.equal(fetch.calls.length, 1);
  const { url, init, form } = fetch.calls[0];
  assert.equal(url, 'https://open.tiktokapis.com/v2/oauth/token/');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(form.get('client_key'), 'ck');
  assert.equal(form.get('client_secret'), 'cs');
  assert.equal(form.get('code'), 'the-code');
  assert.equal(form.get('grant_type'), 'authorization_code');
  assert.equal(form.get('redirect_uri'), REDIRECT);
  assert.equal(form.get('code_verifier'), 'the-verifier');

  assert.deepEqual(tokens, {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    openId: 'open-1',
    scope: 'user.info.basic,video.upload',
    accessExpiresAt: 1000 + 7200 * 1000,
    refreshExpiresAt: 1000 + 31536000 * 1000,
  });
});

test('refreshTokens guarda o novo refresh token', async () => {
  const fetch = fakeFetch(tokenResponse({ access_token: 'access-2', refresh_token: 'refresh-2' }));
  const old = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    openId: 'open-1',
    scope: 'user.info.basic,video.upload',
    accessExpiresAt: 0,
    refreshExpiresAt: 10 ** 12,
  };
  const tokens = await refreshTokens({ config: makeConfig(), tokens: old, fetch, now: () => 5000 });

  const { form } = fetch.calls[0];
  assert.equal(form.get('grant_type'), 'refresh_token');
  assert.equal(form.get('refresh_token'), 'refresh-1');
  assert.equal(form.get('client_key'), 'ck');
  assert.equal(form.get('client_secret'), 'cs');
  assert.equal(tokens.accessToken, 'access-2');
  assert.equal(tokens.refreshToken, 'refresh-2');
  assert.equal(tokens.accessExpiresAt, 5000 + 7200 * 1000);
});

test('resposta com error vira AuthError tiktok', async () => {
  const fetch = fakeFetch({ error: 'invalid_grant', error_description: 'bad', log_id: 'x' });
  await assert.rejects(
    () => exchangeCode({ config: makeConfig(), code: 'c', verifier: 'v', fetch, now: () => 0 }),
    (err) => err instanceof AuthError && err.service === 'tiktok',
  );
});

test('resposta HTTP não-2xx vira AuthError tiktok', async () => {
  const fetch = fakeFetch({}, { status: 500 });
  await assert.rejects(
    () => exchangeCode({ config: makeConfig(), code: 'c', verifier: 'v', fetch, now: () => 0 }),
    (err) => err instanceof AuthError && err.service === 'tiktok',
  );
});

test('token provider renova quando faltam menos de 5 minutos e grava o arquivo', async () => {
  const tokensDir = await tempTokensDir();
  const file = path.join(tokensDir, 'tiktok.json');
  const now = 1_000_000;
  const saved = {
    accessToken: 'old-access',
    refreshToken: 'old-refresh',
    openId: 'open-1',
    scope: 'user.info.basic,video.upload',
    accessExpiresAt: now + 4 * 60 * 1000,
    refreshExpiresAt: now + 10 ** 9,
  };
  await fs.writeFile(file, JSON.stringify(saved));

  const fetch = fakeFetch(tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }));
  const provider = createTikTokTokenProvider({ config: makeConfig(tokensDir), fetch, now: () => now });

  assert.equal(await provider.getAccessToken(), 'new-access');
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].form.get('refresh_token'), 'old-refresh');

  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(onDisk.accessToken, 'new-access');
  assert.equal(onDisk.refreshToken, 'new-refresh');
  assert.equal(onDisk.accessExpiresAt, now + 7200 * 1000);
  assert.deepEqual(await fs.readdir(tokensDir), ['tiktok.json']);
});

test('token provider devolve o token salvo sem renovar quando ainda é válido', async () => {
  const tokensDir = await tempTokensDir();
  const now = 1_000_000;
  await fs.writeFile(
    path.join(tokensDir, 'tiktok.json'),
    JSON.stringify({
      accessToken: 'still-good',
      refreshToken: 'r',
      openId: 'o',
      scope: 's',
      accessExpiresAt: now + 10 * 60 * 1000,
      refreshExpiresAt: now + 10 ** 9,
    }),
  );
  const fetch = fakeFetch(tokenResponse());
  const provider = createTikTokTokenProvider({ config: makeConfig(tokensDir), fetch, now: () => now });
  assert.equal(await provider.getAccessToken(), 'still-good');
  assert.equal(fetch.calls.length, 0);
});

test('token provider lança AuthError se o refresh token expirou', async () => {
  const tokensDir = await tempTokensDir();
  const now = 1_000_000;
  await fs.writeFile(
    path.join(tokensDir, 'tiktok.json'),
    JSON.stringify({
      accessToken: 'a',
      refreshToken: 'r',
      openId: 'o',
      scope: 's',
      accessExpiresAt: now - 1000,
      refreshExpiresAt: now - 1,
    }),
  );
  const fetch = fakeFetch(tokenResponse());
  const provider = createTikTokTokenProvider({ config: makeConfig(tokensDir), fetch, now: () => now });
  await assert.rejects(
    () => provider.getAccessToken(),
    (err) => err instanceof AuthError && err.service === 'tiktok',
  );
  assert.equal(fetch.calls.length, 0);
});

test('token provider lança AuthError se o arquivo não existe', async () => {
  const tokensDir = await tempTokensDir();
  const provider = createTikTokTokenProvider({
    config: makeConfig(tokensDir),
    fetch: fakeFetch(tokenResponse()),
    now: () => 0,
  });
  await assert.rejects(
    () => provider.getAccessToken(),
    (err) => err instanceof AuthError && err.service === 'tiktok',
  );
});

test('token provider faz um único refresh com chamadas concorrentes', async () => {
  const tokensDir = await tempTokensDir();
  const now = 1_000_000;
  await fs.writeFile(
    path.join(tokensDir, 'tiktok.json'),
    JSON.stringify({
      accessToken: 'old-access',
      refreshToken: 'old-refresh',
      openId: 'o',
      scope: 's',
      accessExpiresAt: now - 1000,
      refreshExpiresAt: now + 10 ** 9,
    }),
  );
  const fetch = fakeFetch(tokenResponse({ access_token: 'new-access', refresh_token: 'new-refresh' }));
  const provider = createTikTokTokenProvider({ config: makeConfig(tokensDir), fetch, now: () => now });

  const results = await Promise.all([provider.getAccessToken(), provider.getAccessToken()]);
  assert.deepEqual(results, ['new-access', 'new-access']);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual(await fs.readdir(tokensDir), ['tiktok.json']);
});
