import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { JSDOM } from 'jsdom';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';

import { VoiceChat } from '../src/components/VoiceChat.tsx';
import { qwenService } from '../src/services/qwenService.ts';

setupDom();

type WarmupCapableQwenService = typeof qwenService & {
  warmupChat?: () => Promise<void>;
  textChat?: (
    userText: string,
    history?: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    voice?: string,
    language?: string,
    think?: boolean,
  ) => AsyncGenerator<{ text?: string; audio?: Blob; done?: boolean }>;
};

const originalVoiceChat = qwenService.voiceChat;
const originalTextChat = (qwenService as WarmupCapableQwenService).textChat;
const originalWarmupChat = (qwenService as WarmupCapableQwenService).warmupChat;
const originalGetUserMedia = navigator.mediaDevices?.getUserMedia;
const OriginalMediaRecorder = globalThis.MediaRecorder;
const originalPlay = HTMLMediaElement.prototype.play;
const originalPause = HTMLMediaElement.prototype.pause;
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
const originalDateNow = Date.now;

function setupDom() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/',
  });

  Object.defineProperty(globalThis, 'window', { configurable: true, value: dom.window });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: dom.window.document });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
  Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: dom.window.HTMLElement });
  Object.defineProperty(globalThis, 'HTMLAudioElement', { configurable: true, value: dom.window.HTMLAudioElement });
  Object.defineProperty(globalThis, 'HTMLMediaElement', { configurable: true, value: dom.window.HTMLMediaElement });
  Object.defineProperty(globalThis, 'Event', { configurable: true, value: dom.window.Event });
  Object.defineProperty(globalThis, 'PointerEvent', {
    configurable: true,
    value: dom.window.PointerEvent ?? dom.window.MouseEvent,
  });
  Object.defineProperty(globalThis, 'React', { configurable: true, value: React });
}

class FakeMediaRecorder {
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;

  start() {}

  stop() {
    this.ondataavailable?.({
      data: new Blob(['recorded-audio'.repeat(128)], { type: 'audio/webm;codecs=opus' }),
    });
    queueMicrotask(() => {
      this.onstop?.();
    });
  }
}

function installBrowserStubs() {
  setupDom();
  (qwenService as WarmupCapableQwenService).warmupChat = async () => {};

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getTracks: () => [{ stop() {} }],
      }),
    },
  });

  globalThis.MediaRecorder = FakeMediaRecorder as unknown as typeof MediaRecorder;
  globalThis.HTMLElement.prototype.scrollIntoView = () => {};
  HTMLMediaElement.prototype.play = () => Promise.resolve();
  HTMLMediaElement.prototype.pause = () => {};
  URL.createObjectURL = () => 'blob:test-audio';
  URL.revokeObjectURL = () => {};
}

function setTextareaValue(element: HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  );
  descriptor?.set?.call(element, value);
  fireEvent.input(element, { target: { value } });
  fireEvent.change(element, { target: { value } });
}

afterEach(() => {
  cleanup();
  qwenService.voiceChat = originalVoiceChat;
  (qwenService as WarmupCapableQwenService).textChat = originalTextChat;
  (qwenService as WarmupCapableQwenService).warmupChat = originalWarmupChat;
  Date.now = originalDateNow;

  if (originalGetUserMedia) {
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: originalGetUserMedia },
    });
  }

  globalThis.MediaRecorder = OriginalMediaRecorder;
  HTMLMediaElement.prototype.play = originalPlay;
  HTMLMediaElement.prototype.pause = originalPause;
  URL.createObjectURL = originalCreateObjectUrl;
  URL.revokeObjectURL = originalRevokeObjectUrl;
});

test('press and release sends recorded audio for processing', async () => {
  installBrowserStubs();

  let processedBlob: Blob | null = null;
  qwenService.voiceChat = async function* (audioBlob) {
    processedBlob = audioBlob;
    yield { done: true };
  };
  let now = 1_000;
  Date.now = () => now;

  const view = render(<VoiceChat />);

  const button = view.getByRole('button', { name: /说话|Hold to talk|押して話す/i });
  fireEvent.pointerDown(button);
  now += 400;
  fireEvent.pointerUp(button);

  await waitFor(() => {
    assert.ok(processedBlob instanceof Blob);
  });
});

