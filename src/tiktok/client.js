import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthError, LimitReachedError, TikTokApiError } from '../errors.js';
import { planChunks } from './chunks.js';

const INIT_URL = 'https://open.tiktokapis.com/v2/post/publish/inbox/video/init/';
const STATUS_URL = 'https://open.tiktokapis.com/v2/post/publish/status/fetch/';
const MIN_INIT_INTERVAL_MS = 10_000;
const RATE_LIMIT_WAIT_MS = 60_000;
const RATE_LIMIT_RETRIES = 3;
const SENT_STATUSES = new Set(['SEND_TO_USER_INBOX', 'PUBLISH_COMPLETE']);

export function createTikTokClient({
  getAccessToken,
  fetch = globalThis.fetch,
  sleep = delay,
  now = Date.now,
} = {}) {
  let lastInitAt = null;

  // Chama a API e devolve { httpStatus, body, code }. Não interpreta erros.
  async function callApi(url, payload) {
    const token = await getAccessToken();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
      },
      body: JSON.stringify(payload),
    });
    let body;
    try {
      body = await res.json();
    } catch {
      throw new TikTokApiError(`Resposta inválida do TikTok (HTTP ${res.status})`, {
        code: 'invalid_response',
        httpStatus: res.status,
      });
    }
    const code = body?.error?.code;
    return { httpStatus: res.status, body, code, message: body?.error?.message };
  }

  function throwForError({ httpStatus, code, message }) {
    if (code === 'access_token_invalid') throw new AuthError('tiktok');
    throw new TikTokApiError(message || `Erro do TikTok: ${code ?? `HTTP ${httpStatus}`}`, {
      code: code ?? 'invalid_response',
      httpStatus,
    });
  }

  async function throttleInit() {
    if (lastInitAt !== null) {
      const wait = MIN_INIT_INTERVAL_MS - (now() - lastInitAt);
      if (wait > 0) await sleep(wait);
    }
    lastInitAt = now();
  }

  async function initInboxUpload(size) {
    const plan = planChunks(size);
    const payload = {
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: size,
        chunk_size: plan.chunkSize,
        total_chunk_count: plan.totalChunkCount,
      },
    };

    for (let attempt = 0; ; attempt += 1) {
      await throttleInit();
      const result = await callApi(INIT_URL, payload);
      const { httpStatus, body, code } = result;

      if (code === 'ok' && body.data?.publish_id && body.data?.upload_url) {
        return { publishId: body.data.publish_id, uploadUrl: body.data.upload_url, plan };
      }
      if (code === 'spam_risk_too_many_pending_share') throw new LimitReachedError();
      if (code === 'rate_limit_exceeded' || httpStatus === 429) {
        if (attempt >= RATE_LIMIT_RETRIES) {
          throw new TikTokApiError('Limite de requisições do TikTok excedido', {
            code: 'rate_limit_exceeded',
            httpStatus: 429,
          });
        }
        await sleep(RATE_LIMIT_WAIT_MS);
        continue;
      }
      if (code === 'ok') {
        throw new TikTokApiError('Resposta do TikTok sem publish_id/upload_url', {
          code: 'invalid_response',
          httpStatus,
        });
      }
      throwForError(result);
    }
  }

  async function uploadChunks({ uploadUrl, filePath, mimeType, plan }) {
    const total = plan.ranges[plan.ranges.length - 1].end + 1;
    const handle = await fs.open(filePath, 'r');
    try {
      for (let i = 0; i < plan.ranges.length; i += 1) {
        const { start, end } = plan.ranges[i];
        const length = end - start + 1;
        const buffer = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(buffer, read, length - read, start + read);
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        if (read !== length) {
          throw new TikTokApiError(`Arquivo menor que o esperado ao ler ${start}-${end}`, {
            code: 'upload_failed',
          });
        }

        const res = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Type': mimeType,
            'Content-Length': String(length),
            'Content-Range': `bytes ${start}-${end}/${total}`,
          },
          body: buffer,
        });
        const expected = i === plan.ranges.length - 1 ? 201 : 206;
        if (res.status !== expected) {
          throw new TikTokApiError(
            `Falha no upload da parte ${i + 1}/${plan.ranges.length} (HTTP ${res.status})`,
            { code: 'upload_failed', httpStatus: res.status },
          );
        }
      }
    } finally {
      await handle.close();
    }
  }

  async function fetchStatus(publishId) {
    const result = await callApi(STATUS_URL, { publish_id: publishId });
    if (result.code !== 'ok') throwForError(result);
    return { status: result.body.data?.status, failReason: result.body.data?.fail_reason };
  }

  async function waitForInbox(publishId, { intervalMs = 5000, timeoutMs = 120_000 } = {}) {
    const startedAt = now();
    for (;;) {
      try {
        const { status, failReason } = await fetchStatus(publishId);
        if (SENT_STATUSES.has(status)) return { outcome: 'sent' };
        if (status === 'FAILED') return { outcome: 'failed', failReason };
      } catch (err) {
        if (err instanceof AuthError) throw err;
      }
      if (now() - startedAt >= timeoutMs) return { outcome: 'unconfirmed' };
      await sleep(intervalMs);
    }
  }

  return { initInboxUpload, uploadChunks, fetchStatus, waitForInbox };
}
