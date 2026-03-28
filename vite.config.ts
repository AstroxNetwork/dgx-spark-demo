import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import type { Plugin } from 'vite'
import { toPlainTextForSpeech } from './src/utils/plainText'
import { TtsCoalescer } from './server/ttsSidecar'

const OPENCLAW_COMMAND = process.env.OPENCLAW_COMMAND ?? 'openclaw';
const OPENCLAW_DEFAULT_AGENT = process.env.OPENCLAW_AGENT ?? 'dev';
const OPENCLAW_OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? 'ollama-local';
const TTS_SIDE_CAR_BUFFER_MS = 900;
const TTS_SIDE_CAR_MAX_BUFFERED_CHARS = 72;
const TTS_SIDE_CAR_SYNTHESIZE_CONCURRENCY = 2;
let openClawTurnQueue: Promise<void> = Promise.resolve();
let openClawTurnEpoch = 0;
let activeOpenClawChild: ReturnType<typeof spawn> | null = null;

function normalizeBridgeMessageContent(content: string): string {
  return content
    .replace(/^[🎤⌨️]\s*/u, '')
    .replace(/\s+/g, ' ')
    .trim();
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

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      }
      resolve(Buffer.concat(chunks));
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
  const epoch = openClawTurnEpoch;
  const run = openClawTurnQueue.then(async () => {
    if (epoch !== openClawTurnEpoch) {
      throw new Error('OpenClaw turn queue cleared');
    }
    return await task();
  }, async () => {
    if (epoch !== openClawTurnEpoch) {
      throw new Error('OpenClaw turn queue cleared');
    }
    return await task();
  });
  openClawTurnQueue = run.then(() => undefined, () => undefined);
  return run;
}

function interruptOpenClawTurnQueue(): void {
  openClawTurnEpoch += 1;
  openClawTurnQueue = Promise.resolve();

  if (activeOpenClawChild && !activeOpenClawChild.killed) {
    activeOpenClawChild.kill('SIGTERM');
  }
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
    activeOpenClawChild = child;

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
      if (activeOpenClawChild === child) {
        activeOpenClawChild = null;
      }
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
        interruptOpenClawTurnQueue();
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
    instructions: string;
    language: string;
    doSample: boolean;
    temperature: number;
    topK: number;
    topP: number;
    repetitionPenalty: number;
    seed?: number;
  }>();
  const coalescer = new TtsCoalescer({
    bufferMs: TTS_SIDE_CAR_BUFFER_MS,
    maxBufferedChars: TTS_SIDE_CAR_MAX_BUFFERED_CHARS,
    synthesizeConcurrency: TTS_SIDE_CAR_SYNTHESIZE_CONCURRENCY,
    synthesize: async (sessionId, text) => {
      const currentRequestState = sessionState.get(sessionId);
      if (!currentRequestState) {
        throw new Error(`Unknown TTS sidecar session: ${sessionId}`);
      }

      const response = await fetch(`${ttsTarget}/audio/speech`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
          input: text,
          voice: currentRequestState.voice,
          instructions: currentRequestState.instructions,
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

      return await response.blob();
    },
  });

  const install = (middlewares: {
    use: (
      path: string,
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
        next: (err?: unknown) => void,
      ) => void | Promise<void>,
    ) => void;
  }) => {
    middlewares.use('/tts-sidecar-api/audio/segment-speech', async (req, res, next) => {
      if (req.method !== 'POST') {
        next();
        return;
      }

      try {
        const rawBody = await readRawBody(req);
        const body = JSON.parse(rawBody.toString('utf8')) as {
          input?: string;
          voice?: string;
          instructions?: string;
          language?: string;
          do_sample?: boolean;
          temperature?: number;
          top_k?: number;
          top_p?: number;
          repetition_penalty?: number;
          seed?: number;
          session_id?: string;
          sequence?: number;
          flush?: boolean;
          priority?: number;
        };

        const sessionId = body.session_id?.trim();
        if (!sessionId) {
          sendJson(res, 400, { error: 'session_id is required' });
          return;
        }

        sessionState.set(sessionId, {
          voice: body.voice ?? 'Vivian',
          instructions: body.instructions ?? '',
          language: body.language ?? 'Chinese',
          doSample: body.do_sample ?? false,
          temperature: body.temperature ?? 0.5,
          topK: body.top_k ?? 10,
          topP: body.top_p ?? 0.8,
          repetitionPenalty: body.repetition_penalty ?? 1.05,
          seed: body.seed,
        });

        const result = await coalescer.enqueue({
          sessionId,
          sequence: typeof body.sequence === 'number' ? body.sequence : undefined,
          priority: typeof body.priority === 'number' ? body.priority : 1,
          text: typeof body.input === 'string' ? body.input : '',
          flush: Boolean(body.flush),
        });

        if (result.merged || !result.audio) {
          sendJson(res, 200, { merged: true });
          return;
        }

        res.statusCode = 200;
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.end(Buffer.from(await result.audio.arrayBuffer()));
      } catch (error) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : 'TTS sidecar failed',
        });
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

function buildProxyConfig(asrTarget: string, ttsTarget: string) {
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
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const asrPort = env.DGX_ASR_PORT || '18002';
  const ttsPort = env.DGX_TTS_PORT || '18015';
  const asrTarget = `http://127.0.0.1:${asrPort}/v1`;
  const ttsTarget = `http://127.0.0.1:${ttsPort}/v1`;
  const proxy = buildProxyConfig(asrTarget, ttsTarget);

  return {
    plugins: [
      react(),
      createOpenClawBridgePlugin(),
      createTtsSidecarPlugin(ttsTarget),
    ],
    server: {
      proxy,
    },
    preview: {
      proxy,
    },
  };
})
