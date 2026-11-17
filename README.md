# tiktok-publisher

Envia os vídeos de uma pasta do Google Drive para a **caixa de entrada (rascunhos) do TikTok** e manda as hashtags de cada vídeo por mensagem no Telegram. A publicação final continua manual: você abre o rascunho no app do TikTok, cola as hashtags (um toque na mensagem do Telegram copia o texto) e publica.

- Somente leitura no Drive (escopo `drive.readonly`, apenas requisições GET).
- A identidade de um vídeo é o ID do arquivo no Drive; nada é enviado duas vezes.
- Sem dependências além de `google-auth-library`. Requer Node 26 ou mais novo.

## Estrutura esperada no Drive

```
<pasta raiz>/            ← o ID desta pasta vai em DRIVE_ROOT_FOLDER_ID
├── 17-11-2026/          ← pasta do dia (DD-MM-YYYY)
│   └── 01/              ← uma subpasta por vídeo (01, 02, ...)
│       ├── video.mov    ← exatamente um arquivo de vídeo
│       └── hashtags     ← texto com as hashtags (opcional)
└── 18-11-2026/
    ├── 01/
    └── 02/
```

Os dias são ordenados pela data real e, dentro do dia, pelo número da subpasta. Pastas com nome fora do formato são ignoradas com aviso. Subpasta com zero ou mais de um vídeo é pulada com aviso. Sem arquivo de hashtags, o vídeo é enviado e a mensagem diz "sem hashtags".

## Pré-requisitos manuais

1. **TikTok** (portal de desenvolvedores): crie um app em modo **Sandbox**, com os produtos Login Kit e Content Posting API, e a Redirect URI `http://localhost:3455/callback/`. Em *Sandbox settings → Target Users*, adicione a conta `petversodriele`, que será a dona dos rascunhos. Anote o Client key e o Client secret.
2. **Google Cloud**: crie um projeto, ative a **Google Drive API**, configure a tela de consentimento com status **"In production"** (em "Testing" o refresh token expira em 7 dias) e crie um cliente OAuth do tipo **"Desktop app"**. Anote o Client ID e o Client secret. Na primeira vez, o Google avisa que o app não foi verificado; é o seu próprio app, siga em "Avançado".
3. **Telegram**: crie um bot com o @BotFather e guarde o token. Depois mande qualquer mensagem para o bot.
4. **ID da pasta raiz**: abra a pasta no Drive; o ID é o trecho final da URL.

## Configuração

```sh
cp .env.example .env
```

Preencha o `.env` (ele é ignorado pelo git; nunca o publique):

| Variável | O que é |
| --- | --- |
| `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET` | credenciais do app do TikTok |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | cliente OAuth "Desktop app" do Google |
| `DRIVE_ROOT_FOLDER_ID` | ID da pasta raiz no Drive |
| `TELEGRAM_BOT_TOKEN` | token do bot |
| `TELEGRAM_CHAT_ID` | chat que recebe as hashtags (veja o passo 1 abaixo) |

## Ordem dos comandos

1. `node index.js telegram-chat-id`: mostra os chats que falaram com o bot; copie o `chatId` para `TELEGRAM_CHAT_ID` no `.env`. Se vier "Mande uma mensagem para o bot...", mande a mensagem e rode de novo.
2. `node index.js auth google`: abre o navegador; escolha a conta dona da pasta. Grava `tokens/google.json`.
3. `node index.js auth tiktok`: abre o navegador; entre com a conta `petversodriele`. Grava `tokens/tiktok.json`.
4. `node index.js --dry-run`: lista o que seria enviado, sem enviar nada nem gravar estado.
5. `node index.js`: envia os vídeos pendentes e imprime o resumo (enviados, já enviados, erros, não confirmados, avisos). Sai com código 1 se houver erro.

Se um login expirar ou for revogado, o app para e diz qual `auth` rodar.

## Limite de rascunhos

O TikTok limita a quantidade de rascunhos pendentes. Ao atingir o limite, o app para, avisa no terminal e no Telegram, e o vídeo atual não é marcado como enviado. Publique ou apague os rascunhos pendentes no TikTok (ou espere 24 h) e rode de novo.

## Estado: `processed.json`

Fica na raiz do projeto (ignorado pelo git) e tem uma entrada por vídeo, com o ID do arquivo no Drive como chave. É gravado a cada mudança de estado, de forma atômica.

- `unconfirmed`: o vídeo foi enviado, mas o TikTok ainda não confirmou. Na próxima execução o app consulta o status do `publishId` em vez de reenviar (evitar duplicata vence). Se confirmar, vira `sent`; se o TikTok disser que falhou, volta a ser pendente.
- `sent`: confirmado na caixa de entrada. `telegramSent` indica se a mensagem com as hashtags foi entregue; se o Telegram falhar, só a mensagem é reenviada na próxima execução.

### Resolver à mão: `resolve`

Se um vídeo continuar `unconfirmed`, confira os rascunhos no app do TikTok e rode:

```sh
node index.js resolve 17-11-2026/01 sent    # o vídeo está nos rascunhos: marca como enviado
node index.js resolve 17-11-2026/01 retry   # não está: libera para reenvio
```

Com `sent`, a mensagem do Telegram é enviada na próxima execução.

## Testes

```sh
node --test
```

Nenhum teste acessa serviços externos.
