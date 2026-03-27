import test from 'node:test';
import assert from 'node:assert/strict';

import { qwenService } from '../src/services/qwenService.ts';

test('chat sends an explicit reply-in-user-language system instruction', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        text: 'ok',
        sessionId: 'session-1',
      }),
      {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  try {
    await qwenService.chat('Bonjour, comment ca va ?').next();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBody?.userText, 'Bonjour, comment ca va ?');
  assert.match(String(requestBody?.systemPrompt ?? ''), /currently wants/i);
  assert.match(String(requestBody?.systemPrompt ?? ''), /latest message/i);
  assert.equal(requestBody?.think, false);
  assert.match(String(requestBody?.sessionId ?? ''), /^voice-chat-/);
});

test('synthesize sends stable custom-voice controls for calmer playback', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));

    return new Response(new Blob(['wav'], { type: 'audio/wav' }), {
      status: 200,
      headers: { 'Content-Type': 'audio/wav' },
    });
  };

  try {
    await qwenService.synthesize('你好，今天怎么样？', 'Vivian');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBody?.task_type, 'CustomVoice');
  assert.equal(requestBody?.language, 'Chinese');
  assert.equal(requestBody?.speed, 1);
  assert.equal(requestBody?.do_sample, false);
  assert.equal(requestBody?.temperature, 0.5);
  assert.equal(requestBody?.top_k, 10);
  assert.equal(requestBody?.top_p, 0.8);
  assert.equal(requestBody?.repetition_penalty, 1.05);
  assert.equal(
    String(requestBody?.instructions ?? ''),
    '用默认的音调，新闻联播的口吻，不带任何的情绪',
  );
});

test('chat can opt into reasoning when explicitly enabled', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (_input, init) => {
    requestBody = JSON.parse(String(init?.body));

    return new Response(
      JSON.stringify({
        text: 'ok',
        sessionId: 'session-think',
      }),
      {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  try {
    await qwenService.chat('Hi', [], { think: true }).next();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBody?.think, true);
});

test('chat throws a clear error when OpenClaw returns no text', async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      text: '',
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );

  try {
    await assert.rejects(
      async () => {
        for await (const _chunk of qwenService.chat('Hi')) {
          // Exhaust the stream to trigger the terminal validation.
        }
      },
      /OpenClaw .*正文内容|没有返回任何正文内容/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('chat keeps local history while the bridge can return a fresh OpenClaw session id', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/openclaw-api/agent')) {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          text: `reply-${requestBodies.length}`,
          sessionId: 'session-reused',
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await qwenService.chat('第一句').next();
    await qwenService.chat('第二句', [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: 'reply-1' },
    ]).next();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBodies.length, 2);
  assert.match(String(requestBodies[0]?.sessionId ?? ''), /^voice-chat-/);
  assert.equal(requestBodies[1]?.sessionId, 'session-reused');
  assert.deepEqual(requestBodies[1]?.history, [
    { role: 'user', content: '第一句' },
    { role: 'assistant', content: 'reply-1' },
  ]);
});

test('chat starts a fresh local bridge session when local history is cleared', async () => {
  const originalFetch = globalThis.fetch;
  const requestBodies: Array<Record<string, unknown>> = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/openclaw-api/agent')) {
      requestBodies.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          text: `reply-${requestBodies.length}`,
          sessionId: `session-${requestBodies.length}`,
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    await qwenService.chat('第一轮').next();
    await qwenService.chat('第二轮', []).next();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBodies.length, 2);
  assert.notEqual(requestBodies[0]?.sessionId, requestBodies[1]?.sessionId);
});

test('warmupChat calls the OpenClaw warmup endpoint', async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    requestedUrls.push(url);

    if (url.includes('/openclaw-api/warmup')) {
      assert.equal(JSON.parse(String(init?.body)).think, true);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    throw new Error(`Unexpected URL: ${url} body=${String(init?.body ?? '')}`);
  };

  try {
    await qwenService.warmupChat(true);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requestedUrls, ['/openclaw-api/warmup']);
});

