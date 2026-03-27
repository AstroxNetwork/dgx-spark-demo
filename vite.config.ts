import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import type { Plugin } from 'vite'
import { TtsCoalescer } from './server/ttsSidecar'
import { toPlainTextForSpeech } from './src/utils/plainText'

const OPENCLAW_COMMAND = process.env.OPENCLAW_COMMAND ?? 'openclaw';
const OPENCLAW_DEFAULT_AGENT = process.env.OPENCLAW_AGENT ?? 'dev';
const OPENCLAW_OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? 'ollama-local';
const TTS_SIDE_CAR_BUFFER_MS = 900;
const TTS_SIDE_CAR_MAX_BUFFERED_CHARS = 72;
const TTS_SIDE_CAR_SYNTHESIZE_CONCURRENCY = 2;
let openClawTurnQueue: Promise<void> = Promise.resolve();

function normalizeBridgeMessageContent(content: string): string {
  return content
    .replace(/^[🎤⌨️]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeTextForLog(text: string, maxLength = 120): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}...`;
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise(async (resolve, reject) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }

      resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
    } catch (error) {
      reject(error);
    }
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function buildOpenClawPrompt(params: {
  userText: string;
}): string {
  const trimmedUserText = params.userText.trim();
  return normalizeBridgeMessageContent(trimmedUserText);
}

function parseOpenClawText(output: string): string {
  const trimmed = output.trim();
  if (!trimmed) {
    throw new Error('OpenClaw returned empty output');
  }

  const firstJsonIndex = trimmed.indexOf('{');
  const jsonCandidate = firstJsonIndex >= 0 ? trimmed.slice(firstJsonIndex) : trimmed;
  const parsed = JSON.parse(jsonCandidate) as {
    payloads?: Array<{ text?: string | null }>;
  };
  const text = (parsed.payloads ?? [])
    .map((payload) => payload.text?.trim() ?? '')
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (!text) {
    throw new Error('OpenClaw returned no text payload');
  }

  return toPlainTextForSpeech(text);
}

function createOpenClawRequestSessionId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function enqueueOpenClawTurn<T>(task: () => Promise<T>): Promise<T> {
  const run = openClawTurnQueue.then(task, task);
  openClawTurnQueue = run.then(() => undefined, () => undefined);
  return run;
}

function runOpenClawAgent(params: {
  message: string;
  sessionId: string;
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      OPENCLAW_COMMAND,
      [
        'agent',
        '--local',
        '--agent',
        OPENCLAW_DEFAULT_AGENT,
        '--session-id',
        params.sessionId,
        '--message',
        params.message,
        '--json',
      ],
      {
        env: {
          ...process.env,
          PATH: `${process.env.HOME ?? ''}/.local/bin:${process.env.PATH ?? ''}`,
          OLLAMA_API_KEY: OPENCLAW_OLLAMA_API_KEY,
        },
      },
    );

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      reject(error);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`OpenClaw exited with code ${code}: ${stderr || stdout}`));
        return;
      }

      try {
        resolve(parseOpenClawText(`${stdout}\n${stderr}`));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function createOpenClawBridgePlugin(): Plugin {
  const install = (middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void | Promise<void>) => void }) => {
    middlewares.use('/openclaw-api/agent', async (req, res, next) => {
      if (req.method !== 'POST') {
        next();
        return;
      }

      try {
        const body = await readJsonBody<{
          userText?: string;
          sessionId?: string;
          think?: boolean;
        }>(req);
        const userText = body.userText?.trim() ?? '';
        if (!userText) {
          sendJson(res, 400, { error: 'userText is required' });
          return;
        }

        const sessionId = createOpenClawRequestSessionId(body.sessionId?.trim() || 'voice-chat');
        const message = buildOpenClawPrompt({ userText });
        const text = await enqueueOpenClawTurn(() => runOpenClawAgent({ message, sessionId }));

        sendJson(res, 200, { text, sessionId });
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : 'OpenClaw bridge failed',
        });
      }
    });

    middlewares.use('/openclaw-api/warmup', async (req, res, next) => {
      if (req.method !== 'POST') {
        next();
        return;
      }

      try {
        await enqueueOpenClawTurn(() => runOpenClawAgent({
          sessionId: createOpenClawRequestSessionId('warmup'),
          message: 'Reply with exactly OK.',
        }));
        sendJson(res, 200, { ok: true });
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : 'OpenClaw warmup failed',
        });
      }
    });
  };

  return {
    name: 'openclaw-bridge',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

function createTtsSidecarPlugin(ttsTarget: string): Plugin {
  const sessionState = new Map<string, {
    voice: string;
    language: string;
    doSample: boolean;
    temperature: number;
    topK: number;
    topP: number;
    repetitionPenalty: number;
    seed: number;
  }>();
  const coalescer = new TtsCoalescer({
    bufferMs: TTS_SIDE_CAR_BUFFER_MS,
    maxBufferedChars: TTS_SIDE_CAR_MAX_BUFFERED_CHARS,
    synthesizeConcurrency: TTS_SIDE_CAR_SYNTHESIZE_CONCURRENCY,
    logger: (message) => {
      console.log(message);
    },
    synthesize: async (sessionId, text) => {
      const currentRequestState = sessionState.get(sessionId);
      if (!currentRequestState) {
        throw new Error(`Unknown TTS sidecar session: ${sessionId}`);
      }

      const startedAt = Date.now();
      console.log(
        `[tts-upstream] request session=${sessionId} voice=${currentRequestState.voice} language=${currentRequestState.language} textLen=${text.length} preview=${JSON.stringify(summarizeTextForLog(text))}`,
      );
      const response = await fetch(`${ttsTarget}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
          input: text,
          voice: currentRequestState.voice,
          speed: 1,
          task_type: 'CustomVoice',
          language: currentRequestState.language,
          do_sample: currentRequestState.doSample,
          temperature: currentRequestState.temperature,
          top_k: currentRequestState.topK,
          top_p: currentRequestState.topP,
          repetition_penalty: currentRequestState.repetitionPenalty,
          seed: currentRequestState.seed,
          response_format: 'wav',
        }),
      });

      if (!response.ok) {
        throw new Error(`Upstream TTS error: ${response.status} ${await response.text()}`);
      }

      const audio = await response.blob();
      console.log(
        `[tts-upstream] response session=${sessionId} textLen=${text.length} bytes=${audio.size} elapsedMs=${Date.now() - startedAt}`,
      );
      return audio;
    },
  });

  const install = (middlewares: { use: (path: string, handler: (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => void | Promise<void>) => void }) => {
    middlewares.use('/tts-sidecar-api/audio/segment-speech', async (req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
      if (req.method !== 'POST') {
        next();
        return;
      }

      try {
        const chunks: Uint8Array[] = [];
        for await (const chunk of req) {
          chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
        }

        const rawBody = Buffer.concat(chunks).toString('utf8');
        const body = JSON.parse(rawBody) as {
          input?: string;
          voice?: string;
          language?: string;
          do_sample?: boolean;
          temperature?: number;
          top_k?: number;
          top_p?: number;
          repetition_penalty?: number;
          seed?: number;
          session_id?: string;
          flush?: boolean;
          priority?: number;
          sequence?: number;
        };

        if (!body.session_id) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ error: 'session_id is required' }));
          return;
        }

        const requestState = {
          voice: body.voice ?? 'Vivian',
          language: body.language ?? 'Chinese',
          doSample: body.do_sample ?? false,
          temperature: body.temperature ?? 0.5,
          topK: body.top_k ?? 10,
          topP: body.top_p ?? 0.8,
          repetitionPenalty: body.repetition_penalty ?? 1.05,
          seed: body.seed ?? 42,
        };
        sessionState.set(body.session_id, requestState);
        console.log(
          `[tts-sidecar] request session=${body.session_id} textLen=${(body.input ?? '').length} flush=${body.flush ?? false} priority=${body.priority ?? 1} sequence=${body.sequence ?? 'auto'} voice=${requestState.voice} language=${requestState.language} preview=${JSON.stringify(summarizeTextForLog(body.input ?? ''))}`,
        );

        const result = await coalescer.enqueue({
          sessionId: body.session_id,
          text: body.input ?? '',
          flush: body.flush ?? false,
          priority: body.priority ?? 1,
          sequence: body.sequence,
        });

        if (result.merged || !result.audio) {
          console.log(
            `[tts-sidecar] merged session=${body.session_id} textLen=${(body.input ?? '').length} flush=${body.flush ?? false} startSequence=${result.startSequence ?? 'na'} endSequence=${result.endSequence ?? 'na'}`,
          );
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({
            merged: true,
            startSequence: result.startSequence,
            endSequence: result.endSequence,
          }));
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'audio/wav');
        if (typeof result.startSequence === 'number') {
          res.setHeader('X-TTS-Start-Sequence', String(result.startSequence));
        }
        if (typeof result.endSequence === 'number') {
          res.setHeader('X-TTS-End-Sequence', String(result.endSequence));
        }
        const arrayBuffer = await result.audio.arrayBuffer();
        console.log(
          `[tts-sidecar] audio session=${body.session_id} bytes=${arrayBuffer.byteLength} textLen=${(body.input ?? '').length} flush=${body.flush ?? false} startSequence=${result.startSequence ?? 'na'} endSequence=${result.endSequence ?? 'na'}`,
        );
        res.end(Buffer.from(arrayBuffer));
      } catch (error) {
        console.error(
          `[tts-sidecar] request-error error=${error instanceof Error ? error.message : String(error)}`,
        );
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown error' }));
      }
    });
  };

  return {
    name: 'tts-sidecar',
    configureServer(server) {
      install(server.middlewares);
    },
    configurePreviewServer(server) {
      install(server.middlewares);
    },
  };
}

