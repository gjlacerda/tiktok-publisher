import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanHashtags,
  escapeHtml,
  formatVideoMessage,
  formatUnconfirmedMessage,
  LIMIT_MESSAGE,
  createTelegram,
  findChatIds,
} from '../src/telegram.js';
import { TelegramError } from '../src/errors.js';

function fakeFetch(responder) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const { status = 200, body } = responder(url, init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  };
  fn.calls = calls;
  return fn;
}

test('cleanHashtags e escapeHtml', () => {
  assert.equal(cleanHashtags('﻿  #a #b \r\n'), '#a #b');
  assert.equal(escapeHtml('a & <b> c'), 'a &amp; &lt;b&gt; c');
});

test('formatVideoMessage com hashtags', () => {
  assert.equal(
    formatVideoMessage({ day: '17-11-2026', slot: '01', hashtagsText: '#pet #dog' }),
    '📅 17-11-2026 · vídeo 01\n<code>#pet #dog</code>',
  );
});

test('formatVideoMessage limpa BOM, quebra de linha e escapa HTML', () => {
  const msg = formatVideoMessage({ day: '17-11-2026', slot: '01', hashtagsText: '﻿#a & <b>\n' });
  assert.ok(msg.includes('<code>#a &amp; &lt;b&gt;</code>'));
});

test('formatVideoMessage sem hashtags', () => {
  for (const hashtagsText of [null, '  \n']) {
    const msg = formatVideoMessage({ day: '17-11-2026', slot: '01', hashtagsText });
    assert.ok(msg.endsWith('(sem hashtags)'));
    assert.equal(msg, '📅 17-11-2026 · vídeo 01\n(sem hashtags)');
  }
});

test('mensagens fixas de limite e não confirmado', () => {
  assert.equal(
    LIMIT_MESSAGE,
    '⚠️ Limite de rascunhos do TikTok atingido. Publique os rascunhos pendentes ou rode de novo em 24h.',
  );
  assert.equal(
    formatUnconfirmedMessage({ day: '17-11-2026', slot: '02' }),
    '❓ 17-11-2026 · vídeo 02: o TikTok não confirmou o envio. Confira os rascunhos e rode "node index.js resolve 17-11-2026/02 sent" (chegou) ou "retry" (reenviar).',
  );
});

test('send usa parse_mode HTML e lança TelegramError em ok:false', async () => {
  const fetch = fakeFetch(() => ({ body: { ok: true, result: {} } }));
  const tg = createTelegram({ botToken: 'TOKEN123', chatId: '-100', fetch });
  await tg.send('<b>oi</b>');
  assert.equal(fetch.calls[0].url, 'https://api.telegram.org/botTOKEN123/sendMessage');
  assert.equal(fetch.calls[0].init.method, 'POST');
  assert.equal(fetch.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), {
    chat_id: '-100',
    text: '<b>oi</b>',
    parse_mode: 'HTML',
  });

  const bad = fakeFetch(() => ({
    status: 400,
    body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' },
  }));
  const tg2 = createTelegram({ botToken: 'TOKEN123', chatId: '-100', fetch: bad });
  await assert.rejects(
    () => tg2.send('x'),
    (err) => {
      assert.ok(err instanceof TelegramError);
      assert.ok(err.message.includes('chat not found'));
      assert.ok(!err.message.includes('TOKEN123'));
      return true;
    },
  );
});

test('send lança TelegramError quando ok:false com HTTP 200', async () => {
  const fetch = fakeFetch(() => ({ body: { ok: false, description: 'nope' } }));
  const tg = createTelegram({ botToken: 'T', chatId: '1', fetch });
  await assert.rejects(() => tg.send('x'), TelegramError);
});

test('findChatIds devolve chats únicos', async () => {
  const fetch = fakeFetch(() => ({
    body: {
      ok: true,
      result: [
        { update_id: 1, message: { chat: { id: 10, type: 'private', first_name: 'Ana', last_name: 'Silva' } } },
        { update_id: 2, message: { chat: { id: 10, type: 'private', first_name: 'Ana', last_name: 'Silva' } } },
        { update_id: 3, channel_post: { chat: { id: -100, type: 'channel', title: 'Canal' } } },
        { update_id: 4, edited_message: { chat: { id: 20, type: 'private', username: 'bob' } } },
        { update_id: 5 },
      ],
    },
  }));
  const chats = await findChatIds({ botToken: 'T', fetch });
  assert.equal(fetch.calls[0].url, 'https://api.telegram.org/botT/getUpdates');
  assert.deepEqual(chats, [
    { chatId: 10, name: 'Ana Silva' },
    { chatId: -100, name: 'Canal' },
    { chatId: 20, name: 'bob' },
  ]);
});

test('findChatIds lança TelegramError em ok:false', async () => {
  const fetch = fakeFetch(() => ({ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }));
  await assert.rejects(() => findChatIds({ botToken: 'T', fetch }), TelegramError);
});
