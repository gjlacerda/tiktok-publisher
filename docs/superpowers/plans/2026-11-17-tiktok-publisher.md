# TikTok Publisher — Plano de Implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** CLI em Node que envia para os rascunhos do TikTok todos os vídeos ainda não enviados de uma pasta do Google Drive e manda as hashtags de cada um pelo Telegram.

**Architecture:** Módulos pequenos com dependências injetadas (`fetch`, `sleep`, `now`, clientes) para serem testados sem rede. Um orquestrador (`src/publisher.js`) junta descoberta no Drive, upload no TikTok, Telegram e o estado em `processed.json`. O `index.js` só lê argumentos, monta as dependências reais e chama o comando.

**Tech Stack:** Node 26 LTS, JavaScript ES modules, `fetch` nativo, `google-auth-library` (único pacote de runtime), `node:test` + `node:assert/strict`.

**Spec:** `docs/superpowers/specs/2026-11-17-tiktok-publisher-design.md`

## Global Constraints

- JavaScript (não TypeScript), ES modules (`"type": "module"`), Node 26 LTS: `"engines": { "node": ">=26" }` e `.nvmrc` com `26`.
- Única dependência de runtime: `google-auth-library`. Nada de `request`, `axios`, `googleapis`, `dotenv`. `.env` carregado com `process.loadEnvFile`.
- Testes com `node --test`; nenhum teste toca a rede (sempre `fetch` falso).
- Drive só leitura: escopo `https://www.googleapis.com/auth/drive.readonly`, só requisições `GET`.
- TikTok: redirect URI `http://localhost:3455/callback/`, escopos `user.info.basic,video.upload`, PKCE com `code_challenge` = SHA256 **hex** do verifier, método `S256`.
- Repositório público: segredos só em `.env` e `tokens/`; `processed.json`, `tokens/` e `tmp/` ignorados pelo git.
- Textos para o usuário (terminal e Telegram) em português.
- Identidade de um vídeo = ID do arquivo no Drive.

## Review Focus

1. **`processed.json` corrompido** (JSON inválido): o app deve parar com erro claro, nunca tratar como vazio (isso reenviaria tudo). Teste na Task 2.
2. **Arquivo de hashtags que é Google Doc** (ou sem extensão, `application/octet-stream`): Google Docs são exportados como `text/plain`; o resto baixado com `alt=media`. Teste na Task 4.
3. **Pasta com mais de uma página de resultados no Drive**: `listChildren` segue `nextPageToken`. Teste na Task 4.
4. **Arquivos na lixeira do Drive**: a consulta inclui `trashed = false`. Teste na Task 4.
5. **Hashtags com BOM, quebra de linha no fim ou caracteres HTML (`&`, `<`)**: removidos/escapados antes do Telegram; arquivo vazio vira "(sem hashtags)". Teste na Task 8.

---

## Estrutura de arquivos

```
package.json, .nvmrc, .env.example, .gitignore
index.js                  CLI: argumentos → comando
src/config.js             lê env, valida o que cada comando precisa
src/errors.js             classes de erro compartilhadas
src/state.js              processed.json: ler, gravar atômico, resolve manual
src/drive/discover.js     lógica pura: datas, slots, fila
src/drive/client.js       REST do Drive: listar, baixar, ler texto, varrer árvore
src/auth/loopback.js      servidor local de callback + abrir navegador
src/auth/google.js        OAuth Google (login + cliente com refresh)
src/auth/tiktok.js        OAuth TikTok com PKCE (login + refresh)
src/tiktok/chunks.js      cálculo das partes do upload
src/tiktok/client.js      init, PUT das partes, status, espera da caixa de entrada
src/telegram.js           mensagens e descoberta do chat ID
src/publisher.js          orquestrador de uma execução
test/*.test.js            um arquivo por módulo
```

---

### Task 1: Base do projeto, erros e configuração

**Files:**
- Create: `package.json`, `.nvmrc`, `.env.example`, `src/errors.js`, `src/config.js`, `test/config.test.js`
- Modify: `.gitignore` (acrescentar `tokens/`, `tmp/`, `processed.json`)

