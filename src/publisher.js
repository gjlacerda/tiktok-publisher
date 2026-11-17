import fs from 'node:fs/promises';
import path from 'node:path';
import { AuthError, LimitReachedError } from './errors.js';
import { loadState, saveState } from './state.js';
import { buildQueue } from './drive/discover.js';
import { LIMIT_MESSAGE, formatUnconfirmedMessage, formatVideoMessage } from './telegram.js';

const SENT_STATUSES = new Set(['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE']);

const refOf = (entry) => `${entry.day}/${entry.slot}`;
const reasonOf = (err) => (err instanceof Error ? err.message : String(err));

export async function runPublisher({
  drive,
  tiktok,
  telegram,
  rootFolderId,
  statePath,
  tmpDir,
  log = () => {},
  dryRun = false,
  waitOptions,
  now = () => new Date(),
}) {
  const summary = {
    sent: [],
    failed: [],
    unconfirmed: [],
    skipped: 0,
    warnings: [],
    limitReached: false,
    planned: [],
  };
  const state = await loadState(statePath);
  const persist = () => saveState(statePath, state);

  // Telegram nunca derruba a execução: falha vira aviso (AuthError sempre propaga).
  async function trySend(text, what) {
    try {
      await telegram.send(text);
      return true;
    } catch (err) {
      if (err instanceof AuthError) throw err;
      summary.warnings.push(`Falha ao enviar ${what} no Telegram: ${reasonOf(err)}`);
      return false;
    }
  }

  async function notifyUnconfirmed(entry) {
    await trySend(formatUnconfirmedMessage({ day: entry.day, slot: entry.slot }), `o aviso de ${refOf(entry)}`);
  }

  // Envia as hashtags de um vídeo já confirmado; só marca telegramSent depois do envio.
  async function deliverHashtags(id) {
    const entry = state[id];
    let hashtagsText = '';
    if (entry.hashtagsFile) {
      try {
        hashtagsText = await drive.readText(entry.hashtagsFile);
      } catch (err) {
        if (err instanceof AuthError) throw err;
        summary.warnings.push(`Não foi possível ler as hashtags de ${refOf(entry)}: ${reasonOf(err)}`);
        return;
      }
    }
    const message = formatVideoMessage({ day: entry.day, slot: entry.slot, hashtagsText });
    if (await trySend(message, `as hashtags de ${refOf(entry)}`)) {
      state[id] = { ...state[id], telegramSent: true };
      await persist();
    }
  }

  async function reconcileUnconfirmed() {
    for (const id of Object.keys(state)) {
      const entry = state[id];
      if (entry.status !== 'unconfirmed') continue;
      const ref = refOf(entry);
      log(`Conferindo ${ref} no TikTok…`);
      let result = null;
      try {
        result = await tiktok.fetchStatus(entry.publishId);
      } catch (err) {
        if (err instanceof AuthError) throw err;
      }
      if (SENT_STATUSES.has(result?.status)) {
        state[id] = { ...entry, status: 'sent', uploadedAt: now().toISOString() };
        await persist();
        summary.sent.push(ref);
      } else if (result?.status === 'FAILED') {
        delete state[id];
        await persist();
      } else {
        summary.unconfirmed.push(ref);
        await notifyUnconfirmed(entry);
      }
    }
  }

  async function uploadOne({ day, slot, video, hashtags }) {
    const ref = `${day}/${slot}`;
    const tmpFile = path.join(tmpDir, video.id);
    try {
      let initialized = false;
      try {
        log(`Enviando ${ref}…`);
        await drive.downloadToFile(video, tmpFile);
        const { publishId, uploadUrl, plan } = await tiktok.initInboxUpload(video.size);
        initialized = true;
        state[video.id] = {
          day,
          slot,
          fileName: video.name,
          hashtagsFile: hashtags ? { id: hashtags.id, mimeType: hashtags.mimeType } : null,
          status: 'unconfirmed',
          publishId,
          initAt: now().toISOString(),
          uploadedAt: null,
          telegramSent: false,
        };
        await persist();

        await tiktok.uploadChunks({ uploadUrl, filePath: tmpFile, mimeType: video.mimeType, plan });
        const outcome = await tiktok.waitForInbox(publishId, waitOptions);

        if (outcome.outcome === 'sent') {
          state[video.id] = { ...state[video.id], status: 'sent', uploadedAt: now().toISOString() };
          await persist();
          summary.sent.push(ref);
          await deliverHashtags(video.id);
        } else if (outcome.outcome === 'failed') {
          delete state[video.id];
          await persist();
          const why = outcome.failReason ? ` (${outcome.failReason})` : '';
          summary.failed.push({ ref, message: `O TikTok recusou o vídeo${why}` });
        } else {
          summary.unconfirmed.push(ref);
          await notifyUnconfirmed(state[video.id]);
        }
      } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err instanceof LimitReachedError) {
          summary.limitReached = true;
          await trySend(LIMIT_MESSAGE, 'o aviso de limite');
          return false;
        }
        // Depois do init a entrada continua unconfirmed; a reconciliação decide na próxima execução.
        summary.failed.push({ ref, message: initialized ? `${reasonOf(err)} (resultado incerto: entrada mantida como unconfirmed)` : reasonOf(err) });
      }
      return true;
    } finally {
      await fs.rm(tmpFile, { force: true });
    }
  }

  if (!dryRun) {
    await reconcileUnconfirmed();
    for (const id of Object.keys(state)) {
      if (state[id].status === 'sent' && state[id].telegramSent === false) await deliverHashtags(id);
    }
  }

  const tree = await drive.scanTree(rootFolderId);
  const { items, warnings } = buildQueue(tree);
  summary.warnings.push(...warnings);
  const pending = items.filter((item) => !state[item.video.id]);
  summary.skipped = items.length - pending.length;

  if (dryRun) {
    const existing = Object.values(state)
      .filter((entry) => entry.status === 'unconfirmed')
      .map(refOf);
    summary.planned = [...existing, ...pending.map((item) => `${item.day}/${item.slot}`)];
    return summary;
  }

  await fs.mkdir(tmpDir, { recursive: true });
  for (const item of pending) {
    if (!(await uploadOne(item))) break;
  }
  return summary;
}
