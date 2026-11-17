// Lógica pura: transforma a árvore de pastas do Drive em uma fila ordenada de uploads.

const DAY_RE = /^(\d{2})-(\d{2})-(\d{4})$/;
const SLOT_RE = /^\d+$/;
const HASHTAGS_RE = /^hashtags?(\.txt)?$/i;

export function parseDayName(name) {
  const m = DAY_RE.exec(name);
  if (!m) return null;
  const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid =
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  return valid ? date : null;
}

export function isHashtagsFile(name) {
  return HASHTAGS_RE.test(name);
}

const isVideo = (file) => typeof file.mimeType === 'string' && file.mimeType.startsWith('video/');

export function buildQueue(tree) {
  const items = [];
  const warnings = [];

  const days = [];
  for (const day of tree) {
    const date = parseDayName(day.name);
    if (!date) {
      warnings.push(`Pasta de dia ignorada (nome fora do formato DD-MM-AAAA): "${day.name}"`);
      continue;
    }
    days.push({ day, date });
  }
  days.sort((a, b) => a.date - b.date);

  for (const { day } of days) {
    const slots = [];
    for (const slot of day.slots) {
      if (!SLOT_RE.test(slot.name)) {
        warnings.push(`Pasta de slot ignorada em ${day.name} (nome deve ser numérico): "${slot.name}"`);
        continue;
      }
      slots.push(slot);
    }
    slots.sort((a, b) => Number(a.name) - Number(b.name));

    for (const slot of slots) {
      const videos = slot.files.filter(isVideo);
      if (videos.length === 0) {
        warnings.push(`Slot ${slot.name} de ${day.name} ignorado: nenhum vídeo encontrado`);
        continue;
      }
      if (videos.length > 1) {
        warnings.push(`Slot ${slot.name} de ${day.name} ignorado: ${videos.length} vídeos (esperado 1)`);
        continue;
      }
      const hashtags = slot.files.find((f) => isHashtagsFile(f.name)) ?? null;
      items.push({ day: day.name, slot: slot.name, video: videos[0], hashtags });
    }
  }

  return { items, warnings };
}
