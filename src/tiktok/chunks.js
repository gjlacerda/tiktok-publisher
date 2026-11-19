export const CHUNK_SIZE = 10_000_000;

// Plano de partes para o upload em chunks do TikTok. `end` é inclusivo.
// Quando sobra uma parte só (arquivos abaixo de 2 * CHUNK_SIZE), o arquivo vai
// inteiro com chunk_size = video_size: o TikTok rejeita total_chunk_count 1 com
// chunk_size menor que o arquivo ("The chunk size is invalid"). Acima disso a
// última parte absorve o resto (total = floor(size / CHUNK_SIZE)).
export function planChunks(size) {
  const totalChunkCount = Math.floor(size / CHUNK_SIZE);
  if (totalChunkCount <= 1) {
    return { chunkSize: size, totalChunkCount: 1, ranges: [{ start: 0, end: size - 1 }] };
  }
  const ranges = [];
  for (let i = 0; i < totalChunkCount; i += 1) {
    const start = i * CHUNK_SIZE;
    const end = i === totalChunkCount - 1 ? size - 1 : start + CHUNK_SIZE - 1;
    ranges.push({ start, end });
  }
  return { chunkSize: CHUNK_SIZE, totalChunkCount, ranges };
}
