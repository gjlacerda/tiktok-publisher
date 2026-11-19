import { ConfigError } from './errors.js';

const TIKTOK_PORT = 3455;
const GOOGLE_PORT = 3456;

// Variável de ambiente exigida por cada campo da config, por grupo.
const GROUPS = {
  tiktok: [
    ['TIKTOK_CLIENT_KEY', (c) => c.tiktok.clientKey],
    ['TIKTOK_CLIENT_SECRET', (c) => c.tiktok.clientSecret],
  ],
  google: [
    ['GOOGLE_CLIENT_ID', (c) => c.google.clientId],
    ['GOOGLE_CLIENT_SECRET', (c) => c.google.clientSecret],
  ],
  drive: [['DRIVE_ROOT_FOLDER_ID', (c) => c.driveRootFolderId]],
  telegramChat: [['TELEGRAM_BOT_TOKEN', (c) => c.telegram.botToken]],
  telegram: [
    ['TELEGRAM_BOT_TOKEN', (c) => c.telegram.botToken],
    ['TELEGRAM_CHAT_ID', (c) => c.telegram.chatId],
  ],
};

export function loadConfig({ env, rootDir }) {
  return {
    tiktok: {
      clientKey: env.TIKTOK_CLIENT_KEY,
      clientSecret: env.TIKTOK_CLIENT_SECRET,
      redirectUri: `http://localhost:${TIKTOK_PORT}/callback/`,
      port: TIKTOK_PORT,
    },
    google: {
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      port: GOOGLE_PORT,
    },
    driveRootFolderId: env.DRIVE_ROOT_FOLDER_ID,
    telegram: {
      botToken: env.TELEGRAM_BOT_TOKEN,
      chatId: env.TELEGRAM_CHAT_ID,
    },
    paths: {
      state: `${rootDir}/processed.json`,
      tokensDir: `${rootDir}/tokens`,
      tmpDir: `${rootDir}/tmp`,
    },
  };
}

export function assertConfig(config, groups) {
  const missing = [];
  for (const group of groups) {
    for (const [name, read] of GROUPS[group]) {
      if (!read(config) && !missing.includes(name)) missing.push(name);
    }
  }
  if (missing.length > 0) throw new ConfigError(missing);
}