**Interfaces:**
- Produces:
  - `src/errors.js`: `class ConfigError extends Error { missing: string[] }`, `class AuthError extends Error { service: 'google'|'tiktok' }` (mensagem: ``Login do ${service} inválido ou expirado. Rode: node index.js auth ${service}``), `class LimitReachedError extends Error`, `class TikTokApiError extends Error { code: string, httpStatus: number }`, `class TelegramError extends Error`.
  - `loadConfig({ env, rootDir }) -> Config`:
    ```js
    {
      tiktok:   { clientKey, clientSecret, redirectUri: 'http://localhost:3455/callback/', port: 3455 },
      google:   { clientId, clientSecret, port: 3456 },
      driveRootFolderId,
      telegram: { botToken, chatId },
      paths:    { state: `${rootDir}/processed.json`, tokensDir: `${rootDir}/tokens`, tmpDir: `${rootDir}/tmp` },
    }
    ```
    Variáveis: `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DRIVE_ROOT_FOLDER_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
  - `assertConfig(config, groups: Array<'tiktok'|'google'|'drive'|'telegram'|'telegramChat'>) -> void` — lança `ConfigError` com os **nomes das variáveis** faltando. `'telegram'` exige token e chat ID; `'telegramChat'` só o token (para o comando de descobrir o chat ID).

- [ ] **Step 1: Apagar o `node_modules` antigo** (veio de outro contexto: `request`, `tsx`, `typescript`) e criar `package.json` com `"type": "module"`, `engines`, scripts `"start": "node index.js"` e `"test": "node --test"`. Criar `.nvmrc` (`26`) e `.env.example` com as 7 variáveis vazias. Atualizar `.gitignore`. Rodar `rm -rf node_modules && npm install google-auth-library`.
- [ ] **Step 2: Escrever os testes que falham** em `test/config.test.js`:
  - `loadConfig mapeia todas as variáveis` — env completo → `config.tiktok.clientKey === 'k'`, `config.paths.state === '/r/processed.json'` com `rootDir: '/r'`.
  - `assertConfig lista as variáveis faltando` — env sem `TIKTOK_CLIENT_SECRET` e `TELEGRAM_CHAT_ID`; `assertConfig(c, ['tiktok','telegram'])` lança `ConfigError` com `missing` deepEqual `['TIKTOK_CLIENT_SECRET','TELEGRAM_CHAT_ID']`.
  - `telegramChat exige só o token` — sem `TELEGRAM_CHAT_ID`, `assertConfig(c, ['telegramChat'])` não lança.
- [ ] **Step 3: Rodar** `node --test test/config.test.js` → FAIL (módulo inexistente).
- [ ] **Step 4: Implementar** `src/errors.js` e `src/config.js` conforme Interfaces. String vazia conta como faltando.
- [ ] **Step 5: Rodar** `node --test test/config.test.js` → PASS.
- [ ] **Step 6: Commit** — `git add package.json package-lock.json .nvmrc .env.example .gitignore src test && git commit -m "feat: project scaffold and config"`

---

### Task 2: Estado (`processed.json`)

**Files:**
- Create: `src/state.js`, `test/state.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - Tipo `Entry`:
    ```js
    { day: 'DD-MM-YYYY', slot: '01', fileName, hashtagsFile: { id, mimeType } | null,
      status: 'unconfirmed' | 'sent', publishId, initAt: ISO, uploadedAt: ISO | null, telegramSent: boolean }
    ```
  - `State` = `{ [driveVideoId: string]: Entry }`.
  - `loadState(path) -> Promise<State>` — arquivo inexistente → `{}`; JSON inválido → lança `Error` com mensagem contendo o caminho e `"corrompido"`.
  - `saveState(path, state) -> Promise<void>` — escreve `${path}.tmp` e faz `rename` (atômico), JSON com 2 espaços.
  - `resolveEntry(state, ref: 'DD-MM-YYYY/NN', action: 'sent'|'retry') -> State` — devolve cópia. `sent` → `status: 'sent'`, `uploadedAt` = agora se nulo, `telegramSent: false` (a próxima execução manda as hashtags). `retry` → remove a entrada. Ref inexistente → lança `Error` com ``Nenhum vídeo registrado como ${ref}``.

