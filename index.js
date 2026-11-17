import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { assertConfig, loadConfig } from './src/config.js';
import { AuthError, ConfigError, LockError, ResolveError } from './src/errors.js';
import { loadState, resolveEntry, saveState } from './src/state.js';
import { createDriveClient } from './src/drive/client.js';
import { createGoogleTokenProvider, runGoogleLogin } from './src/auth/google.js';
import { createTikTokTokenProvider, runTikTokLogin } from './src/auth/tiktok.js';
import { createTikTokClient } from './src/tiktok/client.js';
import { createTelegram, findChatIds } from './src/telegram.js';
import { runPublisher } from './src/publisher.js';
import { withLock } from './src/lock.js';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const REF_RE = /^\d{2}-\d{2}-\d{4}\/\d+$/;

const USAGE = `Uso:
  node index.js                                  envia os vídeos pendentes do Drive para o TikTok
  node index.js --dry-run                        lista o que seria enviado, sem enviar nada
  node index.js auth google                      login do Google (somente leitura do Drive)
  node index.js auth tiktok                      login do TikTok
  node index.js telegram-chat-id                 mostra o chat ID do bot do Telegram
  node index.js resolve DD-MM-YYYY/NN sent|retry resolve à mão um vídeo não confirmado
  node index.js help                             mostra esta ajuda`;

try {
  process.loadEnvFile(path.join(rootDir, '.env'));
} catch (err) {
  if (err.code !== 'ENOENT') throw err;
}

const config = loadConfig({ env: process.env, rootDir });

function printList(title, lines) {
  if (lines.length === 0) return;
  console.log(`${title} (${lines.length}):`);
  for (const line of lines) console.log(`  - ${line}`);
}

function printSummary(summary) {
  console.log('\nResumo');
  console.log(`  Enviados: ${summary.sent.length}${summary.sent.length > 0 ? ` (${summary.sent.join(', ')})` : ''}`);
  console.log(`  Já enviados (pulados): ${summary.skipped}`);
  console.log(`  Erros: ${summary.failed.length}`);
  printList('Erros', summary.failed.map((f) => `${f.ref}: ${f.message}`));
  if (summary.unconfirmed.length > 0) {
    printList('Não confirmados', summary.unconfirmed);
    console.log('  Confira os rascunhos no TikTok e resolva com: node index.js resolve DD-MM-YYYY/NN sent|retry');
  }
  printList('Avisos', summary.warnings);
  if (summary.limitReached) {
    console.log('⚠️ Limite de rascunhos atingido; rode de novo depois de publicar os pendentes ou em 24h.');
  }
}

async function publish({ dryRun }) {
  assertConfig(config, dryRun ? ['google', 'drive'] : ['tiktok', 'google', 'drive', 'telegram']);
  const googleProvider = createGoogleTokenProvider(config);
  const tiktokProvider = createTikTokTokenProvider({ config, fetch: globalThis.fetch, now: Date.now });
  const run = () => runPublisher({
    drive: createDriveClient({ getAccessToken: googleProvider.getAccessToken, fetch: globalThis.fetch }),
    tiktok: createTikTokClient({
      getAccessToken: tiktokProvider.getAccessToken,
      fetch: globalThis.fetch,
      sleep,
      now: Date.now,
    }),
    telegram: createTelegram({
      botToken: config.telegram.botToken,
      chatId: config.telegram.chatId,
      fetch: globalThis.fetch,
    }),
    rootFolderId: config.driveRootFolderId,
    statePath: config.paths.state,
    tmpDir: config.paths.tmpDir,
    log: console.log,
    dryRun,
  });
  const summary = dryRun ? await run() : await withLock(`${config.paths.state}.lock`, run);

  if (dryRun) {
    if (summary.planned.length === 0) console.log('Nada para enviar.');
    else printList('Seriam enviados', summary.planned);
    printList('Avisos', summary.warnings);
    return 0;
  }
  printSummary(summary);
  return summary.failed.length > 0 ? 1 : 0;
}

async function telegramChatId() {
  assertConfig(config, ['telegramChat']);
  const chats = await findChatIds({ botToken: config.telegram.botToken, fetch: globalThis.fetch });
  if (chats.length === 0) {
    console.log('Mande uma mensagem para o bot no Telegram e rode de novo.');
    return 0;
  }
  console.log('Chats encontrados (copie o chatId para TELEGRAM_CHAT_ID no .env):');
  for (const chat of chats) console.log(`  chatId: ${chat.chatId}  ${chat.name}`);
  return 0;
}

async function resolve([ref, action]) {
  if (!REF_RE.test(ref ?? '') || !['sent', 'retry'].includes(action)) {
    console.log('Uso: node index.js resolve DD-MM-YYYY/NN sent|retry');
    return 1;
  }
  await withLock(`${config.paths.state}.lock`, async () => {
    const state = await loadState(config.paths.state);
    await saveState(config.paths.state, resolveEntry(state, ref, action));
  });
  console.log(
    action === 'sent'
      ? `${ref} marcado como enviado. A mensagem do Telegram será enviada na próxima execução.`
      : `${ref} liberado para reenvio na próxima execução.`,
  );
  return 0;
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === undefined) return publish({ dryRun: false });
  if (command === '--dry-run' && rest.length === 0) return publish({ dryRun: true });
  if (command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }
  if (command === 'auth' && rest[0] === 'google') {
    assertConfig(config, ['google']);
    await runGoogleLogin(config);
    return 0;
  }
  if (command === 'auth' && rest[0] === 'tiktok') {
    assertConfig(config, ['tiktok']);
    await runTikTokLogin(config);
    return 0;
  }
  if (command === 'telegram-chat-id') return telegramChatId();
  if (command === 'resolve') return resolve(rest);
  console.log(USAGE);
  return 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`Faltam variáveis no .env: ${err.missing.join(', ')}`);
  } else if (err instanceof AuthError || err instanceof ResolveError || err instanceof LockError || err.message?.startsWith('Arquivo de estado corrompido')) {
    console.error(err.message);
  } else {
    console.error(err.message);
    console.error(err.stack);
  }
  process.exitCode = 1;
}
