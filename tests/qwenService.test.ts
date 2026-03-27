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