test('holding the space key also sends recorded audio in voice mode', async () => {
  installBrowserStubs();

  let processedBlob: Blob | null = null;
  qwenService.voiceChat = async function* (audioBlob) {
    processedBlob = audioBlob;
    yield { done: true };
  };

  let now = 1_500;
  Date.now = () => now;

  render(<VoiceChat />);

  fireEvent.keyDown(window, { key: ' ', code: 'Space', keyCode: 32 });
  now += 400;
  fireEvent.keyUp(window, { key: ' ', code: 'Space', keyCode: 32 });

  await waitFor(() => {
    assert.ok(processedBlob instanceof Blob);
  });
});

test('shows the ASR user message before assistant generation finishes', async () => {
  installBrowserStubs();

  let releaseAssistantText!: () => void;
  const assistantTextReady = new Promise<void>((resolve) => {
    releaseAssistantText = resolve;
  });

  qwenService.voiceChat = async function* () {
    yield { text: '[用户]: Hello there' };
    await assistantTextReady;
    yield { text: 'Hi, how can I help?' };
    yield { done: true };
  };
  let now = 2_000;
  Date.now = () => now;

  const view = render(<VoiceChat />);

  const button = view.getByRole('button', { name: /说话|Hold to talk|押して話す/i });
  fireEvent.pointerDown(button);
  now += 400;
  fireEvent.pointerUp(button);

  await waitFor(() => {
    assert.ok(view.getByText('🎤 Hello there'));
  });

  assert.equal(view.queryByText('Hi, how can I help?'), null);

  releaseAssistantText();

  await waitFor(() => {
    assert.ok(view.getByText('Hi, how can I help?'));
  });
});

test('very short press does not send audio and shows a short-recording hint', async () => {
  installBrowserStubs();

  let processed = false;
  qwenService.voiceChat = async function* () {
    processed = true;
    yield { done: true };
  };

  let now = 1_000;
  Date.now = () => now;

  const view = render(<VoiceChat />);

  const button = view.getByRole('button', { name: /说话|Hold to talk|押して話す/i });
  fireEvent.pointerDown(button);
  now += 120;
  fireEvent.pointerUp(button);

  await waitFor(() => {
    assert.ok(view.getByText(/说话太短/i));
  });

  assert.equal(processed, false);
});

test('shows a clear hint when the browser does not expose microphone APIs', async () => {
  installBrowserStubs();

  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: undefined,
  });

  let processed = false;
  qwenService.voiceChat = async function* () {
    processed = true;
    yield { done: true };
  };

  const view = render(<VoiceChat />);
  const button = view.getByRole('button', { name: /说话|Hold to talk|押して話す/i });
  fireEvent.pointerDown(button);

  await waitFor(() => {
    assert.ok(view.getByText(/无法访问麦克风/i));
  });

  assert.equal(processed, false);
});

test('starts a background warmup request when the chat mounts', async () => {
  installBrowserStubs();

  const warmupCalls: boolean[] = [];
  (qwenService as WarmupCapableQwenService).warmupChat = async (think = false) => {
    warmupCalls.push(think);
  };

  const view = render(<VoiceChat />);

  await waitFor(() => {
    assert.deepEqual(warmupCalls, [false]);
  });

  fireEvent.click(view.getByRole('checkbox', { name: /深度思考|Reasoning|深く考える/i }));

  await waitFor(() => {
    assert.deepEqual(warmupCalls, [false, true]);
  });
});

test('passes the reasoning toggle state into voice chat requests', async () => {
  installBrowserStubs();

  let thinkValue: boolean | null = null;
  qwenService.voiceChat = async function* (_audioBlob, _history, _voice, _language, think) {
    thinkValue = think ?? null;
    yield { done: true };
  };

  let now = 4_000;
  Date.now = () => now;

  const view = render(<VoiceChat />);
  fireEvent.click(view.getByRole('checkbox', { name: /深度思考|Reasoning|深く考える/i }));

  const button = view.getByRole('button', { name: /说话|Hold to talk|押して話す/i });
  fireEvent.pointerDown(button);
  now += 400;
  fireEvent.pointerUp(button);

  await waitFor(() => {
    assert.equal(thinkValue, true);
  });
});

