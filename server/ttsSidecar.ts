export interface TtsCoalescerRequest {
  sessionId: string;
  text: string;
  sequence?: number;
  flush?: boolean;
  priority?: number;
}

export interface TtsCoalescerResult {
  merged: boolean;
  audio: Blob | null;
}

interface PendingBatch {
  segments: Map<number, string>;
  timer: ReturnType<typeof setTimeout> | null;
  waiters: Map<number, {
    resolve: (result: TtsCoalescerResult) => void;
    reject: (error: unknown) => void;
  }>;
  settled: boolean;
  priority: number;
  minSequence: number;
  batchSequence: number;
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
  private nextBatchSequence = 0;
  private nextRequestSequence = 0;

  constructor(options: TtsCoalescerOptions) {
    this.bufferMs = options.bufferMs;
    this.maxBufferedChars = options.maxBufferedChars;
    this.synthesize = options.synthesize;
    this.synthesizeConcurrency = Math.max(1, options.synthesizeConcurrency ?? 1);
  }

  async enqueue(request: TtsCoalescerRequest): Promise<TtsCoalescerResult> {
    const hasText = request.text.trim().length > 0;
    const requestSequence = this.resolveRequestSequence(request.sequence);
    const existing = this.sessions.get(request.sessionId);
    if (!existing) {
      if (!hasText && !request.flush) {
        return { merged: true, audio: null };
      }

      return await this.createBatch(request, requestSequence);
    }

    if (hasText || request.flush) {
      return await this.mergeIntoExistingBatch(existing, request, requestSequence);
    }

    return { merged: true, audio: null };
  }

  private async createBatch(
    request: TtsCoalescerRequest,
    requestSequence: number,
  ): Promise<TtsCoalescerResult> {
    return await new Promise<TtsCoalescerResult>((resolve, reject) => {
      const batch: PendingBatch = {
        segments: new Map(),
        timer: null,
        waiters: new Map(),
        settled: false,
        priority: request.priority ?? 1,
        minSequence: requestSequence,
        batchSequence: this.nextBatchSequence++,
      };

      if (request.text.trim().length > 0) {
        batch.segments.set(requestSequence, request.text);
      }
      batch.waiters.set(requestSequence, { resolve, reject });
      this.sessions.set(request.sessionId, batch);

      if (request.flush || this.getBatchText(batch).length >= this.maxBufferedChars) {
        void this.flushSession(request.sessionId, batch);
        return;
      }

      batch.timer = setTimeout(() => {
        void this.flushSession(request.sessionId, batch);
      }, this.bufferMs);
    });
  }

  private async mergeIntoExistingBatch(
    batch: PendingBatch,
    request: TtsCoalescerRequest,
    requestSequence: number,
  ): Promise<TtsCoalescerResult> {
    return await new Promise<TtsCoalescerResult>((resolve, reject) => {
      if (request.text.trim().length > 0) {
        batch.segments.set(requestSequence, request.text);
      }
      batch.waiters.set(requestSequence, { resolve, reject });
      batch.priority = Math.min(batch.priority, request.priority ?? 1);
      batch.minSequence = Math.min(batch.minSequence, requestSequence);

      if (request.flush || this.getBatchText(batch).length >= this.maxBufferedChars) {
        void this.flushSession(request.sessionId, batch);
      }
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

    const batchText = this.getBatchText(batch);
    if (!batchText.trim()) {
      this.resolveMergedBatch(batch, null);
      return;
    }

    try {
      const audio = await this.scheduleSynthesis(sessionId, batch);
      this.resolveMergedBatch(batch, audio);
    } catch (error) {
      this.rejectBatch(batch, error);
    }
  }

  private async scheduleSynthesis(sessionId: string, batch: PendingBatch): Promise<Blob> {
    return await new Promise<Blob>((resolve, reject) => {
      this.pendingSynthesisJobs.push({
        sessionId,
        batch: {
          ...batch,
          segments: new Map(batch.segments),
          waiters: new Map(batch.waiters),
        },
        resolve,
        reject,
      });
      this.pendingSynthesisJobs.sort((left, right) => (
        left.batch.priority - right.batch.priority
        || left.batch.minSequence - right.batch.minSequence
        || left.batch.batchSequence - right.batch.batchSequence
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
      const jobText = this.getBatchText(nextJob.batch);
      void this.synthesize(nextJob.sessionId, jobText)
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

  private resolveRequestSequence(sequence?: number): number {
    if (typeof sequence === 'number' && Number.isFinite(sequence)) {
      return sequence;
    }

    return this.nextRequestSequence++;
  }

  private getBatchText(batch: PendingBatch): string {
    return [...batch.segments.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, text]) => text)
      .join('');
  }

  private resolveMergedBatch(batch: PendingBatch, audio: Blob | null): void {
    const orderedSequences = [...batch.waiters.keys()].sort((left, right) => left - right);
    const ownerSequence = orderedSequences[0];

    for (const sequence of orderedSequences) {
      const waiter = batch.waiters.get(sequence);
      if (!waiter) continue;

      waiter.resolve({
        merged: sequence !== ownerSequence || audio === null,
        audio: sequence === ownerSequence ? audio : null,
      });
    }
  }

  private rejectBatch(batch: PendingBatch, error: unknown): void {
    for (const waiter of batch.waiters.values()) {
      waiter.reject(error);
    }
  }
}
