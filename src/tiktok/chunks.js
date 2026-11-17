export const CHUNK_SIZE = 10_000_000;

// Plano de partes para o upload em chunks do TikTok. `end` é inclusivo.
// Arquivos até CHUNK_SIZE vão numa parte só; acima disso a última parte
// absorve o resto (total = floor(size / CHUNK_SIZE)).
export function planChunks(size) {
  if (size <= CHUNK_SIZE) {
    return { chunkSize: size, totalChunkCount: 1, ranges: [{ start: 0, end: size - 1 }] };
  }
  const totalChunkCount = Math.floor(size / CHUNK_SIZE);
  const ranges = [];
  for (let i = 0; i < totalChunkCount; i += 1) {
    const start = i * CHUNK_SIZE;
    const end = i === totalChunkCount - 1 ? size - 1 : start + CHUNK_SIZE - 1;
    ranges.push({ start, end });
  }
  return { chunkSize: CHUNK_SIZE, totalChunkCount, ranges };
}
