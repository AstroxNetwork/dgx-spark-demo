import { useState, useRef, useCallback, useEffect, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { useAudioRecorder } from '../hooks/useAudioRecorder';
import { useAudioPlayer } from '../hooks/useAudioPlayer';
import { qwenService } from '../services/qwenService';
import { AVAILABLE_VOICES } from '../config';
import type { ChatMessage, InputMode, VoiceType } from '../types';
import { getCurrentResponseAfterAssistantCommit } from './voiceChatState';

type Locale = 'zh' | 'en' | 'ja';

const DEFAULT_VOICE_BY_LOCALE: Record<Locale, VoiceType> = {
  zh: 'Vivian',
  en: 'Ryan',
  ja: 'Ono_anna',
};

const UI_TEXT: Record<Locale, {
  title: string;
  live: string;
  transcript: string;
  keyboard: string;
  voice: string;
  reasoning: string;
  settings: string;
  clear: string;
  replay: string;
  welcomeVoice: string;
  welcomeText: string;
  warmupHint: string;
  attachment: string;
  thinking: string;
  holdToTalk: string;
  releaseToSend: string;
  processing: string;
  mic: string;
  textPlaceholder: string;
  textTip: string;
  send: string;
  sending: string;
  switchToKeyboard: string;
  switchToVoice: string;
  toggleSettings: string;
  talkButton: string;
  sendText: string;
  language: string;
  microphoneUnavailable: string;
  recordingTooShort: string;
  genericProcessingError: string;
}> = {
  zh: {
    title: 'LocalClaw OneBox',
    live: '实时',
    transcript: '文字',
    keyboard: '键盘',
    voice: '语音',
    reasoning: '深度思考',
    settings: '设置',
    clear: '清空',
    replay: '重播语音',
    welcomeVoice: '按住说话，松开发送。',
    welcomeText: '输入问题，直接发送。',
    warmupHint: '首次回复可能会稍慢一点。',
    attachment: '附件内容',
    thinking: '正在思考...',
    holdToTalk: '按住说话',
    releaseToSend: '松开发送',
    processing: '处理中',
    mic: '麦克风',
    textPlaceholder: '输入想问的问题，按发送开始对话',
    textTip: 'Enter 发送，Shift + Enter 换行',
    send: '发送',
    sending: '发送中...',
    switchToKeyboard: '切换到键盘输入',
    switchToVoice: '切换到语音输入',
    toggleSettings: '切换设置面板',
    talkButton: '按住说话',
    sendText: '发送文本消息',
    language: '语言',
    microphoneUnavailable: '当前页面无法访问麦克风。请使用 localhost 或 HTTPS 打开，或者切换到键盘输入。',
    recordingTooShort: '说话太短，请至少按住 0.3 秒',
    genericProcessingError: '处理出错，请重试',
  },
  en: {
    title: 'LocalClaw OneBox',
    live: 'Live',
    transcript: 'Transcript',
    keyboard: 'Keyboard',
    voice: 'Voice',
    reasoning: 'Reasoning',
    settings: 'Settings',
    clear: 'Clear',
    replay: 'Replay audio',
    welcomeVoice: 'Hold to talk, release to send.',
    welcomeText: 'Type your question and send it.',
    warmupHint: 'The first reply may take a little longer.',
    attachment: 'Attachment',
    thinking: 'Thinking...',
    holdToTalk: 'Hold to talk',
    releaseToSend: 'Release to send',
    processing: 'Processing',
    mic: 'Mic',
    textPlaceholder: 'Type your question and press send to start',
    textTip: 'Enter to send, Shift + Enter for a new line',
    send: 'Send',
    sending: 'Sending...',
    switchToKeyboard: 'Switch to keyboard input',
    switchToVoice: 'Switch to voice input',
    toggleSettings: 'Toggle settings panel',
    talkButton: 'Hold to talk',
    sendText: 'Send text message',
    language: 'Language',
    microphoneUnavailable: 'Microphone access is unavailable on this page. Open it with localhost or HTTPS, or switch to keyboard input.',
    recordingTooShort: 'Recording is too short. Hold for at least 0.3 seconds.',
    genericProcessingError: 'Something went wrong. Please try again.',
  },
  ja: {
    title: 'LocalClaw OneBox',
    live: 'ライブ',
    transcript: '文字',
    keyboard: 'キーボード',
    voice: '音声',
    reasoning: '深く考える',
    settings: '設定',
    clear: 'クリア',
    replay: '音声を再生',
    welcomeVoice: '押して話し、離すと送信します。',
    welcomeText: '質問を入力して送信してください。',
    warmupHint: '最初の応答は少し遅いことがあります。',
    attachment: '添付内容',
    thinking: '考え中...',
    holdToTalk: '押して話す',
    releaseToSend: '離して送信',
    processing: '処理中',
    mic: 'マイク',
    textPlaceholder: '質問を入力して送信すると会話が始まります',
    textTip: 'Enterで送信、Shift + Enterで改行',
    send: '送信',
    sending: '送信中...',
    switchToKeyboard: 'キーボード入力に切り替え',
    switchToVoice: '音声入力に切り替え',
    toggleSettings: '設定パネルを切り替え',
    talkButton: '押して話す',
    sendText: 'テキストメッセージを送信',
    language: '言語',
    microphoneUnavailable: 'このページではマイクを利用できません。localhost か HTTPS で開くか、キーボード入力に切り替えてください。',
    recordingTooShort: '録音が短すぎます。0.3秒以上押してください。',
    genericProcessingError: 'エラーが発生しました。もう一度お試しください。',
  },
};

function localizeUiError(error: string | null, locale: Locale): string | null {
  if (!error) return null;
  if (
    error.includes('当前页面无法访问麦克风')
    || error.includes('Microphone access is unavailable')
    || error.includes('このページではマイクを利用できません')
  ) {
    return UI_TEXT[locale].microphoneUnavailable;
  }
  if (
    error.includes('说话太短')
    || error.includes('Recording is too short')
    || error.includes('録音が短すぎます')
  ) {
    return UI_TEXT[locale].recordingTooShort;
  }
  return error;
}

export function VoiceChat() {
  const [locale, setLocale] = useState<Locale>('zh');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isWarmingUp, setIsWarmingUp] = useState(true);
  const [currentResponse, setCurrentResponse] = useState('');
  const [selectedVoice, setSelectedVoice] = useState<VoiceType>(DEFAULT_VOICE_BY_LOCALE.zh);
  const [useReasoning, setUseReasoning] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>('voice');
  const [viewMode, setViewMode] = useState<'orb' | 'transcript'>('orb');
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [textInput, setTextInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const orbPreviewRef = useRef<HTMLDivElement>(null);
  const textInputRef = useRef<HTMLTextAreaElement>(null);
  const isTextComposingRef = useRef(false);
  const isStartingRecordingRef = useRef(false);
  const isStoppingRecordingRef = useRef(false);
  const pendingReleaseActionRef = useRef<'none' | 'send' | 'discard'>('none');
  const isGlobalSpacePressActiveRef = useRef(false);

  const { isRecording, startRecording, stopRecording, error: recordError } = useAudioRecorder();
  const { playAudio, playAudioStream, stopAudio, isPlaying, audioLevel, audioRef } = useAudioPlayer();
  const text = UI_TEXT[locale];
  const localizedRecordError = localizeUiError(recordError, locale);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    setSelectedVoice(DEFAULT_VOICE_BY_LOCALE[locale]);
  }, [locale]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    let isActive = true;

    const warmup = async () => {
      try {
        await qwenService.warmupChat(useReasoning);
      } catch (error) {
        console.warn('Warmup error:', error);
      } finally {
        if (isActive) {
          setIsWarmingUp(false);
        }
      }
    };

    void warmup();

    return () => {
      isActive = false;
    };
  }, [useReasoning]);

  const processAudio = useCallback(async (audioBlob: Blob) => {
    setIsProcessing(true);
    setCurrentResponse('');

    let userText = '';
    let assistantText = '';
    const assistantAudioSegments: Blob[] = [];
    let userMessageAdded = false;

    try {
      // 使用三阶段流程: ASR → Chat → TTS
      for await (const chunk of qwenService.voiceChat(audioBlob, messages, selectedVoice, 'zh', useReasoning)) {
        if (chunk.text) {
          // 区分用户输入和助手回复
          if (chunk.text.startsWith('[用户]:')) {
            userText = chunk.text.replace('[用户]: ', '').trim();
            if (userText && !userMessageAdded) {
              userMessageAdded = true;
              setMessages((prev) => [
                ...prev,
                {
                  role: 'user',
                  content: `🎤 ${userText}`,
                },
              ]);
            }
          } else {
            assistantText += chunk.text;
            setCurrentResponse(assistantText);
          }
        }
        if (chunk.audio) {
          assistantAudioSegments.push(chunk.audio);
          void playAudio(chunk.audio);
        }
        if (chunk.audioStream) {
          void playAudioStream(chunk.audioStream);
        }
      }

      // Add assistant response
      if (assistantText) {
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: assistantText,
          audioSegments: assistantAudioSegments.length > 0 ? [...assistantAudioSegments] : undefined,
        };
        setMessages((prev) => [...prev, assistantMessage]);
        setCurrentResponse(getCurrentResponseAfterAssistantCommit(assistantText));
      }
    } catch (error) {
      console.error('Processing error:', error);
      const errorMessage = error instanceof Error ? error.message : text.genericProcessingError;
      setCurrentResponse(errorMessage);
    } finally {
      setIsProcessing(false);
      setTimeout(scrollToBottom, 100);
    }
  }, [messages, playAudio, playAudioStream, scrollToBottom, selectedVoice, useReasoning]);

  const processText = useCallback(async (userText: string) => {
    const trimmedUserText = userText.trim();
    if (!trimmedUserText) return;

    setIsProcessing(true);
    setCurrentResponse('');

    let assistantText = '';
    const assistantAudioSegments: Blob[] = [];
    let userMessageAdded = false;

    try {
      for await (const chunk of qwenService.textChat(
        trimmedUserText,
        messages,
        selectedVoice,
        'zh',
        useReasoning,
      )) {
        if (chunk.text) {
          if (chunk.text.startsWith('[用户]:')) {
            const sentUserText = chunk.text.replace('[用户]: ', '').trim();
            if (sentUserText && !userMessageAdded) {
              userMessageAdded = true;
              setMessages((prev) => [
                ...prev,
                {
                  role: 'user',
                  content: `⌨️ ${sentUserText}`,
                },
              ]);
            }
          } else {
            assistantText += chunk.text;
            setCurrentResponse(assistantText);
          }
        }
        if (chunk.audio) {
          assistantAudioSegments.push(chunk.audio);
          void playAudio(chunk.audio);
        }
        if (chunk.audioStream) {
          void playAudioStream(chunk.audioStream);
        }
      }

      if (assistantText) {
        const assistantMessage: ChatMessage = {
          role: 'assistant',
          content: assistantText,
          audioSegments: assistantAudioSegments.length > 0 ? [...assistantAudioSegments] : undefined,
        };
        setMessages((prev) => [...prev, assistantMessage]);
        setCurrentResponse(getCurrentResponseAfterAssistantCommit(assistantText));
      }
    } catch (error) {
      console.error('Processing error:', error);
      const errorMessage = error instanceof Error ? error.message : text.genericProcessingError;
      setCurrentResponse(errorMessage);
    } finally {
      setIsProcessing(false);
      setTimeout(scrollToBottom, 100);
    }
  }, [messages, playAudio, playAudioStream, scrollToBottom, selectedVoice, useReasoning]);

  const replayMessageAudio = useCallback(async (message: ChatMessage) => {
    if (!message.audioSegments?.length) return;

    stopAudio();
    for (const segment of message.audioSegments) {
      await playAudio(segment);
    }
  }, [playAudio, stopAudio]);

  const finishRecording = useCallback(async (shouldSend: boolean) => {
    if (isStoppingRecordingRef.current) return;
    isStoppingRecordingRef.current = true;

    try {
      const audioBlob = await stopRecording({ shouldSend });
      if (shouldSend && audioBlob) {
        await processAudio(audioBlob);
      }
    } finally {
      pendingReleaseActionRef.current = 'none';
      isStoppingRecordingRef.current = false;
    }
  }, [processAudio, stopRecording]);

  const startPressToTalk = useCallback(async () => {
    if (isProcessing || isRecording || isStartingRecordingRef.current) return;

    stopAudio();
    setCurrentResponse('');
    pendingReleaseActionRef.current = 'none';
    isStartingRecordingRef.current = true;

    try {
      await startRecording();
    } finally {
      isStartingRecordingRef.current = false;

      if (pendingReleaseActionRef.current !== 'none') {
        await finishRecording(pendingReleaseActionRef.current === 'send');
      }
    }
  }, [finishRecording, isProcessing, isRecording, startRecording, stopAudio]);

  const stopPressToTalk = useCallback(async (shouldSend: boolean) => {
    if (isProcessing) return;

    pendingReleaseActionRef.current = shouldSend ? 'send' : 'discard';

    if (!isRecording || isStartingRecordingRef.current) {
      return;
    }

    await finishRecording(shouldSend);
  }, [finishRecording, isProcessing, isRecording]);

  const handlePointerDown = useCallback(async (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    await startPressToTalk();
  }, [startPressToTalk]);

  const handlePointerUp = useCallback(async (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    await stopPressToTalk(true);
  }, [stopPressToTalk]);

  const handlePointerCancel = useCallback(async () => {
    await stopPressToTalk(false);
  }, [stopPressToTalk]);

  const handleKeyDown = useCallback(async (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.repeat) return;
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    await startPressToTalk();
  }, [startPressToTalk]);

  const handleKeyUp = useCallback(async (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== ' ' && event.key !== 'Enter') return;
    event.preventDefault();
    await stopPressToTalk(true);
  }, [stopPressToTalk]);

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName;
      return tagName === 'TEXTAREA'
        || tagName === 'INPUT'
        || tagName === 'SELECT'
        || target.isContentEditable;
    };

    const isInteractiveTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tagName = target.tagName;
      return tagName === 'BUTTON' || tagName === 'A';
    };

    const handleWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (inputMode !== 'voice') return;
      if (event.key !== ' ') return;
      if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.isComposing) return;
      if (isEditableTarget(event.target) || isInteractiveTarget(event.target)) return;
      if (isGlobalSpacePressActiveRef.current) return;

      isGlobalSpacePressActiveRef.current = true;
      event.preventDefault();
      void startPressToTalk();
    };

    const releaseGlobalSpacePress = (shouldSend: boolean) => {
      if (!isGlobalSpacePressActiveRef.current) return;
      isGlobalSpacePressActiveRef.current = false;
      void stopPressToTalk(shouldSend);
    };

    const handleWindowKeyUp = (event: globalThis.KeyboardEvent) => {
      if (event.key !== ' ') return;
      if (!isGlobalSpacePressActiveRef.current) return;
      event.preventDefault();
      releaseGlobalSpacePress(true);
    };

    const handleWindowBlur = () => {
      releaseGlobalSpacePress(false);
    };

    window.addEventListener('keydown', handleWindowKeyDown);
    window.addEventListener('keyup', handleWindowKeyUp);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('keydown', handleWindowKeyDown);
      window.removeEventListener('keyup', handleWindowKeyUp);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [inputMode, startPressToTalk, stopPressToTalk]);

  const clearHistory = () => {
    setMessages([]);
    setCurrentResponse('');
    setTextInput('');
    if (textInputRef.current) {
      textInputRef.current.value = '';
    }
    stopAudio();
  };

  const switchInputMode = () => {
    setInputMode((prev) => (prev === 'voice' ? 'text' : 'voice'));
    setCurrentResponse('');
    setTextInput('');
    if (textInputRef.current) {
      textInputRef.current.value = '';
    }
  };

  const submitTextInput = async () => {
    const nextText = (textInputRef.current?.value ?? textInput).trim();
    if (!nextText || isProcessing) return;
    setTextInput('');
    if (textInputRef.current) {
      textInputRef.current.value = '';
    }
    await processText(nextText);
  };

  const handleTextInputKeyDown = async (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const nativeEvent = event.nativeEvent as { isComposing?: boolean; keyCode?: number };
    if (isTextComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229) {
      return;
    }
    event.preventDefault();
    await submitTextInput();
  };

  const recentMessages = messages.slice(-3);
  const latestReplayableMessage = [...messages].reverse().find(
    (message) => message.role === 'assistant' && message.audioSegments?.length,
  );
  const orbPreviewMessages = recentMessages.slice(-4);
  const shouldAppendCurrentResponse = Boolean(
    currentResponse
    && (
      isProcessing
      || recentMessages[recentMessages.length - 1]?.content !== currentResponse
    ),
  );
  const orbPreviewEntries = shouldAppendCurrentResponse
    ? [
      ...orbPreviewMessages,
      { role: 'assistant', content: currentResponse } as ChatMessage,
    ]
    : orbPreviewMessages;
  const orbMotionLevel = isRecording
    ? 0.72
    : isPlaying
      ? 0.28 + audioLevel * 0.5
      : isProcessing
        ? 0.18
        : 0.14;
  const orbStyle = {
    '--orb-level': orbMotionLevel.toFixed(3),
    '--orb-scale-level': isPlaying ? (0.16 + audioLevel * 0.42).toFixed(3) : '0',
  } as CSSProperties;

  useEffect(() => {
    if (viewMode !== 'orb') return;
    const preview = orbPreviewRef.current;
    if (!preview) return;
    preview.scrollTop = preview.scrollHeight;
  }, [currentResponse, messages, viewMode]);

  return (
    <div className="voice-chat">
      <audio ref={audioRef} />

      <div className={`chat-container ${isProcessing ? 'thinking' : ''}`}>
        <div className="chat-header">
          <h1>{text.title}</h1>
          <div className="top-actions">
            <select
              value={locale}
              onChange={(e) => setLocale(e.target.value as Locale)}
              className="voice-select top-language-select"
              aria-label={text.language}
            >
              <option value="zh">中文</option>
              <option value="en">English</option>
              <option value="ja">日本語</option>
            </select>
            <button
              type="button"
              className="top-action-btn"
              onClick={() => setViewMode((prev) => (prev === 'orb' ? 'transcript' : 'orb'))}
            >
              {viewMode === 'orb' ? text.transcript : text.live}
            </button>
            <button
              type="button"
              onClick={switchInputMode}
              className="top-action-btn"
              disabled={isProcessing}
              aria-label={inputMode === 'voice' ? text.switchToKeyboard : text.switchToVoice}
            >
              {inputMode === 'voice' ? text.keyboard : text.voice}
            </button>
            <label className="reasoning-toggle top-reasoning-toggle">
              <input
                type="checkbox"
                aria-label={text.reasoning}
                checked={useReasoning}
                onChange={(e) => setUseReasoning(e.target.checked)}
                disabled={isProcessing}
              />
              <span>{text.reasoning}</span>
            </label>
            <button
              type="button"
              className={`top-action-btn ${isSettingsOpen ? 'active' : ''}`}
              onClick={() => setIsSettingsOpen((prev) => !prev)}
              aria-label={text.toggleSettings}
            >
              {text.settings}
            </button>
          </div>
        </div>

        {isSettingsOpen ? (
          <div className="settings-panel settings-popover">
            <select
              id="voice-select"
              value={selectedVoice}
              onChange={(e) => setSelectedVoice(e.target.value as VoiceType)}
              className="voice-select"
            >
              {AVAILABLE_VOICES.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
            <button type="button" onClick={clearHistory} className="clear-btn">{text.clear}</button>
          </div>
        ) : null}

        {viewMode === 'orb' ? (
          <div className="orb-stage">
            <div className="orb-shell">
              <div
                className={`orb-button orb-display ${isRecording ? 'recording' : ''} ${isProcessing ? 'processing' : ''} ${isPlaying ? 'playing' : ''}`}
                style={orbStyle}
              >
                <span className="orb-core">
                  <span className="orb-ripple orb-ripple-primary"></span>
                  <span className="orb-ripple orb-ripple-secondary"></span>
                  <span className="orb-gradient"></span>
                  <span className="orb-halo"></span>
                  <span className="orb-tide"></span>
                  <span className="orb-surface"></span>
                </span>
              </div>
            </div>

            {orbPreviewEntries.length > 0 && (
              <div ref={orbPreviewRef} className="orb-transcript-preview">
                {orbPreviewEntries.map((msg, index) => (
                  <div key={`${msg.role}-${index}-${typeof msg.content === 'string' ? msg.content : 'media'}`} className="orb-line">
                    {typeof msg.content === 'string' ? msg.content : text.attachment}
                  </div>
                ))}
              </div>
            )}

            <div className="orb-replay-slot">
              <button
                type="button"
                className={`replay-audio-btn orb-replay-btn ${latestReplayableMessage ? '' : 'hidden'}`}
                onClick={() => latestReplayableMessage ? void replayMessageAudio(latestReplayableMessage) : undefined}
                disabled={!latestReplayableMessage}
                aria-hidden={!latestReplayableMessage}
                tabIndex={latestReplayableMessage ? 0 : -1}
              >
                {text.replay}
              </button>
            </div>
          </div>
        ) : (
          <div className="messages">
            {messages.length === 0 && (
              <div className="welcome-message">
                <p className="welcome-title">
                  {inputMode === 'voice' ? text.welcomeVoice : text.welcomeText}
                </p>
                {isWarmingUp ? <p className="hint">{text.warmupHint}</p> : null}
              </div>
            )}
            {messages.map((msg, idx) => (
              <div key={idx} className={`message ${msg.role}`}>
                <div className="message-body">
                  <div className="message-content">
                    {typeof msg.content === 'string' ? msg.content : `📎 [${text.attachment}]`}
                  </div>
                  {msg.role === 'assistant' && msg.audioSegments?.length ? (
                    <button
                      type="button"
                      className="replay-audio-btn"
                      onClick={() => void replayMessageAudio(msg)}
                    >
                      {text.replay}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {(currentResponse || isProcessing) && (
              <div className="message assistant">
                <div className="message-content">
                  {currentResponse || text.thinking}
                  {isProcessing && <span className="cursor">|</span>}
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>
        )}

        <div className="input-area">
          {localizedRecordError && <div className="error-message">{localizedRecordError}</div>}

          {inputMode === 'voice' ? (
            <div className="voice-input-panel">
              <button
                disabled={isProcessing}
                aria-label={text.talkButton}
                onPointerDown={handlePointerDown}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerCancel}
                onKeyDown={handleKeyDown}
                onKeyUp={handleKeyUp}
                className={`record-button ${isRecording ? 'recording' : ''} ${isProcessing ? 'processing' : ''}`}
              >
                {isProcessing ? (
                  <>
                    <span className="icon">⏳</span>
                    <span className="status">{text.processing}</span>
                  </>
                ) : isRecording ? (
                  <>
                    <span className="icon pulse">●</span>
                    <span className="status">{text.releaseToSend}</span>
                  </>
                ) : (
                  <>
                    <span className="icon">{text.mic}</span>
                    <span className="status">{text.holdToTalk}</span>
                  </>
                )}
              </button>
            </div>
          ) : null}

          {inputMode === 'text' ? (
            <div className="text-input-panel">
              <textarea
                ref={textInputRef}
                defaultValue=""
                onChange={(event) => setTextInput(event.target.value)}
                onInput={(event) => setTextInput((event.target as HTMLTextAreaElement).value)}
                onCompositionStart={() => {
                  isTextComposingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  isTextComposingRef.current = false;
                  setTextInput((event.target as HTMLTextAreaElement).value);
                }}
                onKeyDown={(event) => void handleTextInputKeyDown(event)}
                className="text-input"
                placeholder={text.textPlaceholder}
                disabled={isProcessing}
                rows={3}
              />
              <div className="text-input-actions">
                <span className="text-input-tip">{text.textTip}</span>
                <button
                  type="button"
                  className="send-text-btn"
                  onClick={() => void submitTextInput()}
                  disabled={isProcessing}
                  aria-label={text.sendText}
                >
                  {isProcessing ? text.sending : text.send}
                </button>
              </div>
            </div>
          ) : null}

        </div>
      </div>
    </div>
  );
}
