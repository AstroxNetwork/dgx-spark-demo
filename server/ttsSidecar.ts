export interface TtsCoalescerRequest {
  sessionId: string;
  text: string;
  flush?: boolean;
  priority?: number;
}

export interface TtsCoalescerResult {
  merged: boolean;
  audio: Blob | null;
}

interface PendingBatch {
  text: string;
  timer: ReturnType<typeof setTimeout> | null;
  resolveOwner: (result: TtsCoalescerResult) => void;
  rejectOwner: (error: unknown) => void;
  settled: boolean;
  priority: number;
  sequence: number;
}

interface TtsCoalescerOptions {
  bufferMs: number;
  maxBufferedChars: number;
  synthesize: (sessionId: string, text: string) => Promise<Blob>;
  synthesizeConcurrency?: number;
}

interface PendingSynthesisJob {
  sessionId: string;
  batch: PendingBatch;
  resolve: (audio: Blob) => void;
  reject: (error: unknown) => void;
}

export class TtsCoalescer {
  private readonly sessions = new Map<string, PendingBatch>();
  private readonly bufferMs: number;
  private readonly maxBufferedChars: number;
  private readonly synthesize: (sessionId: string, text: string) => Promise<Blob>;
  private readonly synthesizeConcurrency: number;
  private readonly pendingSynthesisJobs: PendingSynthesisJob[] = [];
  private activeSynthesis = 0;
  private nextSequence = 0;

  constructor(options: TtsCoalescerOptions) {
    this.bufferMs = options.bufferMs;
    this.maxBufferedChars = options.maxBufferedChars;
    this.synthesize = options.synthesize;
    this.synthesizeConcurrency = Math.max(1, options.synthesizeConcurrency ?? 1);
  }

  async enqueue(request: TtsCoalescerRequest): Promise<TtsCoalescerResult> {
    const hasText = request.text.trim().length > 0;
    const existing = this.sessions.get(request.sessionId);
    if (!existing) {
      if (!hasText) {
        return { merged: true, audio: null };
      }

      return await this.createBatch(request);
    }

    if (hasText) {
      existing.text += request.text;
    }
    existing.priority = Math.min(existing.priority, request.priority ?? 1);

    if (request.flush || existing.text.length >= this.maxBufferedChars) {
      void this.flushSession(request.sessionId, existing);
    }

    return { merged: true, audio: null };
  }

  private async createBatch(request: TtsCoalescerRequest): Promise<TtsCoalescerResult> {
    return await new Promise<TtsCoalescerResult>((resolve, reject) => {
      const batch: PendingBatch = {
        text: request.text,
        timer: null,
        resolveOwner: resolve,
        rejectOwner: reject,
        settled: false,
        priority: request.priority ?? 1,
        sequence: this.nextSequence++,
      };

      this.sessions.set(request.sessionId, batch);

      if (request.flush || request.text.length >= this.maxBufferedChars) {
        void this.flushSession(request.sessionId, batch);
        return;
      }

      batch.timer = setTimeout(() => {
        void this.flushSession(request.sessionId, batch);
      }, this.bufferMs);
    });
  }

  private async flushSession(sessionId: string, batch: PendingBatch): Promise<void> {
    if (batch.settled) return;

    batch.settled = true;
    if (batch.timer) {
      clearTimeout(batch.timer);
      batch.timer = null;
    }

    this.sessions.delete(sessionId);

    if (!batch.text.trim()) {
      batch.resolveOwner({ merged: true, audio: null });
      return;
    }

    try {
      const audio = await this.scheduleSynthesis(sessionId, batch);
      batch.resolveOwner({ merged: false, audio });
    } catch (error) {
      batch.rejectOwner(error);
    }
  }

  private async scheduleSynthesis(sessionId: string, batch: PendingBatch): Promise<Blob> {
    return await new Promise<Blob>((resolve, reject) => {
      this.pendingSynthesisJobs.push({ sessionId, batch, resolve, reject });
      this.pendingSynthesisJobs.sort((left, right) => (
        left.batch.priority - right.batch.priority
        || left.batch.sequence - right.batch.sequence
      ));
      this.drainSynthesisQueue();
    });
  }

  private drainSynthesisQueue(): void {
    while (this.activeSynthesis < this.synthesizeConcurrency && this.pendingSynthesisJobs.length > 0) {
      const nextJob = this.pendingSynthesisJobs.shift();
      if (!nextJob) {
        return;
      }

      this.activeSynthesis += 1;
      void this.synthesize(nextJob.sessionId, nextJob.batch.text)
        .then((audio) => {
          nextJob.resolve(audio);
        })
        .catch((error) => {
          nextJob.reject(error);
        })
        .finally(() => {
          this.activeSynthesis -= 1;
          this.drainSynthesisQueue();
        });
    }
  }
}
