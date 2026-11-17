import http from 'node:http';
import { execFile } from 'node:child_process';

const HTML_HEAD = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Login</title></head><body>';
const HTML_TAIL = '</body></html>';

function page(message) {
  return `${HTML_HEAD}<p>${message}</p>${HTML_TAIL}`;
}

// Sobe um servidor em 127.0.0.1:port e espera o redirect do OAuth em `path`.
export function waitForCallback({ port, path, expectedState, timeoutMs = 300000 }) {
  return new Promise((resolve, reject) => {
    let timer;
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== path) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Não encontrado');
        return;
      }

      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');

      let failure = null;
      if (error) failure = new Error(`Login recusado: ${error}`);
      else if (state !== expectedState) failure = new Error('Resposta inválida do login (state diferente).');
      else if (!code) failure = new Error('Resposta inválida do login (sem code).');

      const status = failure ? 400 : 200;
      const body = failure
        ? page('Não foi possível concluir o login. Volte ao terminal e tente de novo.')
        : page('Login concluído, pode fechar esta aba.');
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', Connection: 'close' });
      res.end(body, () => {
        finish(failure, { code });
      });
    });

    function finish(failure, value) {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      if (failure) reject(failure);
      else resolve(value);
    }

    server.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    timer = setTimeout(() => {
      finish(new Error('Tempo esgotado esperando o login no navegador.'));
    }, timeoutMs);

    server.listen(port, '127.0.0.1');
  });
}

// Abre a URL no navegador padrão (macOS) e também a imprime no terminal.
export function openBrowser(url) {
  console.log(`Se o navegador não abrir, acesse:\n${url}`);
  execFile('open', [url], () => {});
}