- [ ] **Step 1: Escrever os testes que falham** (usar `fs.mkdtemp` em `os.tmpdir()`):
  - `loadState sem arquivo devolve {}`.
  - `saveState e loadState fazem ida e volta` — e `${path}.tmp` não existe depois.
  - `loadState com JSON inválido lança erro e não devolve {}` — `assert.rejects(..., /corrompido/)`.
  - `resolveEntry sent marca enviado e deixa Telegram pendente`.
  - `resolveEntry retry remove a entrada`.
  - `resolveEntry com ref desconhecida lança erro`.
- [ ] **Step 2: Rodar** `node --test test/state.test.js` → FAIL.
- [ ] **Step 3: Implementar** `src/state.js`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat: processed.json state store`

---

### Task 3: Descoberta no Drive (lógica pura)

**Files:**
- Create: `src/drive/discover.js`, `test/discover.test.js`

**Interfaces:**
- Produces:
  - `DriveFile` = `{ id, name, mimeType, size?: number }`.
  - `DayTree` = `Array<{ id, name, slots: Array<{ id, name, files: DriveFile[] }> }>` (montado pela Task 4).
  - `QueueItem` = `{ day: string, slot: string, video: DriveFile, hashtags: DriveFile | null }`.
  - `parseDayName(name) -> Date | null` — só `^\d{2}-\d{2}-\d{4}$` e data real (`31-02-2026` → `null`). Data em UTC.
  - `isHashtagsFile(name) -> boolean` — `/^hashtags?(\.txt)?$/i`.
  - `buildQueue(tree: DayTree) -> { items: QueueItem[], warnings: string[] }` — dias ordenados por data real, slots por valor numérico (slot só `^\d+$`). Avisos (em português) para: nome de dia inválido, nome de slot inválido, slot com 0 vídeos, slot com mais de 1 vídeo (esses slots ficam fora da fila). Vídeo = `mimeType` começando com `video/`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `parseDayName aceita DD-MM-YYYY válido e rejeita o resto` — `'17-11-2026'` → Date; `'2026-11-17'`, `'31-02-2026'`, `'dia 1'` → `null`.
  - `isHashtagsFile` — `true` para `hashtags`, `Hashtags.txt`, `hashtag.txt`; `false` para `hashtags.doc`, `tags`.
  - `buildQueue ordena por data real entre meses e anos` — dias `['18-11-2026','05-01-2027','17-11-2026','01-12-2026']` → ordem `['17-11-2026','18-11-2026','01-12-2026','05-01-2027']`.
  - `buildQueue ordena slots numericamente` — `['10','02','01']` → `['01','02','10']`.
  - `buildQueue pareia vídeo e hashtags e aceita falta de hashtags` — slot só com vídeo → `hashtags: null`, sem aviso.
  - `buildQueue pula e avisa slot sem vídeo ou com dois vídeos` — `warnings.length === 2`, itens fora da fila.
  - `buildQueue ignora e avisa pasta de dia com nome inválido`.
- [ ] **Step 2: Rodar** `node --test test/discover.test.js` → FAIL.
- [ ] **Step 3: Implementar** `src/drive/discover.js`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat: drive folder discovery and ordering`

---

### Task 4: Cliente REST do Drive

**Files:**
- Create: `src/drive/client.js`, `test/drive-client.test.js`

**Interfaces:**
- Consumes: `DriveFile`, `DayTree` (Task 3).
- Produces: `createDriveClient({ getAccessToken: () => Promise<string>, fetch }) ->`
  - `listChildren(folderId) -> Promise<DriveFile[]>` — `GET https://www.googleapis.com/drive/v3/files` com `q = '<folderId>' in parents and trashed = false`, `fields = nextPageToken, files(id, name, mimeType, size)`, `pageSize = 1000`, `supportsAllDrives = true`, `includeItemsFromAllDrives = true`; segue `nextPageToken`; `size` convertido para número.
  - `downloadToFile(file, destPath) -> Promise<void>` — `GET /drive/v3/files/{id}?alt=media`, grava por stream (`stream.pipeline` + `Readable.fromWeb`).
  - `readText(file) -> Promise<string>` — se `mimeType === 'application/vnd.google-apps.document'` usa `GET /drive/v3/files/{id}/export?mimeType=text/plain`; senão `alt=media`. Devolve texto bruto.
  - `scanTree(rootId) -> Promise<DayTree>` — filhos da raiz que são pasta (`application/vnd.google-apps.folder`) → dias; filhos pasta de cada dia → slots; arquivos de cada slot → `files`.
  - Toda requisição leva `Authorization: Bearer <token>`. Resposta não-2xx → `Error` com status e corpo. 401 → `AuthError('google')`.

