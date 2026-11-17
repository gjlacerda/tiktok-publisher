# TikTok Publisher — Design

Data: 2026-11-17
Status: rascunho para aprovação

> O repositório é público. Este documento não contém e-mails, IDs de pastas nem chaves; tudo isso vai no `.env` local.

## 1. Intenção

Automatizar a parte repetitiva da publicação de vídeos numa conta do TikTok. Os vídeos já ficam prontos no Google Drive, organizados por dia. O app pega cada vídeo ainda não enviado, envia para a **caixa de rascunhos** do TikTok e manda as hashtags desse vídeo pelo Telegram.

**Por que rascunho e não publicação direta:** o dono precisa **vincular um produto** a cada vídeo antes de publicar, e as APIs do TikTok não permitem isso. A finalização (vincular produto, colar legenda, publicar) é sempre manual, no app do TikTok no celular.

**Por que Telegram:** a API de rascunho do TikTok não aceita legenda. As hashtags precisam chegar ao celular de um jeito fácil de copiar e colar na hora de finalizar o post.

## 2. Objetivos, não-objetivos, anti-objetivos

**Objetivos**
- Com um comando (`node index.js`), enviar para os rascunhos do TikTok **todos** os vídeos do Drive ainda não enviados, de datas passadas e futuras, em ordem de data. Não há data de corte: nenhum vídeo do Drive foi enviado antes deste app (os atuais são de teste), então a primeira execução parte de um `processed.json` vazio.
- Para cada vídeo enviado, mandar no Telegram uma mensagem identificando o vídeo (data + número) com as hashtags prontas para copiar.
- Registrar num arquivo local do projeto quais vídeos já foram processados, para nunca reenviar.
- Lidar com o limite de rascunhos pendentes do TikTok sem perder estado: parar, avisar e continuar na próxima execução.

**Não-objetivos (por enquanto)**
- Agendamento automático. O app roda manualmente no MacBook do dono.
- Mais de uma conta do TikTok. Só a conta `petversodriele`.
- Publicar direto, definir legenda, privacidade ou produto pela API.
- Servidor, interface web, banco de dados.

**Anti-objetivos (seria um fracasso mesmo funcionando)**
- Enviar o mesmo vídeo duas vezes para o TikTok.
- Marcar como enviado um vídeo que não chegou aos rascunhos.
- Alterar, mover ou apagar qualquer coisa no Google Drive.
- Vazar chaves ou tokens no repositório público.

## 3. Restrições conhecidas

**TikTok (Content Posting API — Upload)**
- Endpoint: `POST https://open.tiktokapis.com/v2/post/publish/inbox/video/init/`, escopo `video.upload`. O corpo só aceita `source_info`; **não há campo de legenda**.
- Envio por `FILE_UPLOAD`: o init devolve um `upload_url` (válido por 1 hora) e o vídeo vai por `PUT` em partes, com `Content-Range` e `Content-Type` de vídeo (os arquivos atuais são `.mov` → `video/quicktime`). Seguir as regras de tamanho de parte da documentação do TikTok (Media Transfer Guide).
- `PULL_FROM_URL` não serve: exige verificação de domínio, impossível para o Google Drive.
- Limites: 6 requisições por minuto por token (`429 rate_limit_exceeded`); no máximo **5 compartilhamentos pendentes em 24 horas** (`403 spam_risk_too_many_pending_share`). A documentação é ambígua sobre se finalizar rascunhos libera vagas; o app deve funcionar nos dois casos.
- App em modo **sandbox** (já configurado): Login Kit Desktop, redirect URI `http://localhost:3455/callback/`, escopos `user.info.basic` e `video.upload`, Direct Post desligado. A conta do TikTok precisa estar cadastrada como target user.
- Login Kit Desktop exige **PKCE** (`code_challenge` = SHA256 do verifier em hexadecimal, método `S256`). Autorização em `https://www.tiktok.com/v2/auth/authorize/`; troca e renovação de token conforme o guia "Manage User Access Tokens".

**Google Drive**
- Login OAuth com a conta Google dona da pasta (não é a conta padrão do navegador; o login deve permitir escolher a conta).
- Escopo `https://www.googleapis.com/auth/drive.readonly`.
- Cliente OAuth do tipo **Desktop app**, redirect por loopback (`http://127.0.0.1:<porta>`).
- A tela de consentimento deve ficar com status **"In production"** (sem verificação) para o refresh token não expirar a cada 7 dias. O login mostrará o aviso de "app não verificado" uma vez.

