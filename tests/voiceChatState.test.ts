import test from 'node:test';
import assert from 'node:assert/strict';

import { getCurrentResponseAfterAssistantCommit } from '../src/components/voiceChatState.ts';

test('clears transient assistant text after the final message is committed', () => {
  assert.equal(
    getCurrentResponseAfterAssistantCommit('哈囉！你好呀！我在呢，有什麼想問或需要幫忙的嗎？'),
    '',
  );
});

test('keeps current response unchanged when there is no committed assistant text', () => {
  assert.equal(getCurrentResponseAfterAssistantCommit(''), '');
});
