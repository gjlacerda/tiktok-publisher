import fs from 'node:fs/promises';
import { ResolveError } from './errors.js';

export async function loadState(path) {
  let raw;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Arquivo de estado corrompido: ${path} (${err.message})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Arquivo de estado corrompido: ${path} (esperado um objeto JSON)`);
  }
  return parsed;
}

export async function saveState(path, state) {
  const tmp = `${path}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(state, null, 2));
  await fs.rename(tmp, path);
}

export function resolveEntry(state, ref, action) {
  const matching = Object.keys(state).filter((key) => `${state[key].day}/${state[key].slot}` === ref);
  const id = matching.find((key) => state[key].status === 'unconfirmed');
  if (id === undefined) {
    if (matching.some((key) => state[key].status === 'sent')) {
      throw new ResolveError(`${ref} já está como enviado; nada a resolver.`);
    }
    throw new ResolveError(`Nenhum vídeo não confirmado registrado como ${ref}`);
  }

  const next = { ...state };
  if (action === 'retry') {
    delete next[id];
  } else if (action === 'sent') {
    const entry = state[id];
    next[id] = {
      ...entry,
      status: 'sent',
      uploadedAt: entry.uploadedAt ?? new Date().toISOString(),
      telegramSent: false,
    };
  } else {
    throw new Error(`Ação desconhecida: ${action}`);
  }
  return next;
}
