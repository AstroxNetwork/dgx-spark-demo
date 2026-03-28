import type { VoiceType } from '../config';

export type { VoiceType };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  audioSegments?: Blob[];
}

export type InputMode = 'voice' | 'text';

export interface StreamChunk {
  text?: string;
  audio?: Blob;
  audioSequence?: number;
  done?: boolean;
}
