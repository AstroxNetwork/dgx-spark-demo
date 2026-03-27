import type { VoiceType } from '../config';

export type { VoiceType };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  audioSegments?: Blob[];
}

export type InputMode = 'voice' | 'text';

export interface StreamingAudioPayload {
  stream: ReadableStream<Uint8Array>;
  format: 'pcm_s16le';
  sampleRate: number;
  channels: number;
}

export interface StreamChunk {
  text?: string;
  audio?: Blob;
  audioStream?: StreamingAudioPayload;
  done?: boolean;
}
