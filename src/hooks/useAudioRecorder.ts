import { useState, useRef, useCallback } from 'react';

interface UseAudioRecorderReturn {
  isRecording: boolean;
  startRecording: () => Promise<void>;
  stopRecording: (options?: { shouldSend?: boolean }) => Promise<Blob | null>;
  error: string | null;
}

const MIN_RECORDING_MS = 300;
const MIN_RECORDING_BYTES = 1024;

export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingStartedAtRef = useRef<number | null>(null);

  const cleanupStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const startRecording = useCallback(async () => {
    try {
      setError(null);
      chunksRef.current = [];
      recordingStartedAtRef.current = Date.now();

      const mediaDevices = navigator.mediaDevices;
      if (!mediaDevices?.getUserMedia) {
        recordingStartedAtRef.current = null;
        setError('当前页面无法访问麦克风。请使用 localhost 或 HTTPS 打开，或者切换到键盘输入。');
        return;
      }

      const stream = await mediaDevices.getUserMedia({
        audio: {
          sampleRate: 24000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      mediaStreamRef.current = stream;
      const mimeType = typeof MediaRecorder.isTypeSupported === 'function'
        && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
      });

      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        cleanupStream();
      };

      mediaRecorder.start(100); // Collect data every 100ms
      setIsRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to access microphone');
      console.error('Recording error:', err);
    }
  }, [cleanupStream]);

  const stopRecording = useCallback((options?: { shouldSend?: boolean }): Promise<Blob | null> => {
    return new Promise((resolve) => {
      if (mediaRecorderRef.current) {
        const recorder = mediaRecorderRef.current;
        const mimeType = recorder.mimeType || 'audio/webm;codecs=opus';
        const recordingDurationMs = recordingStartedAtRef.current === null
          ? 0
          : Date.now() - recordingStartedAtRef.current;
        const shouldSend = options?.shouldSend ?? true;

        recorder.onstop = () => {
          const blob = new Blob(chunksRef.current, { type: mimeType });
          recordingStartedAtRef.current = null;
          cleanupStream();
          mediaRecorderRef.current = null;
          setIsRecording(false);
          if (!shouldSend) {
            resolve(null);
            return;
          }

          if (recordingDurationMs < MIN_RECORDING_MS || blob.size < MIN_RECORDING_BYTES) {
            setError('说话太短，请至少按住 0.3 秒');
            resolve(null);
            return;
          }

          setError(null);
          resolve(blob);
        };
        recorder.stop();
      } else {
        resolve(null);
      }
    });
  }, [cleanupStream]);

  return {
    isRecording,
    startRecording,
    stopRecording,
    error,
  };
}
