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

test('coalescer orders merged text by sequence instead of arrival order', async () => {
  const requests: string[] = [];
  const coalescer = new TtsCoalescer({
    bufferMs: 20,
    maxBufferedChars: 100,
    synthesize: async (_sessionId, text) => {
      requests.push(text);
      return new Blob([text], { type: 'audio/wav' });
    },
  });

  const second = coalescer.enqueue({
    sessionId: 'session-sequence',
    text: '第二句。',
    sequence: 1,
  });
  const first = coalescer.enqueue({
    sessionId: 'session-sequence',
    text: '第一句。',
    sequence: 0,
    flush: true,
  });

  const [secondResult, firstResult] = await Promise.all([second, first]);

  assert.deepEqual(requests, ['第一句。第二句。']);
  assert.equal(secondResult.merged, true);
  assert.equal(secondResult.audio, null);
  assert.equal(firstResult.merged, false);
  assert.ok(firstResult.audio instanceof Blob);
});
