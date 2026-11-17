import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, assertConfig } from '../src/config.js';
import { ConfigError } from '../src/errors.js';

const fullEnv = {
  TIKTOK_CLIENT_KEY: 'k',
  TIKTOK_CLIENT_SECRET: 's',
  GOOGLE_CLIENT_ID: 'gid',
  GOOGLE_CLIENT_SECRET: 'gsecret',
  DRIVE_ROOT_FOLDER_ID: 'folder',
  TELEGRAM_BOT_TOKEN: 'bot',
  TELEGRAM_CHAT_ID: '123',
};

test('loadConfig mapeia todas as variáveis', () => {
  const config = loadConfig({ env: fullEnv, rootDir: '/r' });
  assert.equal(config.tiktok.clientKey, 'k');
  assert.equal(config.tiktok.clientSecret, 's');
  assert.equal(config.tiktok.redirectUri, 'http://localhost:3455/callback/');
  assert.equal(config.tiktok.port, 3455);
  assert.equal(config.google.clientId, 'gid');
  assert.equal(config.google.clientSecret, 'gsecret');
  assert.equal(config.google.port, 3456);
  assert.equal(config.driveRootFolderId, 'folder');
  assert.equal(config.telegram.botToken, 'bot');
  assert.equal(config.telegram.chatId, '123');
  assert.equal(config.paths.state, '/r/processed.json');
  assert.equal(config.paths.tokensDir, '/r/tokens');
  assert.equal(config.paths.tmpDir, '/r/tmp');
});

test('assertConfig lista as variáveis faltando', () => {
  const env = { ...fullEnv };
  delete env.TIKTOK_CLIENT_SECRET;
  env.TELEGRAM_CHAT_ID = '';
  const config = loadConfig({ env, rootDir: '/r' });
  assert.throws(
    () => assertConfig(config, ['tiktok', 'telegram']),
    (err) => {
      assert.ok(err instanceof ConfigError);
      assert.deepEqual(err.missing, ['TIKTOK_CLIENT_SECRET', 'TELEGRAM_CHAT_ID']);
      return true;
    },
  );
});

test('telegramChat exige só o token', () => {
  const env = { ...fullEnv };
  delete env.TELEGRAM_CHAT_ID;
  const config = loadConfig({ env, rootDir: '/r' });
  assert.doesNotThrow(() => assertConfig(config, ['telegramChat']));
  assert.throws(() => assertConfig(config, ['telegram']), ConfigError);
});