- [ ] **Step 1: Escrever os testes que falham** (fake `fetch` que grava as URLs e responde por roteiro):
  - `listChildren segue nextPageToken` — duas páginas → 3 arquivos no total, 2 chamadas.
  - `listChildren exclui a lixeira` — a URL decodificada contém `trashed = false` e `'<id>' in parents`.
  - `readText exporta Google Docs como texto` — URL contém `/export?mimeType=text%2Fplain`.
  - `readText baixa arquivo comum com alt=media` — para `mimeType: 'application/octet-stream'`.
  - `scanTree monta dias e slots` — raiz com 1 dia e um arquivo solto (ignorado), dia com 1 slot, slot com 2 arquivos.
  - `401 vira AuthError google`.
- [ ] **Step 2: Rodar** `node --test test/drive-client.test.js` → FAIL.
- [ ] **Step 3: Implementar** `src/drive/client.js`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat: google drive REST client`

---

### Task 5: Callback local e login do Google

**Files:**
- Create: `src/auth/loopback.js`, `src/auth/google.js`, `test/loopback.test.js`

**Interfaces:**
- Consumes: `AuthError` (Task 1), `config.google`, `config.paths.tokensDir`.
- Produces:
  - `waitForCallback({ port, path, expectedState, timeoutMs = 300000 }) -> Promise<{ code: string }>` — sobe `http.createServer` em `127.0.0.1:port`; na requisição para `path`, valida `state`, responde HTML "Login concluído, pode fechar esta aba." e fecha o servidor. Rejeita com `error` na query, `state` diferente ou timeout. Requisições em outros caminhos → 404 sem encerrar.
  - `openBrowser(url) -> void` — `execFile('open', [url])` (macOS) e também imprime a URL no terminal.
  - `runGoogleLogin(config) -> Promise<void>` — `OAuth2Client` com `redirect_uri = http://127.0.0.1:3456`; `generateAuthUrl({ access_type: 'offline', prompt: 'consent select_account', scope: [drive.readonly], state })`; espera callback em `path: '/'`; `getToken`; grava em `tokens/google.json` (cria a pasta).
  - `createGoogleTokenProvider(config) -> { getAccessToken: () => Promise<string> }` — carrega `tokens/google.json` (inexistente → `AuthError('google')`), `setCredentials`, regrava o arquivo no evento `tokens` preservando o `refresh_token` antigo se o novo não vier; erro `invalid_grant` → `AuthError('google')`.

- [ ] **Step 1: Escrever os testes que falham** (`test/loopback.test.js`, usar uma porta livre de teste):
  - `waitForCallback devolve o code com state correto` — `fetch('http://127.0.0.1:<p>/cb?code=abc&state=s')` → `{ code: 'abc' }`.
  - `waitForCallback rejeita state diferente`.
  - `waitForCallback rejeita quando vem error` — `?error=access_denied&state=s`.
  - `waitForCallback rejeita no timeout` — `timeoutMs: 50`.