test('synthesize returns null when the local TTS sidecar merges the segment into an earlier request', async () => {
  const originalFetch = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;

  globalThis.fetch = async (input, init) => {
    assert.match(String(input), /\/tts-sidecar-api\/audio\/segment-speech$/);
    requestBody = JSON.parse(String(init?.body));

    return new Response(JSON.stringify({ merged: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const result = await qwenService.synthesize('你好', {
      voice: 'Vivian',
      language: 'Chinese',
      sessionId: 'session-1',
    });
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requestBody?.do_sample, false);
  assert.equal(requestBody?.temperature, 0.5);
  assert.equal(requestBody?.top_k, 10);
  assert.equal(requestBody?.top_p, 0.8);
  assert.equal(requestBody?.repetition_penalty, 1.05);
});

test('synthesize skips direct TTS requests when the input is empty', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  globalThis.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  };

  try {
    const result = await qwenService.synthesize('   ', 'Vivian');
    assert.equal(result, null);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(fetchCalled, false);
});

test('synthesize falls back to the direct TTS endpoint when the local sidecar is unavailable', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);

    if (url.endsWith('/tts-sidecar-api/audio/segment-speech')) {
      return new Response('missing', { status: 404 });
    }

    if (url.endsWith('/tts-api/audio/speech')) {
      return new Response(new Blob(['wav'], { type: 'audio/wav' }), {
        status: 200,
        headers: { 'Content-Type': 'audio/wav' },
      });
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const result = await qwenService.synthesize('你好', {
      voice: 'Vivian',
      language: 'Chinese',
      sessionId: 'session-1',
      flush: true,
    });
    assert.ok(result instanceof Blob);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, [
    '/tts-sidecar-api/audio/segment-speech',
    '/tts-api/audio/speech',
  ]);
});

test('voiceChat strips leading assistant labels like Response or 中文回答', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesize = qwenService.synthesize;

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '**中文回答：**' };
    yield { text: '哈喽！' };
    yield { text: ' 有什么可以帮你的吗？' };
    yield { done: true };
  };
  qwenService.synthesize = async (text) => new Blob([text], { type: 'audio/wav' });

  const assistantChunks: string[] = [];

  try {
    for await (const chunk of qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }))) {
      if (chunk.text && !chunk.text.startsWith('[用户]:')) {
        assistantChunks.push(chunk.text);
      }
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    qwenService.synthesize = originalSynthesize;
  }

  assert.deepEqual(assistantChunks, ['哈喽！', ' 有什么可以帮你的吗？']);
});

test('voiceChat sends the first streamed TTS segment with higher sidecar priority and immediate flush', async () => {
  const originalFetch = globalThis.fetch;
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;

  const priorities: number[] = [];
  const flushes: boolean[] = [];
  let allowSecondChunk!: () => void;
  const secondChunkGate = new Promise<void>((resolve) => {
    allowSecondChunk = resolve;
  });

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '第一句已经足够长，而且会把背景、限制和接下来的安排都先交代清楚，这样现在就可以开始播报了。' };
    await secondChunkGate;
    yield { text: '第二句也已经准备好了。' };
  };

  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (!url.endsWith('/tts-sidecar-api/audio/segment-speech')) {
      throw new Error(`Unexpected URL: ${url}`);
    }

    const body = JSON.parse(String(init?.body));
    if (String(body.input ?? '').trim()) {
      priorities.push(body.priority ?? 1);
      flushes.push(Boolean(body.flush));
    }

    return new Response(JSON.stringify({ merged: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const iterator = qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }));

  try {
    await iterator.next();
    await iterator.next();
    assert.deepEqual(priorities, [0]);
    assert.deepEqual(flushes, [true]);

    allowSecondChunk();
    for await (const _chunk of iterator) {
      // consume the rest
    }
  } finally {
    globalThis.fetch = originalFetch;
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
  }

  assert.deepEqual(priorities, [0, 1]);
  assert.deepEqual(flushes, [true, true]);
});
