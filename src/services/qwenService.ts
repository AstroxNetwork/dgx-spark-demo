import { CONFIG, SYSTEM_PROMPT } from '../config';
import type { ChatMessage, VoiceType, StreamChunk } from '../types';

const TTS_STABILITY_INSTRUCTIONS = [
  '用默认的音调，新闻联播的口吻，不带任何的情绪',
].join(' ');

const TTS_STABILITY_SAMPLING = {
  doSample: false,
  temperature: 0.5,
  topK: 10,
  topP: 0.8,
  repetitionPenalty: 1.05,
} as const;
const ASR_BRAND_NORMALIZATION_RULES: Array<[RegExp, string]> = [
  [/\blocal\s*claw\s*one\s*box\b/gi, 'LocalClaw OneBox'],
  [/\bopen\s*cloud\b/gi, 'OpenClaw'],
  [/\bopen\s*core\b/gi, 'OpenClaw'],
  [/\bopen\s*claw\b/gi, 'OpenClaw'],
  [/\bopencl\b/gi, 'OpenClaw'],
  [/\bopen\s*viking\b/gi, 'OpenViking'],
  [/\bdgx\s*spark\b/gi, 'DGX Spark'],
];

const FIRST_STREAMING_TTS_SEGMENT_LENGTH = 8;
const FIRST_STREAMING_TTS_BOUNDARIES = 1;
const FIRST_STREAMING_TTS_CHINESE_MIN_LENGTH = 40;
const FIRST_STREAMING_TTS_ENGLISH_MIN_LENGTH = 80;
const MIN_STREAMING_TTS_SEGMENT_LENGTH = 18;
const MIN_STREAMING_TTS_BOUNDARIES = 2;

interface TtsRequestOptions {
  voice?: VoiceType;
  language?: string;
  instructions?: string;
  doSample?: boolean;
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  seed?: number;
  sessionId?: string;
  sequence?: number;
  flush?: boolean;
  priority?: number;
}

interface ChatRequestOptions {
  think?: boolean;
}

type ResolvedTtsOptions = Required<
  Pick<
    TtsRequestOptions,
    | 'voice'
    | 'instructions'
    | 'language'
    | 'doSample'
    | 'temperature'
    | 'topK'
    | 'topP'
    | 'repetitionPenalty'
    | 'seed'
  >
>;

type SidecarSynthesizeOptions = ResolvedTtsOptions & {
  sessionId: string;
  sequence?: number;
  flush: boolean;
  priority: number;
};

type SidecarFlushOptions = ResolvedTtsOptions & {
  sessionId: string;
};

type QueueResolver = {
  resolve: (result: IteratorResult<StreamChunk>) => void;
  reject: (error: unknown) => void;
};

class StreamChunkQueue {
  private items: StreamChunk[] = [];
  private resolvers: QueueResolver[] = [];
  private closed = false;
  private error: unknown = null;

  push(item: StreamChunk): void {
    if (this.closed) return;

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver.resolve({ value: item, done: false });
      return;
    }

