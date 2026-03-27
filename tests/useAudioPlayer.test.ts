import test from 'node:test';
import assert from 'node:assert/strict';

import { createAudioPlaybackItem } from '../src/hooks/useAudioPlayer.ts';

test('createAudioPlaybackItem creates and revokes object urls for blobs', () => {
  const audioBlob = new Blob(['wav-audio'], { type: 'audio/wav' });

  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const revoked: string[] = [];

  URL.createObjectURL = () => 'blob:mock-audio-url';
  URL.revokeObjectURL = (url: string | URL) => {
    revoked.push(String(url));
  };

  try {
    const item = createAudioPlaybackItem(audioBlob);
    assert.equal(item.src, 'blob:mock-audio-url');

    item.cleanup?.();
    assert.deepEqual(revoked, ['blob:mock-audio-url']);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
