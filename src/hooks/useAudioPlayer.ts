import { useRef, useEffect, useCallback, useState } from 'react';
import type { StreamingAudioPayload } from '../types';

interface AudioPlaybackItem {
  src: string;
  cleanup?: () => void;
}

export function createAudioPlaybackItem(audioBlob: Blob): AudioPlaybackItem {
  const src = URL.createObjectURL(audioBlob);

  return {
    src,
    cleanup: () => URL.revokeObjectURL(src),
  };
}

interface UseAudioPlayerReturn {
  playAudio: (audioData: Blob) => Promise<void>;
  playAudioStream: (streamingAudio: StreamingAudioPayload) => Promise<void>;
  stopAudio: () => void;
  isPlaying: boolean;
  audioLevel: number;
  audioRef: React.RefObject<HTMLAudioElement | null>;
}

export function useAudioPlayer(): UseAudioPlayerReturn {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [audioLevel, setAudioLevel] = useState(0);
  const audioQueueRef = useRef<AudioPlaybackItem[]>([]);
  const currentAudioRef = useRef<AudioPlaybackItem | null>(null);
  const isPlayingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const smoothedLevelRef = useRef(0);
  const pcmReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const pcmSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const pcmPlaybackGenerationRef = useRef(0);

  const setStreamAudioLevel = useCallback((samples: Float32Array) => {
    if (samples.length === 0) return;

    let sumSquares = 0;
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index]!;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / samples.length);
    const targetLevel = Math.min(0.7, Math.max(0.05, rms * 5));
    const currentLevel = smoothedLevelRef.current;
    const blend = targetLevel > currentLevel ? 0.28 : 0.1;
    const smoothedLevel = currentLevel + (targetLevel - currentLevel) * blend;
    smoothedLevelRef.current = smoothedLevel;
    setAudioLevel(smoothedLevel);
  }, []);

  const stopPcmPlayback = useCallback(() => {
    pcmPlaybackGenerationRef.current += 1;

    const reader = pcmReaderRef.current;
    pcmReaderRef.current = null;
    void reader?.cancel().catch(() => undefined);

    for (const sourceNode of pcmSourcesRef.current) {
      try {
        sourceNode.stop();
      } catch {
        // Ignore stop races when the source has already finished.
      }
      sourceNode.disconnect();
    }
    pcmSourcesRef.current.clear();
  }, []);

  const stopLevelTracking = useCallback(() => {
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = null;
    }
    smoothedLevelRef.current = 0;
    setAudioLevel(0);
  }, []);

  const startLevelTracking = useCallback(() => {
    const audio = audioRef.current;
    const AudioContextCtor = window.AudioContext ?? (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;

    if (!audio || !AudioContextCtor) {
      smoothedLevelRef.current = 0.28;
      setAudioLevel(0.28);
      return;
    }

    const audioContext = audioContextRef.current ?? new AudioContextCtor();
    audioContextRef.current = audioContext;

    if (!sourceNodeRef.current) {
      sourceNodeRef.current = audioContext.createMediaElementSource(audio);
    }

    const analyser = analyserRef.current ?? audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.82;
    analyserRef.current = analyser;

    sourceNodeRef.current.disconnect();
    analyser.disconnect();
    sourceNodeRef.current.connect(analyser);
    analyser.connect(audioContext.destination);

    void audioContext.resume();

    const data = new Uint8Array(analyser.frequencyBinCount);
    const tick = () => {
      analyser.getByteFrequencyData(data);
      const average = data.reduce((sum, value) => sum + value, 0) / (data.length * 255);
      const targetLevel = Math.min(0.62, average * 1.55);
      const currentLevel = smoothedLevelRef.current;
      const isAttacking = targetLevel > currentLevel;
      const blend = isAttacking ? 0.24 : 0.08;
      const smoothedLevel = currentLevel + (targetLevel - currentLevel) * blend;
      smoothedLevelRef.current = smoothedLevel;
      setAudioLevel(smoothedLevel);
      animationFrameRef.current = requestAnimationFrame(tick);
    };

    stopLevelTracking();
    animationFrameRef.current = requestAnimationFrame(tick);
  }, [stopLevelTracking]);

  const releaseAudioItem = useCallback((item: AudioPlaybackItem | null) => {
    item?.cleanup?.();
  }, []);

  const ensureAudioContext = useCallback(() => {
    const AudioContextCtor = window.AudioContext ?? (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;

    if (!AudioContextCtor) {
      return null;
    }

    const audioContext = audioContextRef.current ?? new AudioContextCtor();
    audioContextRef.current = audioContext;
    return audioContext;
  }, []);

  const playNextAudio = useCallback(async function playNextAudioImpl() {
    if (audioQueueRef.current.length === 0 || isPlayingRef.current) {
      return;
    }

    isPlayingRef.current = true;
    setIsPlaying(true);

    const audioItem = audioQueueRef.current.shift()!;
    currentAudioRef.current = audioItem;
    const audio = audioRef.current;

    if (audio) {
      audio.src = audioItem.src;

      audio.onended = () => {
        releaseAudioItem(currentAudioRef.current);
        currentAudioRef.current = null;
        isPlayingRef.current = false;
        stopLevelTracking();
        if (audioQueueRef.current.length > 0) {
          void playNextAudioImpl();
        } else {
          setIsPlaying(false);
        }
      };

      startLevelTracking();
      audio.play().catch((err) => {
        console.error('Playback error:', err);
        releaseAudioItem(currentAudioRef.current);
        currentAudioRef.current = null;
        isPlayingRef.current = false;
        stopLevelTracking();
        setIsPlaying(false);
      });
    }
  }, [releaseAudioItem, startLevelTracking, stopLevelTracking]);

  const playAudio = useCallback(async (audioData: Blob) => {
    stopPcmPlayback();
    audioQueueRef.current.push(createAudioPlaybackItem(audioData));
    if (!isPlayingRef.current) {
      await playNextAudio();
    }
  }, [playNextAudio, stopPcmPlayback]);

  const playAudioStream = useCallback(async (streamingAudio: StreamingAudioPayload) => {
    const audioContext = ensureAudioContext();
    if (!audioContext) {
      throw new Error('AudioContext is unavailable for streaming audio playback');
    }

    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = '';
    }
    releaseAudioItem(currentAudioRef.current);
    currentAudioRef.current = null;
    audioQueueRef.current.forEach(releaseAudioItem);
    audioQueueRef.current = [];
    stopLevelTracking();
    stopPcmPlayback();

    isPlayingRef.current = true;
    setIsPlaying(true);

    await audioContext.resume();

    const playbackGeneration = pcmPlaybackGenerationRef.current;
    const reader = streamingAudio.stream.getReader();
    pcmReaderRef.current = reader;

    let playbackCursor = Math.max(audioContext.currentTime + 0.06, audioContext.currentTime);
    let leftover = new Uint8Array(0);

    const schedulePcmChunk = (chunk: Uint8Array) => {
      if (chunk.byteLength < 2) {
        return;
      }

      const sampleCount = Math.floor(chunk.byteLength / 2);
      const floatSamples = new Float32Array(sampleCount);
      const view = new DataView(chunk.buffer, chunk.byteOffset, sampleCount * 2);
      for (let index = 0; index < sampleCount; index += 1) {
        floatSamples[index] = view.getInt16(index * 2, true) / 0x8000;
      }

      const buffer = audioContext.createBuffer(
        Math.max(1, streamingAudio.channels),
        floatSamples.length,
        streamingAudio.sampleRate,
      );
      buffer.copyToChannel(floatSamples, 0);

      const sourceNode = audioContext.createBufferSource();
      sourceNode.buffer = buffer;
      sourceNode.connect(audioContext.destination);
      pcmSourcesRef.current.add(sourceNode);
      sourceNode.onended = () => {
        pcmSourcesRef.current.delete(sourceNode);
        sourceNode.disconnect();
      };

      playbackCursor = Math.max(playbackCursor, audioContext.currentTime + 0.04);
      sourceNode.start(playbackCursor);
      playbackCursor += buffer.duration;
      setStreamAudioLevel(floatSamples);
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || pcmPlaybackGenerationRef.current !== playbackGeneration) {
          break;
        }

        let merged = value;
        if (leftover.byteLength > 0) {
          merged = new Uint8Array(leftover.byteLength + value.byteLength);
          merged.set(leftover, 0);
          merged.set(value, leftover.byteLength);
          leftover = new Uint8Array(0);
        }

        const evenLength = merged.byteLength - (merged.byteLength % 2);
        if (evenLength !== merged.byteLength) {
          leftover = merged.slice(evenLength);
        }

        if (evenLength > 0) {
          schedulePcmChunk(merged.slice(0, evenLength));
        }
      }

      if (leftover.byteLength >= 2 && pcmPlaybackGenerationRef.current === playbackGeneration) {
        schedulePcmChunk(leftover.slice(0, leftover.byteLength - (leftover.byteLength % 2)));
      }

      const waitMs = Math.max(0, (playbackCursor - audioContext.currentTime) * 1000);
      await new Promise((resolve) => {
        window.setTimeout(resolve, waitMs + 40);
      });
    } finally {
      if (pcmPlaybackGenerationRef.current === playbackGeneration) {
        pcmReaderRef.current = null;
        isPlayingRef.current = false;
        setIsPlaying(false);
        stopLevelTracking();
      }
    }
  }, [ensureAudioContext, releaseAudioItem, setStreamAudioLevel, stopLevelTracking, stopPcmPlayback]);

  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = '';
    }
    stopPcmPlayback();
    stopLevelTracking();
    releaseAudioItem(currentAudioRef.current);
    currentAudioRef.current = null;
    audioQueueRef.current.forEach(releaseAudioItem);
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, [releaseAudioItem, stopLevelTracking, stopPcmPlayback]);

  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, [stopAudio]);

  return {
    playAudio,
    playAudioStream,
    stopAudio,
    isPlaying,
    audioLevel,
    audioRef,
  };
}