- [ ] **Step 2: Rodar** `node --test test/loopback.test.js` → FAIL.
- [ ] **Step 3: Implementar** `src/auth/loopback.js` e `src/auth/google.js` (o Google é verificado manualmente na Task 10).
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat: loopback callback and google oauth`

---

### Task 6: Login e tokens do TikTok

**Files:**
- Create: `src/auth/tiktok.js`, `test/tiktok-auth.test.js`

**Interfaces:**
- Consumes: `waitForCallback`, `openBrowser` (Task 5), `AuthError` (Task 1), `config.tiktok`.
- Produces:
  - `TokenSet` = `{ accessToken, refreshToken, openId, scope, accessExpiresAt: number(ms), refreshExpiresAt: number(ms) }`.
  - `createPkcePair() -> { verifier, challenge }` — verifier de 64 caracteres do conjunto `[A-Za-z0-9-._~]`; challenge = `createHash('sha256').update(verifier).digest('hex')`.
  - `buildAuthorizeUrl({ clientKey, redirectUri, state, challenge }) -> string` — `https://www.tiktok.com/v2/auth/authorize/` com `client_key`, `scope=user.info.basic,video.upload`, `response_type=code`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`.
  - `exchangeCode({ config, code, verifier, fetch, now }) -> Promise<TokenSet>` — `POST https://open.tiktokapis.com/v2/oauth/token/`, `application/x-www-form-urlencoded`: `client_key`, `client_secret`, `code`, `grant_type=authorization_code`, `redirect_uri`, `code_verifier`.
  - `refreshTokens({ config, tokens, fetch, now }) -> Promise<TokenSet>` — mesmo endpoint: `client_key`, `client_secret`, `grant_type=refresh_token`, `refresh_token`. Guarda o **novo** refresh token (rotaciona).
  - Resposta com campo `error` ou HTTP não-2xx → `AuthError('tiktok')`.
  - `createTikTokTokenProvider({ config, fetch, now }) -> { getAccessToken: () => Promise<string> }` — lê `tokens/tiktok.json` (inexistente → `AuthError('tiktok')`); refresh expirado → `AuthError('tiktok')`; se faltam menos de 5 min para o access token expirar, faz refresh e grava o arquivo antes de devolver.
  - `runTikTokLogin(config) -> Promise<void>` — PKCE + state aleatório, abre o navegador, `waitForCallback({ port: 3455, path: '/callback/' })`, troca o code e grava `tokens/tiktok.json`.

- [ ] **Step 1: Escrever os testes que falham:**
  - `createPkcePair gera verifier válido e challenge hex` — `verifier.length === 64`, `/^[A-Za-z0-9\-._~]+$/`; `challenge === sha256hex(verifier)` e `/^[0-9a-f]{64}$/`.
  - `buildAuthorizeUrl inclui escopos e PKCE` — params `scope === 'user.info.basic,video.upload'`, `code_challenge_method === 'S256'`, `redirect_uri === 'http://localhost:3455/callback/'`.
  - `exchangeCode envia code_verifier e calcula expirações` — corpo do form tem `code_verifier`; com `now = () => 1000` e `expires_in: 7200` → `accessExpiresAt === 1000 + 7200000`.
  - `refreshTokens guarda o novo refresh token`.
  - `resposta com error vira AuthError tiktok`.
  - `token provider renova quando faltam menos de 5 minutos e grava o arquivo` (usar `tokensDir` temporário).
  - `token provider lança AuthError se o refresh token expirou`.
- [ ] **Step 2: Rodar** `node --test test/tiktok-auth.test.js` → FAIL.
- [ ] **Step 3: Implementar** `src/auth/tiktok.js`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat: tiktok oauth with pkce`

---

### Task 7: Upload no TikTok

**Files:**
- Create: `src/tiktok/chunks.js`, `src/tiktok/client.js`, `test/chunks.test.js`, `test/tiktok-client.test.js`

**Interfaces:**
- Consumes: `LimitReachedError`, `AuthError`, `TikTokApiError` (Task 1).
- Produces:
  - `CHUNK_SIZE = 10_000_000`.
  - `planChunks(size) -> { chunkSize, totalChunkCount, ranges: Array<{ start, end }> }` — `size <= CHUNK_SIZE` → uma parte com `chunkSize = size`; senão `chunkSize = CHUNK_SIZE`, `totalChunkCount = Math.floor(size / CHUNK_SIZE)`, a última parte absorve o resto. `end` é inclusivo.
  - `createTikTokClient({ getAccessToken, fetch, sleep, now }) ->`
    - `initInboxUpload(size) -> Promise<{ publishId, uploadUrl, plan }>` — `POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/`, JSON `{ source_info: { source: 'FILE_UPLOAD', video_size, chunk_size, total_chunk_count } }`. Intervalo mínimo de 10 000 ms entre inits (limite de 6/min). Mapeamento de `error.code`: `spam_risk_too_many_pending_share` → `LimitReachedError`; `rate_limit_exceeded` → `sleep(60000)` e tenta de novo, até 3 vezes; `access_token_invalid` → `AuthError('tiktok')`; outro diferente de `ok` → `TikTokApiError`.
    - `uploadChunks({ uploadUrl, filePath, mimeType, plan }) -> Promise<void>` — `PUT` sequencial com `Content-Type: mimeType`, `Content-Length`, `Content-Range: bytes {start}-{end}/{total}`; espera 206 nas intermediárias e 201 na última; outro status → `TikTokApiError('upload_failed')`. Lê cada parte com `fs.open` + `read` num `Buffer`.
    - `fetchStatus(publishId) -> Promise<{ status, failReason }>` — `POST https://open.tiktokapis.com/v2/post/publish/status/fetch/` com `{ publish_id }`.
    - `waitForInbox(publishId, { intervalMs = 5000, timeoutMs = 120000 }) -> Promise<{ outcome: 'sent'|'failed'|'unconfirmed', failReason? }>` — `SEND_TO_USER_INBOX` ou `PUBLISH_COMPLETE` → `sent`; `FAILED` → `failed`; ainda processando ao fim do tempo → `unconfirmed`. Erros não-auth durante a espera não interrompem; `AuthError` propaga.

