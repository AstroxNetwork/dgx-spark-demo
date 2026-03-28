import test from 'node:test';
import assert from 'node:assert/strict';

import { qwenService } from '../src/services/qwenService.ts';

test('voiceChat keeps the same TTS profile across streamed segments', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  const synthesizedRequests: Array<{
    text: string;
    language: string | undefined;
    instructions: string | undefined;
    voice: string | undefined;
    seed: number | undefined;
  }> = [];

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '第一句。第二句' };
    yield { text: '，继续' };
    yield { text: '完成！' };
    yield { done: true };
  };
  qwenService.synthesize = async (text, options) => {
    const normalizedOptions = typeof options === 'string' ? { voice: options } : options;
    synthesizedRequests.push({
      text,
      language: normalizedOptions?.language,
      instructions: normalizedOptions?.instructions,
      voice: normalizedOptions?.voice,
      seed: normalizedOptions?.seed,
    });
    return new Blob([text], { type: 'audio/wav' });
  };

  const events: Array<'text' | 'audio' | 'done'> = [];

  try {
    for await (const chunk of qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }))) {
      if (chunk.text) events.push('text');
      if (chunk.audio) events.push('audio');
      if (chunk.done) events.push('done');
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }

  assert.deepEqual(
    synthesizedRequests.map((request) => request.text),
    ['第一句。第二句，继续完成！'],
  );
  assert.deepEqual(
    synthesizedRequests.map((request) => request.voice),
    ['Vivian'],
  );
  assert.deepEqual(
    synthesizedRequests.map((request) => request.language),
    ['Chinese'],
  );
  assert.equal(typeof synthesizedRequests[0]?.seed, 'number');
  assert.ok(
    synthesizedRequests.every(
      (request) => request.instructions === '用默认的音调，新闻联播的口吻，不带任何的情绪',
    ),
  );
  assert.deepEqual(events, ['text', 'text', 'text', 'text', 'audio', 'done']);
});

test('voiceChat keeps the same seed across all TTS segments in one turn', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  const seeds: Array<number | undefined> = [];

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '这里先给你一个完整的开场说明，把背景、限制和接下来的重点都放在这一句里统一交代清楚。' };
    yield { text: '这是后续补充。' };
    yield { done: true };
  };
  qwenService.synthesize = async (_text, options) => {
    const normalizedOptions = typeof options === 'string' ? { voice: options } : options;
    seeds.push(normalizedOptions?.seed);
    return new Blob(['wav'], { type: 'audio/wav' });
  };

  try {
    for await (const _chunk of qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }))) {
      // consume stream
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }

  assert.ok(seeds.length >= 2);
  assert.equal(typeof seeds[0], 'number');
  assert.ok(seeds.every((seed) => seed === seeds[0]));
});

test('voiceChat waits to synthesize until a streamed segment is long enough to keep delivery stable', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  const synthesizedTexts: string[] = [];

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '好。' };
    yield { text: '我们现在正常一点说话。' };
    yield { done: true };
  };
  qwenService.synthesize = async (text) => {
    synthesizedTexts.push(text);
    return new Blob([text], { type: 'audio/wav' });
  };

  try {
    for await (const _chunk of qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }))) {
      // consume stream
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }

  assert.deepEqual(synthesizedTexts, ['好。我们现在正常一点说话。']);
});

test('voiceChat does not start the first TTS segment from a very short opening sentence', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  const synthesizedTexts: string[] = [];

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '好。' };
    yield { text: '后来我们再认真展开说。' };
    yield { done: true };
  };
  qwenService.synthesize = async (text) => {
    synthesizedTexts.push(text);
    return new Blob([text], { type: 'audio/wav' });
  };

  try {
    for await (const _chunk of qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }))) {
      // consume stream
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }

  assert.deepEqual(synthesizedTexts, ['好。后来我们再认真展开说。']);
});

