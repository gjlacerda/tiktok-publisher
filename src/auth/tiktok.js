import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { AuthError } from '../errors.js';
import { waitForCallback, openBrowser } from './loopback.js';

const AUTHORIZE_URL = 'https://www.tiktok.com/v2/auth/authorize/';
const TOKEN_URL = 'https://open.tiktokapis.com/v2/oauth/token/';
const SCOPE = 'user.info.basic,video.upload';
const VERIFIER_LENGTH = 64;
const VERIFIER_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

function tokenFile(config) {
  return `${config.paths.tokensDir}/tiktok.json`;
}

// Grava em arquivo temporário e renomeia: o refresh token rotaciona, então uma
// escrita pela metade deixaria o usuário sem login.
async function saveTokens(config, tokens) {
  const file = tokenFile(config);
  await fs.mkdir(config.paths.tokensDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export function createPkcePair() {
  // Amostragem com rejeição: o alfabeto tem 66 caracteres, então descartamos bytes
  // >= 198 (3 * 66) para que o módulo não introduza viés.
  const limit = 256 - (256 % VERIFIER_CHARS.length);
  let verifier = '';
  while (verifier.length < VERIFIER_LENGTH) {
    for (const byte of crypto.randomBytes(VERIFIER_LENGTH)) {
      if (byte < limit && verifier.length < VERIFIER_LENGTH) verifier += VERIFIER_CHARS[byte % VERIFIER_CHARS.length];
    }
  }
  // A documentação do TikTok pede o SHA256 em hexadecimal (não base64url).
  const challenge = crypto.createHash('sha256').update(verifier).digest('hex');
  return { verifier, challenge };
}

export function buildAuthorizeUrl({ clientKey, redirectUri, state, challenge }) {
  const params = new URLSearchParams({
    client_key: clientKey,
    scope: SCOPE,
    response_type: 'code',
    redirect_uri: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function requestTokens({ form, fetch, now }) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new AuthError('tiktok');
  }
  // O TikTok pode devolver HTTP 200 com { error } no corpo.
  if (!res.ok || !data || data.error || !data.access_token || !data.refresh_token) {
    throw new AuthError('tiktok');
  }
  const issuedAt = now();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    openId: data.open_id,
    scope: data.scope,
    accessExpiresAt: issuedAt + data.expires_in * 1000,
    refreshExpiresAt: issuedAt + data.refresh_expires_in * 1000,
  };
}

export function exchangeCode({ config, code, verifier, fetch = globalThis.fetch, now = Date.now }) {
  return requestTokens({
    form: {
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: config.tiktok.redirectUri,
      code_verifier: verifier,
    },
    fetch,
    now,
  });
}

export function refreshTokens({ config, tokens, fetch = globalThis.fetch, now = Date.now }) {
  return requestTokens({
    form: {
      client_key: config.tiktok.clientKey,
      client_secret: config.tiktok.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    },
    fetch,
    now,
  });
}

export async function runTikTokLogin(config) {
  const { verifier, challenge } = createPkcePair();
  const state = crypto.randomBytes(16).toString('hex');
  const url = buildAuthorizeUrl({
    clientKey: config.tiktok.clientKey,
    redirectUri: config.tiktok.redirectUri,
    state,
    challenge,
  });

  const callback = waitForCallback({ port: config.tiktok.port, path: '/callback/', expectedState: state });
  // Evita "unhandled rejection" caso o callback falhe antes de o await abaixo ser alcançado.
  callback.catch(() => {});
  console.log('Abrindo o navegador para login do TikTok…');
  openBrowser(url);
  const { code } = await callback;

  const tokens = await exchangeCode({
    config,
    code,
    verifier,
    fetch: globalThis.fetch,
    now: Date.now,
  });
  await saveTokens(config, tokens);
  console.log('Login do TikTok concluído.');
}

export function createTikTokTokenProvider({ config, fetch = globalThis.fetch, now = Date.now }) {
  let refreshing;

  async function load() {
    try {
      return JSON.parse(await fs.readFile(tokenFile(config), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT' || err instanceof SyntaxError) throw new AuthError('tiktok');
      throw err;
    }
  }

  async function currentAccessToken() {
    const tokens = await load();
    if (tokens.accessExpiresAt - now() >= REFRESH_MARGIN_MS) return tokens.accessToken;
    if (tokens.refreshExpiresAt <= now()) throw new AuthError('tiktok');

    const renewed = await refreshTokens({ config, tokens, fetch, now });
    await saveTokens(config, renewed);
    return renewed.accessToken;
  }

  return {
    getAccessToken() {
      // Leitura, checagem e refresh ficam numa única promise em andamento: refresh
      // tokens rotacionam e o arquivo temporário é compartilhado, então chamadas
      // concorrentes não podem renovar (nem gravar) em paralelo.
      refreshing ??= currentAccessToken().finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
  };
}