- [ ] **Step 1: Escrever os testes que falham:**
  - `planChunks arquivo pequeno vai inteiro` — `4_000_000` → `{ chunkSize: 4_000_000, totalChunkCount: 1 }`, range `0-3999999`.
  - `planChunks arquivo de 18,2 MB` — `18_200_000` → `chunkSize: 10_000_000`, `totalChunkCount: 1`, range `0-18199999`.
  - `planChunks segue o exemplo da documentação` — `50_000_123` → 5 partes, última `{ start: 40_000_000, end: 50_000_122 }`.
  - `initInboxUpload envia source_info correto`.
  - `initInboxUpload mapeia o limite de pendentes` — resposta 403 com `error.code: 'spam_risk_too_many_pending_share'` → `LimitReachedError`.
  - `initInboxUpload espera e repete no rate limit` — 1ª resposta 429, 2ª ok → `sleep` chamado com `60000`.
  - `initInboxUpload respeita 10 s entre inits` — duas chamadas com `now` fixo → `sleep(10000)` antes da segunda.
  - `uploadChunks envia Content-Range de cada parte` — arquivo temporário de 25 bytes com `plan` de 2 partes; cabeçalhos `bytes 0-9/25` e `bytes 10-24/25`; respostas 206 e 201.
  - `uploadChunks falha se a última parte não devolver 201`.
  - `waitForInbox mapeia SEND_TO_USER_INBOX, FAILED e timeout` — três casos.
- [ ] **Step 2: Rodar** `node --test test/chunks.test.js test/tiktok-client.test.js` → FAIL.
- [ ] **Step 3: Implementar** `src/tiktok/chunks.js` e `src/tiktok/client.js`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat: tiktok inbox upload client`

---

### Task 8: Telegram

**Files:**
- Create: `src/telegram.js`, `test/telegram.test.js`

**Interfaces:**
- Consumes: `TelegramError` (Task 1).
- Produces:
  - `cleanHashtags(raw: string) -> string` — remove BOM (`﻿`) e espaços/quebras nas pontas.
  - `escapeHtml(s) -> string` — `&`, `<`, `>`.
  - `formatVideoMessage({ day, slot, hashtagsText }) -> string` — texto exato:
    - com hashtags: ``📅 ${day} · vídeo ${slot}\n<code>${escapeHtml(cleanHashtags(hashtagsText))}</code>``
    - `hashtagsText` nulo ou vazio depois de limpar: ``📅 ${day} · vídeo ${slot}\n(sem hashtags)``
  - `LIMIT_MESSAGE = '⚠️ Limite de rascunhos do TikTok atingido. Publique os rascunhos pendentes ou rode de novo em 24h.'`
  - `formatUnconfirmedMessage({ day, slot }) -> string` — ``❓ ${day} · vídeo ${slot}: o TikTok não confirmou o envio. Confira os rascunhos e rode "node index.js resolve ${day}/${slot} sent" (chegou) ou "retry" (reenviar).``
  - `createTelegram({ botToken, chatId, fetch }) -> { send(htmlText) -> Promise<void> }` — `POST https://api.telegram.org/bot<token>/sendMessage` com `{ chat_id, text, parse_mode: 'HTML' }`; `ok: false` ou não-2xx → `TelegramError`.
  - `findChatIds({ botToken, fetch }) -> Promise<Array<{ chatId, name }>>` — `getUpdates`, chats únicos das mensagens recebidas.

