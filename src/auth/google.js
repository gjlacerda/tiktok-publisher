import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { OAuth2Client } from 'google-auth-library';
import { AuthError } from '../errors.js';
import { waitForCallback, openBrowser } from './loopback.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

function redirectUri(config) {
  return `http://127.0.0.1:${config.google.port}`;
}

function tokenFile(config) {
  return `${config.paths.tokensDir}/google.json`;
}

async function saveTokens(config, tokens) {
  await fs.mkdir(config.paths.tokensDir, { recursive: true });
  await fs.writeFile(tokenFile(config), JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

export async function runGoogleLogin(config) {
  const client = new OAuth2Client({
    clientId: config.google.clientId,
    clientSecret: config.google.clientSecret,
    redirectUri: redirectUri(config),
  });
  const state = crypto.randomBytes(16).toString('hex');
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent select_account',
    scope: [SCOPE],
    state,
  });

  const callback = waitForCallback({ port: config.google.port, path: '/', expectedState: state });
  // Evita "unhandled rejection" caso o callback falhe antes de o await abaixo ser alcançado.
  callback.catch(() => {});
  console.log('Abrindo o navegador para login do Google…');
  openBrowser(url);
  const { code } = await callback;

  const { tokens } = await client.getToken(code);
  await saveTokens(config, tokens);
  console.log('Login do Google concluído.');
}

function isInvalidGrant(err) {
  const text = `${err?.message ?? ''} ${JSON.stringify(err?.response?.data ?? '')}`;
  return text.includes('invalid_grant');
}

export function createGoogleTokenProvider(config) {
  let clientPromise;

  async function load() {
    let saved;
    try {
      saved = JSON.parse(await fs.readFile(tokenFile(config), 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') throw new AuthError('google');
      throw err;
    }
    const client = new OAuth2Client({
      clientId: config.google.clientId,
      clientSecret: config.google.clientSecret,
      redirectUri: redirectUri(config),
    });
    client.setCredentials(saved);
    client.on('tokens', async (tokens) => {
      // O Google só manda refresh_token na primeira vez: preserva o antigo.
      saved = { ...saved, ...tokens, refresh_token: tokens.refresh_token ?? saved.refresh_token };
      try {
        await saveTokens(config, saved);
      } catch (err) {
        // O token em memória continua válido; só não foi possível gravá-lo em disco.
        console.warn(`Aviso: não foi possível salvar o token renovado do Google (${err.message}).`);
      }
    });
    return client;
  }

  return {
    async getAccessToken() {
      clientPromise ??= load().catch((err) => {
        clientPromise = undefined;
        throw err;
      });
      const client = await clientPromise;
      try {
        const { token } = await client.getAccessToken();
        return token;
      } catch (err) {
        if (isInvalidGrant(err)) throw new AuthError('google');
        throw err;
      }
    },
  };
}
