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
  const mediaAudioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceNodeRef = useRef<MediaElementAudioSourceNode | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const smoothedLevelRef = useRef(0);
  const pcmAudioContextRef = useRef<AudioContext | null>(null);
  const pcmReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const pcmPlaybackGenerationRef = useRef(0);
  const pcmWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const pcmWorkletReadyRef = useRef<Promise<AudioWorkletNode> | null>(null);
  const pcmDrainResolversRef = useRef<Map<number, () => void>>(new Map());

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

    for (const resolve of pcmDrainResolversRef.current.values()) {
      resolve();
    }
    pcmDrainResolversRef.current.clear();

    const node = pcmWorkletNodeRef.current;
    if (node) {
      node.port.postMessage({ type: 'clear', playbackId: pcmPlaybackGenerationRef.current });
    }
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

    const audioContext = mediaAudioContextRef.current ?? new AudioContextCtor();
    mediaAudioContextRef.current = audioContext;

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

  const getAudioContextCtor = useCallback(() => {
    const AudioContextCtor = window.AudioContext ?? (window as typeof window & {
      webkitAudioContext?: typeof AudioContext;
    }).webkitAudioContext;

    return AudioContextCtor ?? null;
  }, []);

  const ensurePcmAudioContext = useCallback((sampleRate: number) => {
    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) {
      return null;
    }

    const current = pcmAudioContextRef.current;
    if (current && current.sampleRate === sampleRate) {
      return current;
    }

    if (current) {
      void current.close().catch(() => undefined);
      pcmAudioContextRef.current = null;
      pcmWorkletNodeRef.current = null;
      pcmWorkletReadyRef.current = null;
    }

    const audioContext = new AudioContextCtor({ sampleRate });
    pcmAudioContextRef.current = audioContext;
    return audioContext;
  }, [getAudioContextCtor]);

  const ensurePcmWorkletNode = useCallback(async (audioContext: AudioContext) => {
    const existingNode = pcmWorkletNodeRef.current;
    if (existingNode && existingNode.context === audioContext) {
      return existingNode;
    }

    if (pcmWorkletReadyRef.current) {
      return pcmWorkletReadyRef.current;
    }

    const ready = (async () => {
      await audioContext.audioWorklet.addModule(
        new URL('../audio/pcm-stream-player.worklet.js', import.meta.url),
      );

      const node = new AudioWorkletNode(audioContext, 'pcm-stream-player', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      node.port.onmessage = (event) => {
        const data = event.data ?? {};
        if (data.type !== 'drained') {
          return;
        }

        const playbackId = Number(data.playbackId ?? -1);
        const resolve = pcmDrainResolversRef.current.get(playbackId);
        if (resolve) {
          pcmDrainResolversRef.current.delete(playbackId);
          resolve();
        }
      };

      node.connect(audioContext.destination);
      pcmWorkletNodeRef.current = node;
      pcmWorkletReadyRef.current = null;
      return node;
    })();

    pcmWorkletReadyRef.current = ready;
    return ready;
  }, []);

  const decodePcmChunk = useCallback((chunk: Uint8Array, channels: number) => {
    const bytesPerFrame = Math.max(1, channels) * 2;
    const evenLength = chunk.byteLength - (chunk.byteLength % bytesPerFrame);
    if (evenLength < bytesPerFrame) {
      return null;
    }

    const frameCount = evenLength / bytesPerFrame;
    const samples = new Float32Array(frameCount);
    const view = new DataView(chunk.buffer, chunk.byteOffset, evenLength);

    for (let frame = 0; frame < frameCount; frame += 1) {
      let mixed = 0;
      for (let channel = 0; channel < channels; channel += 1) {
        const offset = (frame * channels + channel) * 2;
        mixed += view.getInt16(offset, true) / 0x8000;
      }
      samples[frame] = mixed / channels;
    }

    return {
      samples,
      consumedBytes: evenLength,
    };
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
    const audioContext = ensurePcmAudioContext(streamingAudio.sampleRate);
    if (!audioContext) {
      throw new Error('AudioContext is unavailable for streaming audio playback');
    }
    if (!audioContext.audioWorklet) {
      throw new Error('AudioWorklet is unavailable for streaming audio playback');
    }

    const workletNode = await ensurePcmWorkletNode(audioContext);

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
    let pending = new Uint8Array(0);
    let totalBytes = 0;
    let scheduledSamples = 0;
    const playbackComplete = new Promise<void>((resolve) => {
      pcmDrainResolversRef.current.set(playbackGeneration, resolve);
    });
    workletNode.port.postMessage({ type: 'clear', playbackId: playbackGeneration });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || pcmPlaybackGenerationRef.current !== playbackGeneration) {
          break;
        }
        totalBytes += value.byteLength;
        const merged = new Uint8Array(pending.byteLength + value.byteLength);
        merged.set(pending, 0);
        merged.set(value, pending.byteLength);

        const decoded = decodePcmChunk(merged, Math.max(1, streamingAudio.channels));
        if (!decoded) {
          pending = merged;
          continue;
        }
        const { samples, consumedBytes } = decoded;
        pending = merged.subarray(consumedBytes);
        scheduledSamples += samples.length;
        setStreamAudioLevel(samples);
        workletNode.port.postMessage(
          { type: 'push', samples, playbackId: playbackGeneration },
          [samples.buffer],
        );
      }

      if (pcmPlaybackGenerationRef.current !== playbackGeneration || totalBytes < 2) {
        pcmDrainResolversRef.current.delete(playbackGeneration);
        return;
      }

      workletNode.port.postMessage({ type: 'end', playbackId: playbackGeneration });

      const durationSeconds = scheduledSamples / streamingAudio.sampleRate;
      console.log('[stream-audio] worklet playback', {
        receivedBytes: totalBytes,
        scheduledBytes: scheduledSamples * 2,
        sampleRate: streamingAudio.sampleRate,
        channels: streamingAudio.channels,
        durationSeconds: Number(durationSeconds.toFixed(3)),
      });

      await playbackComplete;
    } finally {
      if (pcmPlaybackGenerationRef.current === playbackGeneration) {
        pcmReaderRef.current = null;
        isPlayingRef.current = false;
        setIsPlaying(false);
        stopLevelTracking();
      }
      pcmDrainResolversRef.current.delete(playbackGeneration);
    }
  }, [
    decodePcmChunk,
    ensurePcmAudioContext,
    ensurePcmWorkletNode,
    releaseAudioItem,
    setStreamAudioLevel,
    stopLevelTracking,
    stopPcmPlayback,
  ]);

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
      void pcmAudioContextRef.current?.close().catch(() => undefined);
      void mediaAudioContextRef.current?.close().catch(() => undefined);
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