- [ ] **Step 1: Escrever os testes que falham:**
  - `formatVideoMessage com hashtags` — `'#pet #dog'` → `'📅 17-11-2026 · vídeo 01\n<code>#pet #dog</code>'`.
  - `formatVideoMessage limpa BOM, quebra de linha e escapa HTML` — `'﻿#a & <b>\n'` → contém `<code>#a &amp; &lt;b&gt;</code>`.
  - `formatVideoMessage sem hashtags` — `null` e `'  \n'` → termina com `'(sem hashtags)'`.
  - `send usa parse_mode HTML e lança TelegramError em ok:false`.
  - `findChatIds devolve chats únicos`.
- [ ] **Step 2: Rodar** `node --test test/telegram.test.js` → FAIL.
- [ ] **Step 3: Implementar** `src/telegram.js`.
- [ ] **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** — `feat: telegram notifications`

---

### Task 9: Orquestrador de uma execução

**Files:**
- Create: `src/publisher.js`, `test/publisher.test.js`

**Interfaces:**
- Consumes: `loadState`, `saveState` (Task 2); `buildQueue` (Task 3); cliente do Drive (Task 4: `scanTree`, `downloadToFile`, `readText`); cliente do TikTok (Task 7: `initInboxUpload`, `uploadChunks`, `fetchStatus`, `waitForInbox`); Telegram (Task 8: `send`, `formatVideoMessage`, `formatUnconfirmedMessage`, `LIMIT_MESSAGE`); erros (Task 1).
- Produces: `runPublisher({ drive, tiktok, telegram, rootFolderId, statePath, tmpDir, log, dryRun = false, waitOptions }) -> Promise<Summary>`
  - `Summary` = `{ sent: string[], failed: Array<{ ref, message }>, unconfirmed: string[], skipped: number, warnings: string[], limitReached: boolean, planned: string[] }` — `ref` = `'DD-MM-YYYY/NN'`.
  - Ordem (cada mudança de estado é gravada na hora com `saveState`):
    1. Carrega o estado.
    2. **Reconcilia `unconfirmed`:** `fetchStatus(publishId)` → `SEND_TO_USER_INBOX`/`PUBLISH_COMPLETE`: `status: 'sent'`, `uploadedAt`; `FAILED`: remove a entrada (volta para a fila nesta mesma execução); outro ou erro não-auth: continua `unconfirmed`, entra em `summary.unconfirmed` e manda `formatUnconfirmedMessage`.
    3. **Telegram pendente:** para `status: 'sent'` com `telegramSent: false`, lê as hashtags (`readText(hashtagsFile)` se houver), envia e marca `telegramSent: true`. Falha no Telegram só vira aviso.
    4. `scanTree` + `buildQueue`; avisos vão para `summary.warnings`; itens cujo `video.id` já está no estado contam em `skipped`.
    5. Para cada item pendente: `downloadToFile` em `tmpDir/<videoId>` → `initInboxUpload(video.size)` → **grava `unconfirmed` com `publishId`** → `uploadChunks` → `waitForInbox`:
       - `sent`: `status: 'sent'`, `uploadedAt`, grava; lê as hashtags, `send(formatVideoMessage)`, `telegramSent: true`, grava.
       - `failed`: remove a entrada, grava, entra em `failed`.
       - `unconfirmed`: mantém, entra em `unconfirmed`, manda `formatUnconfirmedMessage`.
       - Erro antes do init: entra em `failed`, sem entrada no estado. Erro depois do init (no `uploadChunks`): a entrada continua `unconfirmed` (a reconciliação decide depois).
       - O arquivo temporário é apagado num `finally`.
    6. `LimitReachedError`: `send(LIMIT_MESSAGE)`, `limitReached: true`, para o laço. `AuthError`: propaga (encerra a execução).
  - `dryRun: true`: só passos 1 e 4; preenche `planned` com as refs pendentes e os `unconfirmed` existentes; não baixa, não chama o TikTok nem o Telegram e não grava estado.

