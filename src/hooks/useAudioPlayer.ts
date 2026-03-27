import { useRef, useEffect, useCallback, useState } from 'react';

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
    audioQueueRef.current.push(createAudioPlaybackItem(audioData));
    if (!isPlayingRef.current) {
      await playNextAudio();
    }
  }, [playNextAudio]);

  const stopAudio = useCallback(() => {
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.src = '';
    }
    stopLevelTracking();
    releaseAudioItem(currentAudioRef.current);
    currentAudioRef.current = null;
    audioQueueRef.current.forEach(releaseAudioItem);
    audioQueueRef.current = [];
    isPlayingRef.current = false;
    setIsPlaying(false);
  }, [releaseAudioItem, stopLevelTracking]);

  useEffect(() => {
    return () => {
      stopAudio();
    };
  }, [stopAudio]);

  return {
    playAudio,
    stopAudio,
    isPlaying,
    audioLevel,
    audioRef,
  };
}