**Ambiente**
- macOS, execução manual no terminal.
- **JavaScript** (não TypeScript), ES modules, **Node 26 LTS**. Fixar em `package.json` (`engines`) e `.nvmrc`.
- O `node_modules` atual veio de outro contexto (`request`, `tsx`, `typescript`) e não deve ser usado; o projeto começa com `package.json` novo.

## 4. Estrutura do Google Drive

```
tiktok-temp/
└── vídeos prontos/
    └── petversodriele/              ← pasta raiz do app (ID no .env)
        ├── 17-11-2026/              ← pasta do dia, formato DD-MM-YYYY
        │   └── 01/                  ← uma subpasta por vídeo, numerada 01, 02, ...
        │       ├── 1105-copy.mov    ← o vídeo (nome livre)
        │       └── hashtags         ← texto com as hashtags (sem extensão)
        └── 18-11-2026/
            ├── 01/ (vídeo + hashtags)
            └── 02/ (vídeo + hashtags)
```

Observações do levantamento:
- O arquivo de hashtags se chama `hashtags`, sem `.txt`. O conteúdo não foi lido ainda (cerca de 22 bytes). O app manda o texto como está, sem interpretar.
- Nomes de vídeo se repetem entre pastas; a identidade de um vídeo é o **ID do arquivo no Drive**.

## 5. Abordagens consideradas

**Acesso ao Google Drive**
- A) Conta de serviço com a pasta compartilhada em modo leitura. Sem login e sem expiração, acesso restrito à pasta.
- **B) Login OAuth com a conta dona da pasta — escolhida pelo dono.** O custo do refresh token de 7 dias é evitado com a tela de consentimento em "In production".

**Entrega das hashtags**
- **Bot do Telegram (via @BotFather) — escolhido.** Simples, gratuito, texto fácil de copiar.
- Descartados: Telegram com a conta pessoal (login por telefone, sem vantagem), ntfy (copiar de notificação é pior, canal público por padrão), e-mail (mais lento), WhatsApp (API oficial pesada, as não oficiais arriscam banimento).

**Envio do vídeo ao TikTok**
- **Upload (rascunho) — escolhido**, porque o produto precisa ser vinculado manualmente.
- Direct Post descartado: publica na hora e não permite vincular produto depois.

## 6. Comportamento

### 6.1 Comandos
- `node index.js` — processa todos os vídeos pendentes.
- `node index.js --dry-run` — lista o que seria enviado, sem enviar nada nem gravar estado. *(Decisão do Claude: útil por causa do limite de 5.)*
- `node index.js auth tiktok` / `node index.js auth google` — faz o login no navegador e grava o token. Se o app rodar sem token válido, ele avisa qual comando usar.
- Um comando de ajuda para descobrir o chat ID do Telegram (ler `getUpdates` depois que o dono mandar uma mensagem ao bot). *(Decisão do Claude.)*

### 6.2 Fluxo de uma execução
1. Carrega `.env`, `processed.json` e os tokens. Renova os tokens se necessário.
2. Lista as pastas de dia na raiz. Aceita só nomes `DD-MM-YYYY` válidos; os outros são ignorados com aviso no terminal.
3. Ordena os dias por **data real** (não pelo texto) e, dentro do dia, as subpastas pelo número.
4. Em cada subpasta de vídeo:
   - Espera **exatamente um** arquivo de vídeo (`mimeType` `video/*`). Zero ou mais de um: pula e avisa. *(Decisão do Claude.)*
   - Procura o arquivo de hashtags pelo nome `hashtag`/`hashtags`, com ou sem `.txt`, sem diferenciar maiúsculas. Se faltar, o vídeo é enviado mesmo assim e a mensagem do Telegram diz "sem hashtags". *(Decisão do Claude.)*
   - Se o ID do vídeo já está em `processed.json` como enviado, pula.