- [ ] **Step 1: Escrever os testes que falham** (fakes em memória para drive/tiktok/telegram, `statePath` em pasta temporária):
  - `envia vídeos pendentes em ordem e grava sent` — árvore com `18-11-2026/01` e `17-11-2026/01` → `sent` na ordem `['17-11-2026/01','18-11-2026/01']`; estado com `telegramSent: true`; 2 mensagens.
  - `pula vídeos já enviados` — estado com o ID → `skipped === 1`, nenhum init.
  - `grava unconfirmed antes de subir as partes` — o fake de `uploadChunks` lê o estado do disco e vê `status: 'unconfirmed'` com `publishId`.
  - `FAILED remove a entrada para tentar de novo`.
  - `resultado incerto fica unconfirmed e avisa no Telegram`.
  - `reconciliação confirma unconfirmed sem reenviar` — estado com `unconfirmed`, `fetchStatus` → `SEND_TO_USER_INBOX` → vira `sent`, nenhum init para esse vídeo.
  - `reconciliação com FAILED reenvia na mesma execução`.
  - `limite de pendentes para o laço e avisa` — init do 2º vídeo lança `LimitReachedError` → `limitReached: true`, 3º vídeo não tentado, `LIMIT_MESSAGE` enviada, 2º vídeo sem entrada.
  - `falha no Telegram mantém o vídeo enviado e reenvia a mensagem na próxima execução` — 1ª execução: `send` lança → `telegramSent: false`; 2ª execução: mensagem enviada, nenhum init.
  - `AuthError interrompe a execução` — `assert.rejects(..., AuthError)`.
  - `dry-run não altera nada` — `planned` com as refs; estado em disco inalterado; nenhum init nem `send`.
  - `apaga o arquivo temporário mesmo com erro no upload`.
- [ ] **Step 2: Rodar** `node --test test/publisher.test.js` → FAIL.
- [ ] **Step 3: Implementar** `src/publisher.js`.
- [ ] **Step 4: Rodar** `node --test` (suite inteira) → PASS.
- [ ] **Step 5: Commit** — `feat: publisher orchestration`

---

### Task 10: CLI e verificação real

**Files:**
- Modify: `index.js`
- Create: `README.md` (configuração e uso, em português)

**Interfaces:**
- Consumes: tudo acima.
- Produces — comandos:
  - `node index.js` — `assertConfig(['tiktok','google','drive','telegram'])`, monta clientes reais (`globalThis.fetch`, `sleep` com `setTimeout` de `node:timers/promises`, `Date.now`), roda `runPublisher`, imprime o resumo (enviados, pulados, erros com ref e mensagem, não confirmados, avisos, linha de limite atingido). Código de saída 1 se houver `failed` ou erro.
  - `node index.js --dry-run` — lista o que seria enviado.
  - `node index.js auth tiktok` / `node index.js auth google`.
  - `node index.js telegram-chat-id` — `assertConfig(['telegramChat'])`, imprime os chats encontrados ou "Mande uma mensagem para o bot no Telegram e rode de novo."
  - `node index.js resolve DD-MM-YYYY/NN sent|retry` — `resolveEntry` + `saveState`.
  - `.env` carregado com `process.loadEnvFile` (ausente → segue, e `assertConfig` aponta o que falta). `ConfigError`, `AuthError` e o erro de estado corrompido são impressos sem stack.
  - README: pré-requisitos manuais do spec (seção 8), incluindo a tela de consentimento do Google em "In production", o cliente OAuth "Desktop app" e a conta como target user do sandbox; preencher o `.env`; ordem dos comandos.

- [ ] **Step 1: Implementar** `index.js` e `README.md`.
- [ ] **Step 2: Rodar** `node --test` → PASS e `node index.js` sem `.env` → mensagem listando as 7 variáveis, saída 1.
- [ ] **Step 3: Commit** — `feat: cli commands and readme`
- [ ] **Step 4: Verificação real (com o dono, depois dos pré-requisitos manuais):**
  1. `node index.js telegram-chat-id` → mostra o chat; copiar para o `.env`.
  2. `node index.js auth google` → escolher a conta dona da pasta; cria `tokens/google.json`.
  3. `node index.js auth tiktok` → login na conta `petversodriele`; cria `tokens/tiktok.json`.
  4. `node index.js --dry-run` → lista `17-11-2026/01`, `18-11-2026/01`, `18-11-2026/02`.
  5. `node index.js` → 3 vídeos na caixa de entrada do TikTok, 3 mensagens no Telegram, `processed.json` com 3 entradas `sent`.
  6. `node index.js` de novo → `skipped: 3`, nada enviado.
  7. Anotar no README se o limite de 5 se mostrou "pendentes" ou "por dia" (pergunta aberta do spec).