    this.items.push(item);
  }

  close(): void {
    this.closed = true;

    while (this.resolvers.length > 0) {
      this.resolvers.shift()!.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    this.error = error;
    this.closed = true;

    while (this.resolvers.length > 0) {
      this.resolvers.shift()!.reject(error);
    }
  }

  next(): Promise<IteratorResult<StreamChunk>> {
    if (this.items.length > 0) {
      const item = this.items.shift()!;
      return Promise.resolve({ value: item, done: false });
    }

    if (this.error) {
      return Promise.reject(this.error);
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    return new Promise((resolve, reject) => {
      this.resolvers.push({ resolve, reject });
    });
  }
}

class QwenService {
  private asrBaseUrl: string;
  private openclawBaseUrl: string;
  private ttsSidecarBaseUrl: string;
  private ttsBaseUrl: string;
  private apiKey: string;
  private openclawSessionId: string | null;

  constructor() {
    this.asrBaseUrl = CONFIG.asrBaseUrl;
    this.openclawBaseUrl = CONFIG.openclawBaseUrl;
    this.ttsSidecarBaseUrl = CONFIG.ttsSidecarBaseUrl;
    this.ttsBaseUrl = CONFIG.ttsBaseUrl;
    this.apiKey = CONFIG.apiKey;
    this.openclawSessionId = null;
  }

  /**
   * ASR: 语音转文字
   */
  async transcribe(audioBlob: Blob, language: string = 'zh'): Promise<string> {
    const uploadBlob =
      audioBlob.type === 'audio/wav' ? audioBlob : await this.convertToWav(audioBlob);

    const formData = new FormData();
    formData.append('file', uploadBlob, 'audio.wav');
    formData.append('model', CONFIG.asrModel);
    formData.append('language', language);
    formData.append('response_format', 'json');

    const url = `${this.asrBaseUrl}/audio/transcriptions`;
    console.log('🎤 ASR URL:', url);

    const response = await fetch(url, {
      method: 'POST',
      headers: this.apiKey ? {
        'Authorization': `Bearer ${this.apiKey}`,
      } : {},
      body: formData,
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`ASR Error: ${response.status} - ${error}`);
    }

    const result = await response.json();
    console.log('🎤 ASR Response:', result);

    // 兼容不同的响应格式
    return this.normalizeUserInputText(
      result.text || result.transcript || JSON.stringify(result),
    );
  }

  /**
   * Chat: 文字推理 (流式)
   */
  async *chat(
    userText: string,
    history: ChatMessage[] = [],
    options: ChatRequestOptions = {},
  ): AsyncGenerator<StreamChunk> {
    const response = await fetch(`${this.openclawBaseUrl}/agent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        userText,
        history,
        systemPrompt: SYSTEM_PROMPT,
        sessionId: this.resolveOpenClawSessionId(history),
        think: options.think ?? false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenClaw Error: ${response.status} - ${error}`);
    }

    const payload = await response.json() as { text?: string; error?: string; sessionId?: string };
    const text = payload.text?.trim() ?? '';
    if (payload.sessionId) {
      this.openclawSessionId = payload.sessionId;
    }
    if (!text) {
      throw new Error(payload.error ?? 'OpenClaw 没有返回任何正文内容');
    }

    yield { text };
    yield { done: true };
  }

  async warmupChat(think: boolean = false): Promise<void> {
    const response = await fetch(`${this.openclawBaseUrl}/warmup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ think }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenClaw Warmup Error: ${response.status} - ${error}`);
    }

    await response.text();
  }

  /**
   * TTS: 文字转语音
   */
  async synthesize(
    text: string,
    options: TtsRequestOptions | VoiceType = CONFIG.defaultVoice,
  ): Promise<Blob | null> {
    const trimmedText = text.trim();
    const normalizedOptions = typeof options === 'string'
      ? { voice: options }
      : options;
    const voice = normalizedOptions.voice ?? CONFIG.defaultVoice;
    const instructions = normalizedOptions.instructions ?? TTS_STABILITY_INSTRUCTIONS;
    const language = normalizedOptions.language ?? this.inferTtsLanguage(text);
    const doSample = normalizedOptions.doSample ?? TTS_STABILITY_SAMPLING.doSample;
    const temperature = normalizedOptions.temperature ?? TTS_STABILITY_SAMPLING.temperature;
    const topK = normalizedOptions.topK ?? TTS_STABILITY_SAMPLING.topK;
    const topP = normalizedOptions.topP ?? TTS_STABILITY_SAMPLING.topP;
    const repetitionPenalty =
      normalizedOptions.repetitionPenalty ?? TTS_STABILITY_SAMPLING.repetitionPenalty;
    const seed = normalizedOptions.seed ?? this.createTurnTtsSeed();

    if (!trimmedText && !normalizedOptions.flush) {
      return null;
    }

    if (normalizedOptions.sessionId) {
      try {
        return await this.synthesizeThroughSidecar(trimmedText, {
          voice,
          instructions,
          language,
          doSample,
          temperature,
          topK,
          topP,
          repetitionPenalty,
          seed,
          sessionId: normalizedOptions.sessionId,
          sequence: normalizedOptions.sequence,
          flush: normalizedOptions.flush ?? false,
          priority: normalizedOptions.priority ?? 1,
        });
      } catch (error) {
        console.warn('⚠️ 本地 TTS 旁路不可用，回退到直连模式:', error);
      }
    }

    console.log({ voice, instructions });

    const response = await fetch(`${this.ttsBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: CONFIG.ttsModel,
        input: trimmedText,
        voice,
        instructions,
        speed: 1,
        task_type: 'CustomVoice',
        language,
        do_sample: doSample,
        temperature,
        top_k: topK,
        top_p: topP,
        repetition_penalty: repetitionPenalty,
        seed,
        response_format: 'wav',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`TTS Error: ${response.status} - ${error}`);
    }

    return await response.blob();
  }

  private async synthesizeThroughSidecar(
    optionsText: string,
    options: SidecarSynthesizeOptions,
  ): Promise<Blob | null> {
    const response = await fetch(`${this.ttsSidecarBaseUrl}/audio/segment-speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: CONFIG.ttsModel,
        input: optionsText,
        voice: options.voice,
        instructions: options.instructions,
        speed: 1,
        task_type: 'CustomVoice',
        language: options.language,
        do_sample: options.doSample,
        temperature: options.temperature,
        top_k: options.topK,
        top_p: options.topP,
        repetition_penalty: options.repetitionPenalty,
        seed: options.seed,
        response_format: 'wav',
        session_id: options.sessionId,
        sequence: options.sequence,
        flush: options.flush,
        priority: options.priority,
      }),
    });

    if (response.status === 404) {
      throw new Error('TTS sidecar endpoint not found');
    }

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`TTS Sidecar Error: ${response.status} - ${error}`);
    }

    const contentType = response.headers.get('Content-Type') ?? '';
    if (contentType.includes('application/json')) {
      const result = await response.json();
      if (result?.merged) {
        return null;
      }

      throw new Error('Unexpected JSON response from TTS sidecar');
    }

    return await response.blob();
  }

  private async flushSidecarSession(
    options: SidecarFlushOptions,
  ): Promise<void> {
    if (typeof window === 'undefined' && this.ttsSidecarBaseUrl.startsWith('/')) {
      return;
    }

    try {
      await this.synthesizeThroughSidecar('', {
        ...options,
        flush: true,
        priority: 1,
      });
    } catch (error) {
      console.warn('⚠️ 本地 TTS 旁路 flush 失败，继续结束当前语音流:', error);
    }
  }

  /**
   * 完整的语音对话流程 (流式返回文字，最后返回音频)
   */
  async *voiceChat(
    audioBlob: Blob,
    history: ChatMessage[] = [],
    voice: VoiceType = CONFIG.defaultVoice,
    language: string = 'zh',
    think: boolean = false,
  ): AsyncGenerator<StreamChunk> {
    const queue = new StreamChunkQueue();

    void (async () => {
      try {
      const userText = await this.transcribe(audioBlob, language);
        console.log('🎤 ASR:', userText);
        queue.push({ text: `[用户]: ${userText}\n\n` });
        await this.streamAssistantReply(queue, userText, history, voice, language, think);

        queue.close();
      } catch (error) {
        queue.fail(error);
      }
    })();

    while (true) {
      const { value, done } = await queue.next();
      if (done) break;
      yield value;
    }
  }

  async *textChat(
    userText: string,
    history: ChatMessage[] = [],
    voice: VoiceType = CONFIG.defaultVoice,
    language: string = 'zh',
    think: boolean = false,
  ): AsyncGenerator<StreamChunk> {
    const queue = new StreamChunkQueue();

    void (async () => {
      try {
        const trimmedUserText = this.normalizeUserInputText(userText.trim());
        if (!trimmedUserText) {
          queue.close();
          return;
        }

        queue.push({ text: `[用户]: ${trimmedUserText}\n\n` });
        await this.streamAssistantReply(queue, trimmedUserText, history, voice, language, think);
        queue.close();
      } catch (error) {
        queue.fail(error);
      }
    })();

    while (true) {
      const { value, done } = await queue.next();
      if (done) break;
      yield value;
    }
  }

  /**
   * 转换 WebM 到 WAV (用于 ASR)
   */
  async convertToWav(blob: Blob): Promise<Blob> {
    const audioContext = new AudioContext({ sampleRate: 16000 });
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

    const numberOfChannels = 1; // 单声道
    const length = audioBuffer.length * numberOfChannels * 2;
    const buffer = new ArrayBuffer(44 + length);
    const view = new DataView(buffer);

    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + length, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, numberOfChannels, true);
    view.setUint32(24, audioBuffer.sampleRate, true);
    view.setUint32(28, audioBuffer.sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, length, true);

    // Write audio data (mix to mono if needed)
    const channelData = audioBuffer.numberOfChannels > 1
      ? this.mixToMono(audioBuffer)
      : audioBuffer.getChannelData(0);

    for (let i = 0; i < channelData.length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      view.setInt16(44 + i * 2, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    }

    await audioContext.close();
    return new Blob([buffer], { type: 'audio/wav' });
  }

  private mixToMono(audioBuffer: AudioBuffer): Float32Array {
    const length = audioBuffer.length;
    const result = new Float32Array(length);
    const numChannels = audioBuffer.numberOfChannels;

    for (let i = 0; i < length; i++) {
      let sum = 0;
      for (let ch = 0; ch < numChannels; ch++) {
        sum += audioBuffer.getChannelData(ch)[i];
      }
      result[i] = sum / numChannels;
    }

    return result;
  }

  private async streamAssistantReply(
    queue: StreamChunkQueue,
    userText: string,
    history: ChatMessage[],
    voice: VoiceType,
    language: string,
    think: boolean,
  ): Promise<void> {
    const ttsOptions = this.createStableTtsOptions(userText, voice, language);
    const ttsSessionId = `tts-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    let nextTtsSequence = 0;

    let rawAssistantText = '';
    let assistantText = '';
    let pendingSpeechText = '';
    let ttsError: unknown = null;
    let hasQueuedAudioSegment = false;
    let audioFlushChain = Promise.resolve();

    const enqueueAudioSegment = (
      segment: string,
      { flush = false, priority = 1 }: { flush?: boolean; priority?: number } = {},
    ) => {
      const sequence = nextTtsSequence++;
      const audioPromise = this.synthesize(segment, {
        ...ttsOptions,
        sessionId: ttsSessionId,
        sequence,
        flush,
        priority,
      });
      audioFlushChain = audioFlushChain.then(async () => {
        if (ttsError) return;

        try {
          const audioBlob = await audioPromise;
          if (!audioBlob) return;
          queue.push({ audio: audioBlob });
        } catch (error) {
          ttsError = error;
        }
      });
    };

    for await (const chunk of this.chat(userText, history, { think })) {
      if (!chunk.text) continue;

      rawAssistantText += chunk.text;
      const sanitizedAssistantText = this.stripLeadingAssistantLabel(rawAssistantText);
      const nextAssistantDelta = sanitizedAssistantText.slice(assistantText.length);
      assistantText = sanitizedAssistantText;

      if (!nextAssistantDelta) {
        continue;
      }

      pendingSpeechText += nextAssistantDelta;
      queue.push({ text: nextAssistantDelta });

      const { segments, remainder } = this.extractSpeakableSegments(pendingSpeechText, {
        preferFastFirstSegment: !hasQueuedAudioSegment,
      });
      pendingSpeechText = remainder;

      for (const segment of segments) {
        enqueueAudioSegment(segment, {
          flush: !hasQueuedAudioSegment,
          priority: hasQueuedAudioSegment ? 1 : 0,
        });
        hasQueuedAudioSegment = true;
      }
    }

    console.log('💬 Assistant:', assistantText);

    if (assistantText) {
      const finalSegment = pendingSpeechText.trim();
      if (finalSegment) {
        enqueueAudioSegment(finalSegment, {
          flush: true,
          priority: hasQueuedAudioSegment ? 1 : 0,
        });
      } else {
        await this.flushSidecarSession({
          sessionId: ttsSessionId,
          voice: ttsOptions.voice ?? CONFIG.defaultVoice,
          instructions: ttsOptions.instructions ?? TTS_STABILITY_INSTRUCTIONS,
          language: ttsOptions.language ?? this.inferTtsLanguage(userText),
          doSample: ttsOptions.doSample ?? TTS_STABILITY_SAMPLING.doSample,
          temperature: ttsOptions.temperature ?? TTS_STABILITY_SAMPLING.temperature,
          topK: ttsOptions.topK ?? TTS_STABILITY_SAMPLING.topK,
          topP: ttsOptions.topP ?? TTS_STABILITY_SAMPLING.topP,
          repetitionPenalty:
            ttsOptions.repetitionPenalty ?? TTS_STABILITY_SAMPLING.repetitionPenalty,
          seed: ttsOptions.seed ?? this.createTurnTtsSeed(),
        });
      }

      await audioFlushChain;

      if (ttsError) {
        console.warn('⚠️ TTS 不可用，跳过语音合成:', ttsError);
      }

      queue.push({ done: true });
    }
  }

  private extractSpeakableSegments(
    text: string,
    options: { preferFastFirstSegment?: boolean } = {},
  ): {
    segments: string[];
    remainder: string;
  } {
    const segments: string[] = [];
    const boundaryPattern = /[。！？!?；;\n]/;
    const softBoundaryPattern = /[，,、：:]/;
    const isChineseFirstSegment = /[\u4e00-\u9fff]/.test(text);
    const firstSegmentMinLength = isChineseFirstSegment
      ? FIRST_STREAMING_TTS_CHINESE_MIN_LENGTH
      : FIRST_STREAMING_TTS_ENGLISH_MIN_LENGTH;
    let start = 0;
    let boundaryCount = 0;
    let lastSoftBoundary = -1;
    const minSegmentLength = options.preferFastFirstSegment
      ? FIRST_STREAMING_TTS_SEGMENT_LENGTH
      : MIN_STREAMING_TTS_SEGMENT_LENGTH;
    const minBoundaryCount = options.preferFastFirstSegment
      ? FIRST_STREAMING_TTS_BOUNDARIES
      : MIN_STREAMING_TTS_BOUNDARIES;

    for (let i = 0; i < text.length; i++) {
      if (softBoundaryPattern.test(text[i])) {
        lastSoftBoundary = i;
      }
      if (!boundaryPattern.test(text[i])) continue;

      const segment = text.slice(start, i + 1).trim();
      if (!segment) {
        continue;
      }

      if (options.preferFastFirstSegment) {
        boundaryCount += 1;
        if (segment.length < firstSegmentMinLength) {
          continue;
        }
        segments.push(segment);
        start = i + 1;
        boundaryCount = 0;
        lastSoftBoundary = -1;
        continue;
      }

      boundaryCount += 1;
      const isLongEnough = segment.length >= minSegmentLength;
      const hasEnoughBoundaries = boundaryCount >= minBoundaryCount;
      const shouldEmit = isLongEnough || hasEnoughBoundaries;
      if (!shouldEmit) {
        continue;
      }

      segments.push(segment);
      start = i + 1;
      boundaryCount = 0;
      lastSoftBoundary = -1;
    }

    if (options.preferFastFirstSegment && segments.length === 0) {
      const trimmedText = text.trim();
      if (trimmedText.length >= firstSegmentMinLength) {
        let splitIndex = lastSoftBoundary >= 0 ? lastSoftBoundary + 1 : -1;
        if (splitIndex < 0 && trimmedText.length >= firstSegmentMinLength) {
          if (!isChineseFirstSegment) {
            const forwardWindow = text.slice(firstSegmentMinLength, Math.min(text.length, firstSegmentMinLength + 24));
            const forwardWhitespaceOffset = forwardWindow.search(/\s/);
            if (forwardWhitespaceOffset >= 0) {
              splitIndex = firstSegmentMinLength + forwardWhitespaceOffset + 1;
            } else {
              const backwardWindow = text.slice(0, firstSegmentMinLength + 1);
              const backwardWhitespace = Math.max(
                backwardWindow.lastIndexOf(' '),
                backwardWindow.lastIndexOf('\n'),
                backwardWindow.lastIndexOf('\t'),
              );
              if (backwardWhitespace > 0) {
                splitIndex = backwardWhitespace + 1;
              }
            }
          }

          if (splitIndex < 0) {
            splitIndex = firstSegmentMinLength;
          }
        }

        if (splitIndex > 0) {
          const segment = text.slice(0, splitIndex).trim();
          if (segment.length >= FIRST_STREAMING_TTS_SEGMENT_LENGTH) {
            segments.push(segment);
            start = splitIndex;
          }
        }
      }
    }

    return {
      segments,
      remainder: text.slice(start),
    };
  }

  private inferTtsLanguage(text: string): string {
    if (/[\u3040-\u30ff]/.test(text)) return 'Japanese';
    if (/[\uac00-\ud7af]/.test(text)) return 'Korean';
    if (/[\u4e00-\u9fff]/.test(text)) return 'Chinese';
    if (/[a-z]/i.test(text)) return 'English';
    return 'Auto';
  }

  private createStableTtsOptions(
    userText: string,
    voice: VoiceType,
    requestedLanguage: string,
  ): TtsRequestOptions {
    return {
      voice,
      language: this.normalizeRequestedLanguage(requestedLanguage) ?? this.inferTtsLanguage(userText),
      instructions: TTS_STABILITY_INSTRUCTIONS,
      doSample: TTS_STABILITY_SAMPLING.doSample,
      seed: this.createTurnTtsSeed(),
      temperature: TTS_STABILITY_SAMPLING.temperature,
      topK: TTS_STABILITY_SAMPLING.topK,
      topP: TTS_STABILITY_SAMPLING.topP,
      repetitionPenalty: TTS_STABILITY_SAMPLING.repetitionPenalty,
    };
  }

  private normalizeRequestedLanguage(language: string): string | null {
    const normalized = language.trim().toLowerCase();

    if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh-hans') {
      return 'Chinese';
    }
    if (normalized === 'en' || normalized === 'en-us' || normalized === 'en-gb') {
      return 'English';
    }
    if (normalized === 'ja' || normalized === 'ja-jp') {
      return 'Japanese';
    }
    if (normalized === 'ko' || normalized === 'ko-kr') {
      return 'Korean';
    }

    return null;
  }

  private stripLeadingAssistantLabel(text: string): string {
    return text.replace(
      /^\s*(?:\*\*)?\s*(?:response|answer|reply|中文回答|回答|回复)\s*[:：]\s*(?:\*\*)?\s*/i,
      '',
    );
  }

  private normalizeUserInputText(text: string): string {
    let normalized = text;
    for (const [pattern, replacement] of ASR_BRAND_NORMALIZATION_RULES) {
      normalized = normalized.replace(pattern, replacement);
    }
    return normalized;
  }

  private resolveOpenClawSessionId(history: ChatMessage[]): string {
    if (!this.openclawSessionId || history.length === 0) {
      this.openclawSessionId = `voice-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    return this.openclawSessionId;
  }

  private createTurnTtsSeed(): number {
    return Math.floor(Math.random() * 0x7fffffff);
  }
}

export const qwenService = new QwenService();
