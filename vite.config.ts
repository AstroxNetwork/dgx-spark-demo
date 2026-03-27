import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { spawn } from 'node:child_process'
import type { Plugin } from 'vite'
import { toPlainTextForSpeech } from './src/utils/plainText'

const OPENCLAW_COMMAND = process.env.OPENCLAW_COMMAND ?? 'openclaw';
const OPENCLAW_DEFAULT_AGENT = process.env.OPENCLAW_AGENT ?? 'dev';
const OPENCLAW_OLLAMA_API_KEY = process.env.OLLAMA_API_KEY ?? 'ollama-local';
let openClawTurnQueue: Promise<void> = Promise.resolve();

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
    plugins: [react(), createOpenClawBridgePlugin()],
    server: {
      proxy,
    },
    preview: {
      proxy,
    },
  };
})
