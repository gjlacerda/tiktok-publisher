import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHUNK_SIZE, planChunks } from '../src/tiktok/chunks.js';

test('CHUNK_SIZE é 10 MB', () => {
  assert.equal(CHUNK_SIZE, 10_000_000);
});

test('planChunks arquivo pequeno vai inteiro', () => {
  const plan = planChunks(4_000_000);
  assert.equal(plan.chunkSize, 4_000_000);
  assert.equal(plan.totalChunkCount, 1);
  assert.deepEqual(plan.ranges, [{ start: 0, end: 3_999_999 }]);
});

test('planChunks arquivo de 18,2 MB vai inteiro com chunk_size igual ao tamanho', () => {
  // O TikTok rejeita total_chunk_count 1 com chunk_size menor que video_size
  // ("The chunk size is invalid").
  const plan = planChunks(18_200_000);
  assert.equal(plan.chunkSize, 18_200_000);
  assert.equal(plan.totalChunkCount, 1);
  assert.deepEqual(plan.ranges, [{ start: 0, end: 18_199_999 }]);
});

test('planChunks 20 MB ou mais divide em partes', () => {
  const plan = planChunks(20_000_000);
  assert.equal(plan.chunkSize, 10_000_000);
  assert.equal(plan.totalChunkCount, 2);
  assert.deepEqual(plan.ranges, [
    { start: 0, end: 9_999_999 },
    { start: 10_000_000, end: 19_999_999 },
  ]);
});

test('planChunks segue o exemplo da documentação', () => {
  const plan = planChunks(50_000_123);
  assert.equal(plan.chunkSize, 10_000_000);
  assert.equal(plan.totalChunkCount, 5);
  assert.equal(plan.ranges.length, 5);
  assert.deepEqual(plan.ranges[0], { start: 0, end: 9_999_999 });
  assert.deepEqual(plan.ranges[4], { start: 40_000_000, end: 50_000_122 });
});

test('planChunks tamanho exato de um chunk vai inteiro', () => {
  const plan = planChunks(10_000_000);
  assert.equal(plan.totalChunkCount, 1);
  assert.deepEqual(plan.ranges, [{ start: 0, end: 9_999_999 }]);
});
