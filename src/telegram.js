import { TelegramError } from './errors.js';

const API_BASE = 'https://api.telegram.org';

export const LIMIT_MESSAGE =
  '⚠️ Limite de rascunhos do TikTok atingido. Publique os rascunhos pendentes ou rode de novo em 24h.';

export function cleanHashtags(raw) {
  return String(raw ?? '').replace(/﻿/g, '').trim();
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatVideoMessage({ day, slot, hashtagsText }) {
  const header = `📅 ${day} · vídeo ${slot}`;
  const cleaned = cleanHashtags(hashtagsText);
  if (!cleaned) return `${header}\n(sem hashtags)`;
  return `${header}\n<code>${escapeHtml(cleaned)}</code>`;
}

export function formatUnconfirmedMessage({ day, slot }) {
  return `❓ ${day} · vídeo ${slot}: o TikTok não confirmou o envio. Confira os rascunhos e rode "node index.js resolve ${day}/${slot} sent" (chegou) ou "retry" (reenviar).`;
}

async function callBotApi({ botToken, fetch, method, body }) {
  let res;
  try {
    res = await fetch(`${API_BASE}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch (err) {
    throw new TelegramError(`Falha de rede ao chamar o Telegram (${method}): ${err.message}`);
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // corpo não-JSON: tratado abaixo
  }

  if (!res.ok || !data || data.ok !== true) {
    const detail = data?.description ?? `HTTP ${res.status}`;
    throw new TelegramError(`Telegram ${method} falhou: ${detail}`);
  }
  return data.result;
}

export function createTelegram({ botToken, chatId, fetch = globalThis.fetch }) {
  return {
    async send(htmlText) {
      await callBotApi({
        botToken,
        fetch,
        method: 'sendMessage',
        body: { chat_id: chatId, text: htmlText, parse_mode: 'HTML' },
      });
    },
  };
}

function chatName(chat) {
  if (chat.title) return chat.title;
  const full = [chat.first_name, chat.last_name].filter(Boolean).join(' ');
  return full || chat.username || '';
}

export async function findChatIds({ botToken, fetch = globalThis.fetch }) {
  const updates = await callBotApi({ botToken, fetch, method: 'getUpdates' });
  const seen = new Map();
  for (const update of updates) {
    const chat = (update.message ?? update.edited_message ?? update.channel_post)?.chat;
    if (!chat || seen.has(chat.id)) continue;
    seen.set(chat.id, { chatId: chat.id, name: chatName(chat) });
  }
  return [...seen.values()];
}