test('voiceChat does not block later text chunks while an earlier TTS segment is still synthesizing', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  let resolveFirstSegment: ((blob: Blob) => void) | null = null;

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '这是第一句，而且足够长，能够立即开始合成。' };
    yield { text: '第二句。' };
  };
  qwenService.synthesize = async (text) => {
    if (text === '这是第一句，而且足够长，能够立即开始合成。') {
      return await new Promise<Blob>((resolve) => {
        resolveFirstSegment = resolve;
      });
    }

    return new Blob([text], { type: 'audio/wav' });
  };

  const iterator = qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }));

  try {
    await iterator.next();
    const firstAssistantChunk = await iterator.next();
    assert.equal(firstAssistantChunk.value?.text, '这是第一句，而且足够长，能够立即开始合成。');

    const secondChunkOrTimeout = await Promise.race([
      iterator.next(),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 20)),
    ]);

    assert.notEqual(secondChunkOrTimeout, 'timeout');
    assert.equal(secondChunkOrTimeout.value?.text, '第二句。');
  } finally {
    resolveFirstSegment?.(new Blob(['这是第一句，而且足够长，能够立即开始合成。'], { type: 'audio/wav' }));
    await iterator.return?.();
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }
});

test('voiceChat can start TTS on the first complete sentence before the full reply finishes', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  const synthesizedTexts: string[] = [];
  let allowSecondChunk!: () => void;
  const secondChunkGate = new Promise<void>((resolve) => {
    allowSecondChunk = resolve;
  });

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '这里先给你一个完整的开场说明，把背景、限制和接下来的重点都放在这一句里统一交代清楚。' };
    await secondChunkGate;
    yield { text: '这是后续补充。' };
  };
  qwenService.synthesize = async (text) => {
    synthesizedTexts.push(text);
    return new Blob([text], { type: 'audio/wav' });
  };

  const iterator = qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }));

  try {
    await iterator.next();
    const firstAssistantChunk = await iterator.next();
    assert.equal(firstAssistantChunk.value?.text, '这里先给你一个完整的开场说明，把背景、限制和接下来的重点都放在这一句里统一交代清楚。');
    assert.deepEqual(synthesizedTexts, ['这里先给你一个完整的开场说明，把背景、限制和接下来的重点都放在这一句里统一交代清楚。']);

    allowSecondChunk();
    for await (const _chunk of iterator) {
      // consume the rest
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }
});

test('voiceChat can start TTS from a long opening clause before a sentence-ending punctuation arrives', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  const synthesizedTexts: string[] = [];
  let allowSecondChunk!: () => void;
  const secondChunkGate = new Promise<void>((resolve) => {
    allowSecondChunk = resolve;
  });

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '这里先给你一个比较完整的开场说明，先把背景和重点都交代清楚之后，再把整体安排顺一遍，然后把后面的限制条件和执行方式也顺着说明白，方便你先建立整体预期' };
    await secondChunkGate;
    yield { text: '完，然后再继续。' };
  };
  qwenService.synthesize = async (text) => {
    synthesizedTexts.push(text);
    return new Blob([text], { type: 'audio/wav' });
  };

  const iterator = qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }));

  try {
    await iterator.next();
    const firstAssistantChunk = await iterator.next();
    assert.equal(firstAssistantChunk.value?.text, '这里先给你一个比较完整的开场说明，先把背景和重点都交代清楚之后，再把整体安排顺一遍，然后把后面的限制条件和执行方式也顺着说明白，方便你先建立整体预期');
    assert.deepEqual(synthesizedTexts, ['这里先给你一个比较完整的开场说明，先把背景和重点都交代清楚之后，再把整体安排顺一遍，然后把后面的限制条件和执行方式也顺着说明白，']);

    allowSecondChunk();
    for await (const _chunk of iterator) {
      // consume the rest
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }
});

