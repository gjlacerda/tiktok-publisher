// Cliente REST somente-leitura do Google Drive v3 (apenas GET).
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { AuthError } from '../errors.js';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

export function createDriveClient({ getAccessToken, fetch }) {
  async function get(url) {
    const token = await getAccessToken();
    const res = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    if (res.status === 401) throw new AuthError('google');
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Drive API respondeu ${res.status}: ${body}`);
    }
    return res;
  }

  const toFile = ({ id, name, mimeType, size }) => {
    const file = { id, name, mimeType };
    if (size !== undefined) file.size = Number(size);
    return file;
  };

  async function listChildren(folderId) {
    const files = [];
    let pageToken;
    do {
      const params = new URLSearchParams({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const res = await get(`${API}/files?${params}`);
      const data = await res.json();
      files.push(...(data.files ?? []).map(toFile));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return files;
  }

  async function downloadToFile(file, destPath) {
    const params = new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' });
    const res = await get(`${API}/files/${encodeURIComponent(file.id)}?${params}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(destPath));
  }

  async function readText(file) {
    const id = encodeURIComponent(file.id);
    const url =
      file.mimeType === DOC_MIME
        ? `${API}/files/${id}/export?${new URLSearchParams({ mimeType: 'text/plain' })}`
        : `${API}/files/${id}?${new URLSearchParams({ alt: 'media', supportsAllDrives: 'true' })}`;
    const res = await get(url);
    return res.text();
  }

  async function scanTree(rootId) {
    const folders = (children) => children.filter((c) => c.mimeType === FOLDER_MIME);
    const days = [];
    for (const day of folders(await listChildren(rootId))) {
      const slots = [];
      for (const slot of folders(await listChildren(day.id))) {
        const files = (await listChildren(slot.id)).filter((c) => c.mimeType !== FOLDER_MIME);
        slots.push({ id: slot.id, name: slot.name, files });
      }
      days.push({ id: day.id, name: day.name, slots });
    }
    return days;
  }

  return { listChildren, downloadToFile, readText, scanTree };
}