function buildProxyConfig(asrTarget: string, ttsTarget: string, ttsStreamTarget: string) {
  return {
    '/asr-api': {
      target: asrTarget,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/asr-api/, ''),
    },
    '/tts-api': {
      target: ttsTarget,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/tts-api/, ''),
    },
    '/tts-stream-api': {
      target: ttsStreamTarget,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(/^\/tts-stream-api/, ''),
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const dgxHost = env.DGX_HOST;
  if (!dgxHost) {
    throw new Error('DGX_HOST is required. Set it in .env or the environment before starting Vite.');
  }
  const asrPort = env.DGX_ASR_PORT || '18002';
  const ttsPort = env.DGX_TTS_PORT || '18015';
  const ttsStreamPort = env.DGX_TTS_STREAM_PORT || '18005';
  const asrTarget = `http://${dgxHost}:${asrPort}/v1`;
  const ttsTarget = `http://${dgxHost}:${ttsPort}/v1`;
  const ttsStreamTarget = `http://${dgxHost}:${ttsStreamPort}/v1`;
  const proxy = buildProxyConfig(asrTarget, ttsTarget, ttsStreamTarget);

  return {
    plugins: [react(), createOpenClawBridgePlugin(), createTtsSidecarPlugin(ttsTarget)],
    server: {
      proxy,
    },
    preview: {
      proxy,
    },
  };
})