5. Para cada vídeo pendente, em ordem:
   1. Baixa o vídeo do Drive para uma pasta temporária do projeto (ignorada pelo git).
   2. Faz o init no TikTok e **grava imediatamente** o vídeo em `processed.json` como `unconfirmed`, com o `publish_id`. Envia as partes e confirma pelo endpoint de status de publicação (`/v2/post/publish/status/fetch/`).
   3. Com a confirmação, muda o estado para `sent` (com horário). Ver 6.4 para falhas e incertezas. O arquivo é gravado a cada mudança de estado, não só no fim.
   4. Envia a mensagem no Telegram e grava que a mensagem foi entregue.
   5. Apaga o arquivo temporário.
6. Mostra um resumo no terminal: quantos enviados, pulados, com erro, e se o limite foi atingido.

### 6.3 Mensagem do Telegram
Uma mensagem por vídeo:

```
📅 17-11-2026 · vídeo 01
<hashtags em bloco monoespaçado — tocar copia>
```

Usar `parse_mode` HTML com `<code>` para o toque copiar o texto; escapar o conteúdo do arquivo.

### 6.4 Erros e limites
- **`spam_risk_too_many_pending_share`:** para o processamento, avisa no Telegram e no terminal ("limite de rascunhos atingido; rode de novo depois de publicar os pendentes ou em 24h"). O vídeo atual não é marcado como enviado.
- **`429 rate_limit_exceeded`:** espera e tenta de novo, respeitando 6 requisições/minuto.
- **Falha antes de o TikTok aceitar o vídeo** (erro no init ou num `PUT` de parte): o vídeo não é marcado; segue para o próximo e entra no resumo de erros. Será tentado de novo na próxima execução.
- **Status `FAILED` depois do upload:** o TikTok confirma que o vídeo não chegou; tratado como acima (tenta de novo na próxima execução).
- **Resultado incerto** (upload enviado, mas o status não confirma a tempo, dá erro, ou o processo cai): **evitar duplicata vence.** O vídeo fica no estado `unconfirmed` com o `publishId`. Nas execuções seguintes o app consulta o status desse `publishId` em vez de reenviar: se confirmar, vira `sent` (e manda o Telegram); se vier `FAILED`, volta a ser pendente. Se continuar incerto, avisa no terminal e no Telegram para o dono conferir os rascunhos, e um comando permite resolver à mão (marcar como enviado ou liberar para reenvio). *(Decisão do Claude.)*
- **Upload ok, mas Telegram falhou:** o vídeo fica como enviado e a mensagem fica pendente; a próxima execução tenta reenviar só a mensagem.
- **Token inválido ou revogado:** para e indica o comando de login.

## 7. Estado e configuração

**`processed.json`** (na raiz do projeto, ignorado pelo git porque o repositório é público — *decisão do Claude*). Uma entrada por vídeo, chave = ID do arquivo no Drive:

```json
{
  "<driveFileId>": {
    "day": "17-11-2026",
    "slot": "01",
    "fileName": "1105-copy.mov",
    "status": "sent",
    "publishId": "...",
    "uploadedAt": "2026-11-17T18:00:00Z",
    "telegramSent": true
  }
}
```

Gravação atômica (escrever em arquivo temporário e renomear) para não corromper o estado se o processo cair.

**`.env`** (ignorado pelo git): credenciais do TikTok (client key/secret), do cliente OAuth do Google, ID da pasta raiz no Drive, token do bot e chat ID do Telegram.

**Tokens** em arquivos locais ignorados pelo git.

## 8. Pré-requisitos manuais (fora do código)
1. TikTok: adicionar a conta `petversodriele` em Sandbox settings → Target Users.
2. Google Cloud: criar projeto, ativar a Drive API, configurar a tela de consentimento (status "In production"), criar cliente OAuth "Desktop app".
3. Telegram: criar o bot no @BotFather, mandar uma mensagem a ele, obter o chat ID.
4. Preencher o `.env`.

## 9. Fica a cargo de quem construir
- Organização dos arquivos e módulos.
- Bibliotecas (sugestão: só a oficial do Google para OAuth/Drive; `fetch` nativo para TikTok e Telegram; carregar `.env` com recurso nativo do Node).
- Tamanho das partes do upload, dentro das regras do TikTok.
- Testes (sugestão: `node:test`, com as APIs externas simuladas, cobrindo descoberta de pastas, ordenação por data, deduplicação e tratamento do limite).
- Formato exato das mensagens do terminal.