test('shows the concrete backend error when voice chat fails', async () => {
  installBrowserStubs();

  qwenService.voiceChat = async function* () {
    throw new Error('模型只返回了思考过程，没有返回正文内容');
  };

  let now = 5_000;
  Date.now = () => now;

  const view = render(<VoiceChat />);

  const button = view.getByRole('button', { name: /说话/i });
  fireEvent.pointerDown(button);
  now += 400;
  fireEvent.pointerUp(button);

  await waitFor(() => {
    assert.ok(view.getByText('模型只返回了思考过程，没有返回正文内容'));
  });
});

test('shows a replay button under the assistant message and replays the last audio', async () => {
  installBrowserStubs();

  let objectUrlCalls = 0;
  URL.createObjectURL = () => {
    objectUrlCalls += 1;
    return `blob:test-audio-${objectUrlCalls}`;
  };

  qwenService.voiceChat = async function* () {
    yield { text: '[用户]: Hello there' };
    yield { text: 'Hi, how can I help?' };
    yield { audio: new Blob(['assistant-audio'], { type: 'audio/wav' }) };
    yield { done: true };
  };

  let now = 3_000;
  Date.now = () => now;

  const view = render(<VoiceChat />);

  const button = view.getByRole('button', { name: /说话/i });
  fireEvent.pointerDown(button);
  now += 400;
  fireEvent.pointerUp(button);

  await waitFor(() => {
    assert.ok(view.getByText('Hi, how can I help?'));
  });

  const replayButton = await waitFor(() => view.getByRole('button', { name: /重播语音|Replay audio|音声を再生/i }));
  assert.equal(objectUrlCalls, 1);

  fireEvent.click(replayButton);

  await waitFor(() => {
    assert.equal(objectUrlCalls, 2);
  });
});

test('can switch to keyboard mode and send a text prompt', async () => {
  installBrowserStubs();

  const textChatCalls: Array<{ text: string; think: boolean | undefined }> = [];
  (qwenService as WarmupCapableQwenService).textChat = async function* (text, _history, _voice, _language, think) {
    textChatCalls.push({ text, think });
    yield { text: `[用户]: ${text}` };
    yield { text: '键盘输入的回答。' };
    yield { audio: new Blob(['assistant-audio'], { type: 'audio/wav' }) };
    yield { done: true };
  };

  const view = render(<VoiceChat />);

  fireEvent.click(view.getByRole('button', { name: /切换到键盘输入|Switch to keyboard input|キーボード入力に切り替え/i }));
  const textArea = view.getByPlaceholderText(/输入想问的问题|Type your question|質問を入力/) as HTMLTextAreaElement;
  setTextareaValue(textArea, 'Open Cloud Asia 是什么？');
  await waitFor(() => {
    assert.equal(textArea.value, 'Open Cloud Asia 是什么？');
  });
  const sendButton = view.getByRole('button', { name: /发送文本消息|Send text message|テキストメッセージを送信/i }) as HTMLButtonElement;
  await waitFor(() => {
    assert.equal(sendButton.disabled, false);
  });
  fireEvent.click(sendButton);

  await waitFor(() => {
    assert.ok(view.getByText('⌨️ Open Cloud Asia 是什么？'));
  });

  await waitFor(() => {
    assert.ok(view.getByText('键盘输入的回答。'));
  });

  assert.deepEqual(textChatCalls, [
    { text: 'Open Cloud Asia 是什么？', think: false },
  ]);
});

test('keyboard mode send button respects the reasoning toggle', async () => {
  installBrowserStubs();

  let thinkValue: boolean | undefined;
  (qwenService as WarmupCapableQwenService).textChat = async function* (_text, _history, _voice, _language, think) {
    thinkValue = think;
    yield { text: '[用户]: 测试键盘输入' };
    yield { text: '好的。' };
    yield { done: true };
  };

  const view = render(<VoiceChat />);

  fireEvent.click(view.getByRole('checkbox', { name: /深度思考|Reasoning|深く考える/i }));
  fireEvent.click(view.getByRole('button', { name: /切换到键盘输入|Switch to keyboard input|キーボード入力に切り替え/i }));
  const textArea = view.getByPlaceholderText(/输入想问的问题|Type your question|質問を入力/) as HTMLTextAreaElement;
  setTextareaValue(textArea, '测试键盘输入');
  await waitFor(() => {
    assert.equal(textArea.value, '测试键盘输入');
  });
  const sendButton = view.getByRole('button', { name: /发送文本消息|Send text message|テキストメッセージを送信/i }) as HTMLButtonElement;
  await waitFor(() => {
    assert.equal(sendButton.disabled, false);
  });
  fireEvent.click(sendButton);

  await waitFor(() => {
    assert.equal(thinkValue, true);
  });
});

