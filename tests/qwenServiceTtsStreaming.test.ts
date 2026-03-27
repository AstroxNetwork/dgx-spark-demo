import test from 'node:test';
import assert from 'node:assert/strict';

import { qwenService } from '../src/services/qwenService.ts';

test('voiceChat streams assistant text first and requests one streaming TTS pass for the full reply', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesizeStreaming = (qwenService as unknown as {
    synthesizeStreaming: (text: string, options?: unknown) => Promise<unknown>;
  }).synthesizeStreaming;

  const synthesizedTexts: string[] = [];
  let releaseStreamingAudio = false;

  qwenService.transcribe = async () => '你好';
  qwenService.chat = async function* () {
    yield { text: '第一句。' };
    yield { text: '第二句，继续完成！' };
    yield { done: true };
  };
  (qwenService as unknown as {
    synthesizeStreaming: (text: string, options?: unknown) => Promise<unknown>;
  }).synthesizeStreaming = async (text) => {
    synthesizedTexts.push(text);
    while (!releaseStreamingAudio) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          controller.close();
        },
      }),
      format: 'pcm_s16le',
      sampleRate: 24000,
      channels: 1,
    };
  };

  const events: Array<'text' | 'audioStream' | 'done'> = [];
  const iterator = qwenService.voiceChat(new Blob(['wav'], { type: 'audio/wav' }));

  try {
    const first = await iterator.next();
    assert.equal(first.value?.text, '[用户]: 你好\n\n');
    events.push('text');

    const second = await iterator.next();
    assert.equal(second.value?.text, '第一句。');
    events.push('text');

    const third = await iterator.next();
    assert.equal(third.value?.text, '第二句，继续完成！');
    events.push('text');

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(synthesizedTexts, ['第一句。第二句，继续完成！']);

    releaseStreamingAudio = true;

    const audioChunk = await iterator.next();
    assert.ok(audioChunk.value?.audioStream);
    events.push('audioStream');

    const doneChunk = await iterator.next();
    assert.equal(doneChunk.value?.done, true);
    events.push('done');
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    (qwenService as unknown as {
      synthesizeStreaming: (text: string, options?: unknown) => Promise<unknown>;
    }).synthesizeStreaming = originalSynthesizeStreaming;
    await iterator.return?.();
  }

  assert.deepEqual(events, ['text', 'text', 'text', 'audioStream', 'done']);
});

test('voiceChat keeps the same voice and language profile for the streaming TTS pass', async () => {
  const originalTranscribe = qwenService.transcribe;
  const originalChat = qwenService.chat;
  const originalSynthesizeStreaming = (qwenService as unknown as {
    synthesizeStreaming: (text: string, options?: unknown) => Promise<unknown>;
  }).synthesizeStreaming;

  const synthesizedRequests: Array<{
    text: string;
    language: string | undefined;
    voice: string | undefined;
  }> = [];

  qwenService.transcribe = async () => 'hello';
  qwenService.chat = async function* () {
    yield { text: 'Welcome. ' };
    yield { text: 'This is the complete reply.' };
    yield { done: true };
  };
  (qwenService as unknown as {
    synthesizeStreaming: (text: string, options?: unknown) => Promise<unknown>;
  }).synthesizeStreaming = async (text, options) => {
    const normalizedOptions = typeof options === 'string' ? { voice: options } : options as {
      language?: string;
      voice?: string;
    };
    synthesizedRequests.push({
      text,
      language: normalizedOptions?.language,
      voice: normalizedOptions?.voice,
    });
    return {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.close();
        },
      }),
      format: 'pcm_s16le',
      sampleRate: 24000,
      channels: 1,
    };
  };

  try {
    for await (const _chunk of qwenService.voiceChat(
      new Blob(['wav'], { type: 'audio/wav' }),
      [],
      'Ryan',
      'en',
      false,
    )) {
      // consume stream
    }
  } finally {
    qwenService.transcribe = originalTranscribe;
    qwenService.chat = originalChat;
    (qwenService as unknown as {
      synthesizeStreaming: (text: string, options?: unknown) => Promise<unknown>;
    }).synthesizeStreaming = originalSynthesizeStreaming;
  }

  assert.deepEqual(synthesizedRequests, [
    {
      text: 'Welcome. This is the complete reply.',
      voice: 'Ryan',
      language: 'English',
    },
  ]);
});
