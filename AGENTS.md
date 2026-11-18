# AGENTS.md

Guia para agentes que trabalham neste repositório. O README é para quem usa o app; o spec explica o *porquê* das decisões. Aqui está o essencial para mexer no código sem quebrar nada.

- Uso, setup e comandos: `README.md`
- Design e restrições das APIs: `docs/superpowers/specs/2026-11-17-tiktok-publisher-design.md`
- Plano de implementação: `docs/superpowers/plans/2026-11-17-tiktok-publisher.md`

## O que o app faz

CLI manual (roda no Mac do dono, sem servidor nem agendamento). Lê uma pasta do Google Drive organizada em `DD-MM-YYYY/NN/` (um vídeo e um arquivo opcional `hashtags` por subpasta), envia cada vídeo novo para a **caixa de rascunhos do TikTok** e manda as hashtags dele por **mensagem no Telegram**.

- Rascunho e não publicação direta: o dono precisa vincular um produto a cada vídeo no app do TikTok, e a API não permite isso. A finalização é sempre manual.
- Telegram porque a API de rascunho do TikTok não aceita legenda.
- Só uma conta do TikTok (em modo Sandbox).

## Invariantes (não quebrar)

1. **Nunca enviar o mesmo vídeo duas vezes.** Na dúvida, a entrada fica `unconfirmed` e a próxima execução consulta o status do `publishId` em vez de reenviar. Duplicata é pior que atraso.
2. **Nunca marcar como enviado o que não chegou aos rascunhos.** `sent` só depois de o TikTok confirmar (`SEND_TO_USER_INBOX` ou `PUBLISH_COMPLETE`).
3. **O Drive é somente leitura** (escopo `drive.readonly`, só GET). Nada é alterado, movido ou apagado lá.
4. **O repositório é público.** Nunca commitar `.env`, `tokens/`, `processed.json`, IDs de pasta, e-mails ou chaves. Exemplos e testes usam valores fictícios.
5. **Telegram nunca derruba a execução:** falha vira aviso. `AuthError` sempre propaga.

## Mapa do código

| Arquivo | Papel |
| --- | --- |
| `index.js` | CLI: `publish`, `--dry-run`, `auth google\|tiktok`, `telegram-chat-id`, `resolve`, `help`. Monta as dependências e imprime o resumo. |
| `src/publisher.js` | Orquestrador (`runPublisher`): reconcilia `unconfirmed`, reenvia hashtags pendentes, baixa, faz init/upload/espera no TikTok e persiste o estado a cada mudança. |
| `src/state.js` | `processed.json`: chave = ID do arquivo no Drive. Gravação atômica (`.tmp` + `rename`). `resolveEntry` para o comando `resolve`. |
| `src/lock.js` | Lock por arquivo (`processed.json.lock`) para execuções e `resolve` não se sobreporem. |
| `src/config.js` | Lê o `.env` e valida variáveis por grupo (`assertConfig`). Portas de login: TikTok 3455, Google 3456. |
| `src/errors.js` | Erros tipados: `ConfigError`, `AuthError`, `LimitReachedError`, `TikTokApiError`, `TelegramError`, `ResolveError`, `LockError`. |
| `src/drive/` | `client.js` (listar, ler texto, baixar para arquivo) e `discover.js` (monta a fila ordenada por data e número, com avisos). |
| `src/tiktok/` | `client.js` (init, upload em partes, consulta de status, espera) e `chunks.js` (plano de partes). |
| `src/auth/` | Login OAuth e renovação de token do Google e do TikTok (PKCE no TikTok); `loopback.js` recebe o redirect local. |
| `src/telegram.js` | Envio das mensagens e `findChatIds`. |

Estado de cada vídeo: ausente (pendente) → `unconfirmed` (init feito, sem confirmação) → `sent`, com `telegramSent` indicando se as hashtags já foram entregues.

## Comandos

```sh
nvm use                  # Node 26 (.nvmrc)
npm install
npm test                 # node --test; nenhum teste acessa rede
node index.js --dry-run  # mostra o que seria enviado; não envia nem grava estado
```

Para testar manualmente, use sempre `--dry-run`. A execução normal envia vídeos de verdade para o TikTok e mensagens para o Telegram.

## Convenções

- JavaScript com ES modules, sem TypeScript, sem build. Node >= 26.
- Única dependência: `google-auth-library`. Prefira o que o Node já traz (`fetch`, `node:test`, `process.loadEnvFile`).
- Dependências externas (`fetch`, `sleep`, `now`, clientes de Drive/TikTok/Telegram) são **injetadas** nas funções `create*`/`run*`. Os testes passam fakes; mantenha esse padrão.
- Testes ficam em `test/<módulo>.test.js`. Mudou comportamento, mude ou crie o teste.
- Mensagens para o usuário (terminal, Telegram) e documentação em português.

## Armadilhas

- **Limites do TikTok:** no máximo 5 rascunhos pendentes em 24 h (`spam_risk_too_many_pending_share` vira `LimitReachedError`: o app para, avisa e **não** marca o vídeo atual) e 6 requisições por minuto por token.
- **Upload em partes:** `PUT` no `upload_url` com `Content-Range`. Uma parte só (arquivo abaixo de 2 × 10 MB) vai inteira com `chunk_size = video_size`; o TikTok rejeita `chunk_size` menor com `total_chunk_count` 1. Veja `src/tiktok/chunks.js` antes de mexer.
- **`PULL_FROM_URL` não serve:** exige verificação de domínio, impossível com o Drive.
- **Download incompleto:** o tamanho baixado é comparado ao informado pelo Drive e o item falha se divergir.
- **Tokens:** os logins vivem em `tokens/*.json` e são verificados antes de qualquer download. Se expirar, o erro diz qual `auth` rodar. O consentimento do Google precisa estar "In production", senão o refresh token expira em 7 dias.
- **Arquivos locais ignorados pelo git:** `.env`, `tokens/`, `tmp/` (vídeos baixados, removidos ao fim de cada item), `processed.json`, `processed.json.lock`.
- **`data/tiktok_research.db`** é uma base de pesquisa sobre as APIs do TikTok; não faz parte do app e nada no código a usa.
- **`docs/` (exceto `docs/superpowers/`)** é o site público (GitHub Pages) com termos e política de privacidade, exigidos pelo TikTok. Não é documentação do código.
