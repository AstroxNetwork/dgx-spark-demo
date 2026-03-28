import test from 'node:test';
import assert from 'node:assert/strict';

import { qwenService } from '../src/services/qwenService.ts';

test('transcribe converts non-wav recordings before upload', async () => {
  const sourceBlob = new Blob(['webm-audio'], { type: 'audio/webm;codecs=opus' });
  const convertedBlob = new Blob(['wav-audio'], { type: 'audio/wav' });

  const originalConvertToWav = qwenService.convertToWav;
  const originalFetch = globalThis.fetch;

  qwenService.convertToWav = async () => convertedBlob;

  globalThis.fetch = async (_input, init) => {
    assert.ok(init?.body instanceof FormData);

    const uploadedFile = init.body.get('file');
    assert.ok(uploadedFile instanceof Blob);
    assert.equal(uploadedFile.type, 'audio/wav');
    assert.deepEqual(
      new Uint8Array(await uploadedFile.arrayBuffer()),
      new Uint8Array(await convertedBlob.arrayBuffer()),
    );

    return new Response(JSON.stringify({ text: 'ok' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const transcript = await qwenService.transcribe(sourceBlob);
    assert.equal(transcript, 'ok');
  } finally {
    qwenService.convertToWav = originalConvertToWav;
    globalThis.fetch = originalFetch;
  }
});

test('transcribe normalizes demo-specific brand terms from ASR output', async () => {
  const sourceBlob = new Blob(['wav-audio'], { type: 'audio/wav' });
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => new Response(
    JSON.stringify({
      text: 'opencl、open claw、opencore、open core、Open Cloud、opencloud，local claw one box，open viking，还有 dgx spark',
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );

  try {
    const transcript = await qwenService.transcribe(sourceBlob);
    assert.equal(
      transcript,
      'OpenClaw、OpenClaw、OpenClaw、OpenClaw、OpenClaw、OpenClaw，LocalClaw OneBox，OpenViking，还有 DGX Spark',
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('textChat normalizes demo-specific brand terms before sending them to chat', async () => {
  const originalChat = qwenService.chat;
  const capturedUserTexts: string[] = [];

  qwenService.chat = async function* (userText) {
    capturedUserTexts.push(userText);
    yield { done: true };
  };

  try {
    const chunks: string[] = [];
    for await (const chunk of qwenService.textChat('我要查看open core、OpenCL 和 Open Cloud 的文档。')) {
      if (chunk.text) chunks.push(chunk.text);
    }

    assert.equal(capturedUserTexts[0], '我要查看OpenClaw、OpenClaw 和 OpenClaw 的文档。');
    assert.ok(chunks[0]?.includes('OpenClaw'));
  } finally {
    qwenService.chat = originalChat;
  }
});
