import { CONFIG } from '../config';
import type { ChatMessage, VoiceType, StreamChunk, StreamingAudioPayload } from '../types';
import { toPlainTextForSpeech } from '../utils/plainText';

const TTS_STABILITY_SAMPLING = {
  doSample: true,
  temperature: 0.5,
  topK: 10,
  topP: 0.8,
  repetitionPenalty: 1.05,
} as const;
const ASR_BRAND_NORMALIZATION_RULES: Array<[RegExp, string]> = [
  [/\blocal\s*claw\s*one\s*box\b/gi, 'LocalClaw OneBox'],
  [/\bopen\s*core\b/gi, 'OpenClaw'],
  [/\bopen\s*claw\b/gi, 'OpenClaw'],
  [/\bopencl\b/gi, 'OpenClaw'],
  [/\bopen\s*viking\b/gi, 'OpenViking'],
  [/\bdgx\s*spark\b/gi, 'DGX Spark'],
];

interface TtsRequestOptions {
  voice?: VoiceType;
  language?: string;
  doSample?: boolean;
  temperature?: number;
  topK?: number;
  topP?: number;
  repetitionPenalty?: number;
  seed?: number;
  sessionId?: string;
  flush?: boolean;
  priority?: number;
  sequence?: number;
}

interface ChatRequestOptions {
  think?: boolean;
}

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
  private ttsStreamBaseUrl: string;
  private apiKey: string;
  private openclawSessionId: string | null;

  constructor() {
    this.asrBaseUrl = CONFIG.asrBaseUrl;
    this.openclawBaseUrl = CONFIG.openclawBaseUrl;
    this.ttsSidecarBaseUrl = CONFIG.ttsSidecarBaseUrl;
    this.ttsBaseUrl = CONFIG.ttsBaseUrl;
    this.ttsStreamBaseUrl = CONFIG.ttsStreamBaseUrl;
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
        sessionId: this.resolveOpenClawSessionId(history),
        think: options.think ?? false,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenClaw Error: ${response.status} - ${error}`);
    }

    const payload = await response.json() as { text?: string; error?: string; sessionId?: string };
    const text = toPlainTextForSpeech(payload.text?.trim() ?? '');
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
    const trimmedText = toPlainTextForSpeech(text.trim());
    const normalizedOptions = typeof options === 'string'
      ? { voice: options }
      : options;
    const voice = normalizedOptions.voice ?? CONFIG.defaultVoice;
    const language = normalizedOptions.language ?? this.inferTtsLanguage(text);
    const doSample = normalizedOptions.doSample ?? TTS_STABILITY_SAMPLING.doSample;
    const temperature = normalizedOptions.temperature ?? TTS_STABILITY_SAMPLING.temperature;
    const topK = normalizedOptions.topK ?? TTS_STABILITY_SAMPLING.topK;
    const topP = normalizedOptions.topP ?? TTS_STABILITY_SAMPLING.topP;
    const repetitionPenalty =
      normalizedOptions.repetitionPenalty ?? TTS_STABILITY_SAMPLING.repetitionPenalty;
    const seed = normalizedOptions.seed ?? this.createTtsTurnSeed();

    if (!trimmedText && !normalizedOptions.flush) {
      return null;
    }

    if (normalizedOptions.sessionId) {
      try {
        return await this.synthesizeThroughSidecar(trimmedText, {
          voice,
          language,
          doSample,
          temperature,
          topK,
          topP,
          repetitionPenalty,
          seed,
          sessionId: normalizedOptions.sessionId,
          flush: normalizedOptions.flush ?? false,
          priority: normalizedOptions.priority ?? 1,
          sequence: normalizedOptions.sequence,
        });
      } catch (error) {
        console.warn('⚠️ 本地 TTS 旁路不可用，回退到直连模式:', error);
      }
    }

    console.log({ voice });

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

  async synthesizeStreaming(
    text: string,
    options: TtsRequestOptions | VoiceType = CONFIG.defaultVoice,
  ): Promise<StreamingAudioPayload | null> {
    const trimmedText = toPlainTextForSpeech(text.trim());
    if (!trimmedText) {
      return null;
    }

    const normalizedOptions = typeof options === 'string'
      ? { voice: options }
      : options;
    const voice = normalizedOptions.voice ?? CONFIG.defaultVoice;
    const language = normalizedOptions.language ?? this.inferTtsLanguage(text);
    const doSample = normalizedOptions.doSample ?? TTS_STABILITY_SAMPLING.doSample;
    const temperature = normalizedOptions.temperature ?? TTS_STABILITY_SAMPLING.temperature;
    const topK = normalizedOptions.topK ?? TTS_STABILITY_SAMPLING.topK;
    const topP = normalizedOptions.topP ?? TTS_STABILITY_SAMPLING.topP;
    const repetitionPenalty =
      normalizedOptions.repetitionPenalty ?? TTS_STABILITY_SAMPLING.repetitionPenalty;
    const seed = normalizedOptions.seed ?? this.createTtsTurnSeed();

    const response = await fetch(`${this.ttsStreamBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.apiKey ? { 'Authorization': `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: CONFIG.ttsModel,
        input: trimmedText,
        voice,
        speed: 1,
        task_type: 'CustomVoice',
        language,
        do_sample: doSample,
        temperature,
        top_k: topK,
        top_p: topP,
        repetition_penalty: repetitionPenalty,
        seed,
        stream: true,
        response_format: 'pcm',
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Streaming TTS Error: ${response.status} - ${error}`);
    }

    if (!response.body) {
      throw new Error('Streaming TTS returned no response body');
    }

    return {
      stream: response.body,
      format: 'pcm_s16le',
      sampleRate: CONFIG.ttsStreamSampleRate,
      channels: 1,
    };
  }

  private async synthesizeThroughSidecar(
    optionsText: string,
    options:
      Required<
        Pick<
          TtsRequestOptions,
          | 'voice'
          | 'language'
          | 'doSample'
          | 'temperature'
          | 'topK'
          | 'topP'
          | 'repetitionPenalty'
          | 'seed'
          | 'sessionId'
          | 'flush'
          | 'priority'
        >
      >
      & Pick<TtsRequestOptions, 'sequence'>,
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
        flush: options.flush,
        priority: options.priority,
        sequence: options.sequence,
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
    const ttsOptions = this.createStableTtsOptions(
      userText,
      voice,
      language,
      this.createTtsTurnSeed(),
    );
    let rawAssistantText = '';
    let assistantText = '';

    for await (const chunk of this.chat(userText, history, { think })) {
      if (!chunk.text) continue;

      rawAssistantText += chunk.text;
      const sanitizedAssistantText = this.stripLeadingAssistantLabel(rawAssistantText);
      const nextAssistantDelta = sanitizedAssistantText.slice(assistantText.length);
      assistantText = sanitizedAssistantText;

      if (!nextAssistantDelta) {
        continue;
      }

      queue.push({ text: nextAssistantDelta });
    }

    console.log('💬 Assistant:', assistantText);

    if (assistantText) {
      try {
        const audioStream = await this.synthesizeStreaming(assistantText, ttsOptions);
        if (audioStream) {
          queue.push({ audioStream });
        }
      } catch (error) {
        console.warn('⚠️ Streaming TTS 不可用，跳过语音合成:', error);
      }

      queue.push({ done: true });
    }
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
    seed: number,
  ): TtsRequestOptions {
    return {
      voice,
      language: this.normalizeRequestedLanguage(requestedLanguage) ?? this.inferTtsLanguage(userText),
      doSample: TTS_STABILITY_SAMPLING.doSample,
      temperature: TTS_STABILITY_SAMPLING.temperature,
      topK: TTS_STABILITY_SAMPLING.topK,
      topP: TTS_STABILITY_SAMPLING.topP,
      repetitionPenalty: TTS_STABILITY_SAMPLING.repetitionPenalty,
      seed,
    };
  }

  private createTtsTurnSeed(): number {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const values = new Uint32Array(1);
      crypto.getRandomValues(values);
      return values[0] ?? 1;
    }

    return Math.floor(Math.random() * 0xffffffff) || 1;
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
}

export const qwenService = new QwenService();
