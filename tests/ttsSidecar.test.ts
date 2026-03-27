import test from 'node:test';
import assert from 'node:assert/strict';

import { TtsCoalescer } from '../server/ttsSidecar.ts';

test('coalescer merges rapid consecutive chunks into a single synthesis request', async () => {
  const requests: string[] = [];
  const coalescer = new TtsCoalescer({
    bufferMs: 20,
    maxBufferedChars: 100,
    synthesize: async (_sessionId, text) => {
      requests.push(text);
      return new Blob([text], { type: 'audio/wav' });
    },
  });

  const first = coalescer.enqueue({
    sessionId: 'session-1',
    text: '第一句',
  });
  const second = await coalescer.enqueue({
    sessionId: 'session-1',
    text: '，继续',
  });

  assert.equal(second.merged, true);
  assert.equal(second.audio, null);

  const firstResult = await first;
  assert.equal(firstResult.merged, false);
  assert.ok(firstResult.audio instanceof Blob);
  assert.deepEqual(requests, ['第一句，继续']);
});

test('coalescer flushes pending text immediately when a final chunk arrives', async () => {
  const requests: string[] = [];
  const coalescer = new TtsCoalescer({
    bufferMs: 100,
    maxBufferedChars: 100,
    synthesize: async (_sessionId, text) => {
      requests.push(text);
      return new Blob([text], { type: 'audio/wav' });
    },
  });

  const first = coalescer.enqueue({
    sessionId: 'session-1',
    text: '第一句',
  });
  const second = await coalescer.enqueue({
    sessionId: 'session-1',
    text: '。第二句。',
    flush: true,
  });

  assert.equal(second.merged, true);
  assert.equal(second.audio, null);

  const firstResult = await first;
  assert.ok(firstResult.audio instanceof Blob);
  assert.deepEqual(requests, ['第一句。第二句。']);
});

test('coalescer composes merged text by request sequence instead of arrival order', async () => {
  const requests: string[] = [];
  const coalescer = new TtsCoalescer({
    bufferMs: 100,
    maxBufferedChars: 100,
    synthesize: async (_sessionId, text) => {
      requests.push(text);
      return new Blob([text], { type: 'audio/wav' });
    },
  });

  const laterChunk = coalescer.enqueue({
    sessionId: 'session-ordered',
    text: '第二句。',
    sequence: 1,
  });
  const firstChunk = await coalescer.enqueue({
    sessionId: 'session-ordered',
    text: '第一句。',
    flush: true,
    sequence: 0,
  });
  const laterChunkResult = await laterChunk;

  assert.equal(firstChunk.merged, false);
  assert.ok(firstChunk.audio instanceof Blob);
  assert.equal(laterChunkResult.merged, true);
  assert.equal(laterChunkResult.audio, null);

  assert.deepEqual(requests, ['第一句。第二句。']);
});

test('coalescer keeps a five-sentence out-of-order batch complete and correctly ordered', async () => {
  const requests: string[] = [];
  const coalescer = new TtsCoalescer({
    bufferMs: 100,
    maxBufferedChars: 1000,
    synthesize: async (_sessionId, text) => {
      requests.push(text);
      return new Blob([text], { type: 'audio/wav' });
    },
  });

  const sessionId = 'session-five-sentences';
  const sentences = [
    '第一句，先把背景说清楚。',
    '第二句，把条件接上。',
    '第三句，继续补充重点。',
    '第四句，把限制说明白。',
    '第五句，最后一起收尾。',
  ];

  const arrivalOrder = [4, 2, 0, 1, 3];
  const pending = arrivalOrder.map((index, offset) => coalescer.enqueue({
    sessionId,
    text: sentences[index],
    sequence: index,
    flush: offset === arrivalOrder.length - 1,
  }));

  const results = await Promise.all(pending);
  const ownerIndex = arrivalOrder.findIndex((index) => index === 0);

  assert.equal(results[ownerIndex]?.merged, false);
  assert.ok(results[ownerIndex]?.audio instanceof Blob);

  results.forEach((result, index) => {
    if (index === ownerIndex) return;
    assert.equal(result.merged, true);
    assert.equal(result.audio, null);
  });

  assert.deepEqual(requests, [sentences.join('')]);
  assert.deepEqual(
    results.map((result) => [result.startSequence, result.endSequence]),
    Array.from({ length: arrivalOrder.length }, () => [0, 4]),
  );
});

test('coalescer keeps different sessions isolated', async () => {
  const requests: string[] = [];
  const coalescer = new TtsCoalescer({
    bufferMs: 10,
    maxBufferedChars: 100,
    synthesize: async (_sessionId, text) => {
      requests.push(text);
      return new Blob([text], { type: 'audio/wav' });
    },
  });

  const first = coalescer.enqueue({
    sessionId: 'session-1',
    text: '甲',
    flush: true,
  });
  const second = coalescer.enqueue({
    sessionId: 'session-2',
    text: '乙',
    flush: true,
  });

  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.ok(firstResult.audio instanceof Blob);
  assert.ok(secondResult.audio instanceof Blob);
  assert.equal(requests.length, 2);
  assert.ok(requests.includes('甲'));
  assert.ok(requests.includes('乙'));
});

test('coalescer ignores empty input instead of synthesizing blank audio', async () => {
  let synthesizeCalls = 0;
  const coalescer = new TtsCoalescer({
    bufferMs: 10,
    maxBufferedChars: 100,
    synthesize: async () => {
      synthesizeCalls += 1;
      return new Blob(['wav'], { type: 'audio/wav' });
    },
  });

  const result = await coalescer.enqueue({
    sessionId: 'session-empty',
    text: '   ',
  });

  assert.equal(result.merged, true);
  assert.equal(result.audio, null);
  assert.equal(synthesizeCalls, 0);
});

test('coalescer prefers higher-priority queued batches when synthesis slots free up', async () => {
  const started: string[] = [];
  const resolvers = new Map<string, () => void>();

  const coalescer = new TtsCoalescer({
    bufferMs: 10,
    maxBufferedChars: 100,
    synthesizeConcurrency: 1,
    synthesize: async (_sessionId, text) => {
      started.push(text);
      await new Promise<void>((resolve) => {
        resolvers.set(text, resolve);
      });
      return new Blob([text], { type: 'audio/wav' });
    },
  });

  const lowFirst = coalescer.enqueue({
    sessionId: 'session-low-first',
    text: '第二句',
    flush: true,
    priority: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const lowSecond = coalescer.enqueue({
    sessionId: 'session-low-second',
    text: '第三句',
    flush: true,
    priority: 1,
  });
  const highPriority = coalescer.enqueue({
    sessionId: 'session-high',
    text: '第一句',
    flush: true,
    priority: 0,
  });

  assert.deepEqual(started, ['第二句']);

  resolvers.get('第二句')?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['第二句', '第一句']);

  resolvers.get('第一句')?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(started, ['第二句', '第一句', '第三句']);

  resolvers.get('第三句')?.();
  await Promise.all([lowFirst, lowSecond, highPriority]);
});