test('enter does not send while IME composition is active', async () => {
  installBrowserStubs();

  let called = false;
  (qwenService as WarmupCapableQwenService).textChat = async function* () {
    called = true;
    yield { done: true };
  };

  const view = render(<VoiceChat />);

  fireEvent.click(view.getByRole('button', { name: /切换到键盘输入|Switch to keyboard input|キーボード入力に切り替え/i }));
  const textArea = view.getByPlaceholderText(/输入想问的问题|Type your question|質問を入力/) as HTMLTextAreaElement;
  setTextareaValue(textArea, '中文输入');

  fireEvent.compositionStart(textArea);
  fireEvent.keyDown(textArea, {
    key: 'Enter',
    code: 'Enter',
    nativeEvent: { isComposing: true, keyCode: 229 },
  });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(called, false);
});

test('space key does not start recording while keyboard input mode is active', async () => {
  installBrowserStubs();

  let processed = false;
  qwenService.voiceChat = async function* () {
    processed = true;
    yield { done: true };
  };

  const view = render(<VoiceChat />);

  fireEvent.click(view.getByRole('button', { name: /切换到键盘输入|Switch to keyboard input|キーボード入力に切り替え/i }));
  fireEvent.keyDown(window, { key: ' ', code: 'Space', keyCode: 32 });
  fireEvent.keyUp(window, { key: ' ', code: 'Space', keyCode: 32 });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(processed, false);
});

test('can switch the UI language to English', async () => {
  installBrowserStubs();

  const view = render(<VoiceChat />);

  fireEvent.click(view.getByRole('button', { name: /设置|Settings|設定/i }));
  fireEvent.change(view.getByRole('combobox', { name: /语言|Language|言語/i }), {
    target: { value: 'en' },
  });

  await waitFor(() => {
    assert.ok(view.getByText('Reasoning'));
  });

  fireEvent.click(view.getByRole('button', { name: /Switch to keyboard input/i }));
  assert.ok(view.getByPlaceholderText(/Type your question and press send to start/i));
});

test('can switch the UI language to Japanese', async () => {
  installBrowserStubs();

  const view = render(<VoiceChat />);

  fireEvent.click(view.getByRole('button', { name: /设置|Settings|設定/i }));
  fireEvent.change(view.getByRole('combobox', { name: /语言|Language|言語/i }), {
    target: { value: 'ja' },
  });

  await waitFor(() => {
    assert.ok(view.getByText('深く考える'));
  });

  fireEvent.click(view.getByRole('button', { name: /キーボード入力に切り替え/i }));
  assert.ok(view.getByPlaceholderText(/質問を入力して送信すると会話が始まります/i));
});

test('switching language also switches the default voice', async () => {
  installBrowserStubs();

  const view = render(<VoiceChat />);

  fireEvent.click(view.getByRole('button', { name: /设置|Settings|設定/i }));
  const selects = view.getAllByRole('combobox');
  const languageSelect = selects[0] as HTMLSelectElement;
  const voiceSelect = selects[1] as HTMLSelectElement;

  assert.equal(voiceSelect.value, 'Vivian');

  fireEvent.change(languageSelect, { target: { value: 'en' } });
  await waitFor(() => {
    assert.equal(voiceSelect.value, 'Ryan');
  });

  fireEvent.change(languageSelect, { target: { value: 'ja' } });
  await waitFor(() => {
    assert.equal(voiceSelect.value, 'Ono_anna');
  });

  fireEvent.change(languageSelect, { target: { value: 'zh' } });
  await waitFor(() => {
    assert.equal(voiceSelect.value, 'Vivian');
  });
});