test('voiceChat can start TTS from the first comma pause after the opening clause becomes long enough', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  const synthesizedTexts: string[] = [];
  let allowThirdChunk!: () => void;
  const thirdChunkGate = new Promise<void>((resolve) => {
    allowThirdChunk = resolve;
  });

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '在北京生活得久了以后你会慢慢发现这里的四季变化其实相当明显，尤其是每个季节里的风、光线和空气质感都会跟着变化，' };
    yield { text: '尤其是春天短暂而珍贵，很多人还没来得及适应它就已经过去了，' };
    await thirdChunkGate;
    yield { text: '通常从三月持续到五月。' };
  };
  qwenService.synthesize = async (text) => {
    synthesizedTexts.push(text);
    return new Blob([text], { type: 'audio/wav' });
  };

  const iterator = qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }));

  try {
    await iterator.next();
    await iterator.next();
    assert.deepEqual(synthesizedTexts, ['在北京生活得久了以后你会慢慢发现这里的四季变化其实相当明显，尤其是每个季节里的风、光线和空气质感都会跟着变化，']);

    allowThirdChunk();
    for await (const _chunk of iterator) {
      // consume the rest
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }
});

test('voiceChat keeps the first English segment until it reaches at least 80 characters', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  const synthesizedTexts: string[] = [];

  qwenService.transcribe = async () => 'hello';
  qwenService.chat = async function* () {
    yield { text: 'Welcome.' };
    yield { text: ' Let me give you a fuller opening explanation before the first spoken segment is allowed to break.' };
    yield { done: true };
  };
  qwenService.synthesize = async (text) => {
    synthesizedTexts.push(text);
    return new Blob([text], { type: 'audio/wav' });
  };

  try {
    for await (const _chunk of qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }))) {
      // consume stream
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }

  assert.equal(
    synthesizedTexts.join(' ').replace(/\s+/g, ' ').trim(),
    'Welcome. Let me give you a fuller opening explanation before the first spoken segment is allowed to break.',
  );
  assert.ok(synthesizedTexts[0].length >= 80);
});

test('voiceChat emits audio in segment order even when later syntheses would resolve faster', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  let resolveFirstSegment: ((blob: Blob) => void) | null = null;
  const emittedAudioTexts: string[] = [];
  let allowSecondChunk!: () => void;
  const secondChunkGate = new Promise<void>((resolve) => {
    allowSecondChunk = resolve;
  });

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '这是第一句，而且足够长，会先把背景、限制和后面的重点都交代清楚，所以它应该单独先开始合成。' };
    await secondChunkGate;
    yield { text: '这是第二句，也会形成独立的后续音频。' };
    yield { done: true };
  };
  qwenService.synthesize = async (text) => {
    if (text === '这是第一句，而且足够长，会先把背景、限制和后面的重点都交代清楚，所以它应该单独先开始合成。') {
      return await new Promise<Blob>((resolve) => {
        resolveFirstSegment = resolve;
      });
    }

    return new Blob([text], { type: 'audio/wav' });
  };

  const iterator = qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }));

  try {
    const userChunk = await iterator.next();
    assert.match(userChunk.value?.text ?? '', /^\[用户\]:/);
    const firstAssistantChunk = await iterator.next();
    assert.equal(firstAssistantChunk.value?.text, '这是第一句，而且足够长，会先把背景、限制和后面的重点都交代清楚，所以它应该单独先开始合成。');

    allowSecondChunk();
    setTimeout(() => {
      resolveFirstSegment?.(new Blob(['这是第一句，而且足够长，会先把背景、限制和后面的重点都交代清楚，所以它应该单独先开始合成。'], { type: 'audio/wav' }));
    }, 20);

    for await (const chunk of iterator) {
      if (!chunk.audio) continue;
      emittedAudioTexts.push(await chunk.audio.text());
    }
  } finally {
    resolveFirstSegment?.(new Blob(['这是第一句，而且足够长，会先把背景、限制和后面的重点都交代清楚，所以它应该单独先开始合成。'], { type: 'audio/wav' }));
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }

  assert.deepEqual(emittedAudioTexts, [
    '这是第一句，而且足够长，会先把背景、限制和后面的重点都交代清楚，所以它应该单独先开始合成。',
    '这是第二句，也会形成独立的后续音频。',
  ]);
});
