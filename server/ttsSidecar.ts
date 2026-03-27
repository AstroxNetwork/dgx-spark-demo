export interface TtsCoalescerRequest {
  sessionId: string;
  text: string;
  flush?: boolean;
  priority?: number;
  sequence?: number;
}

export interface TtsCoalescerResult {
  merged: boolean;
  audio: Blob | null;
  startSequence?: number;
  endSequence?: number;
}

interface PendingBatch {
  segments: Map<number, string>;
  waiters: PendingRequestWaiter[];
  timer: ReturnType<typeof setTimeout> | null;
  settled: boolean;
  priority: number;
  batchSequence: number;
  startSequence: number;
  endSequence: number;
}

interface PendingRequestWaiter {
  sequence: number;
  resolve: (result: TtsCoalescerResult) => void;
  reject: (error: unknown) => void;
}

interface TtsCoalescerOptions {
  bufferMs: number;
  maxBufferedChars: number;
  synthesize: (sessionId: string, text: string) => Promise<Blob>;
  synthesizeConcurrency?: number;
  logger?: (message: string) => void;
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
  private readonly logger?: (message: string) => void;
  private readonly pendingSynthesisJobs: PendingSynthesisJob[] = [];
  private activeSynthesis = 0;
  private nextBatchSequence = 0;
  private nextSyntheticSequence = 0;

  constructor(options: TtsCoalescerOptions) {
    this.bufferMs = options.bufferMs;
    this.maxBufferedChars = options.maxBufferedChars;
    this.synthesize = options.synthesize;
    this.synthesizeConcurrency = Math.max(1, options.synthesizeConcurrency ?? 1);
    this.logger = options.logger;
  }

  async enqueue(request: TtsCoalescerRequest): Promise<TtsCoalescerResult> {
    const hasText = request.text.trim().length > 0;
    const existing = this.sessions.get(request.sessionId);
    this.log(
      `enqueue session=${request.sessionId} hasText=${hasText} textLen=${request.text.length} flush=${request.flush ?? false} priority=${request.priority ?? 1} sequence=${request.sequence ?? 'auto'} hasExisting=${Boolean(existing)}`,
    );
    if (!existing) {
      if (!hasText) {
        this.log(`drop-empty session=${request.sessionId}`);
        return { merged: true, audio: null };
      }

      return await this.createBatch(request);
    }

    return await new Promise<TtsCoalescerResult>((resolve, reject) => {
      const sequence = this.resolveRequestSequence(request);
      existing.waiters.push({ sequence, resolve, reject });
      if (hasText) {
        this.appendSegment(existing, request, sequence);
      }
      existing.priority = Math.min(existing.priority, request.priority ?? 1);

      if (request.flush || this.composeBatchText(existing).length >= this.maxBufferedChars) {
        this.log(
          `flush-trigger session=${request.sessionId} reason=${request.flush ? 'explicit' : 'max-buffer'} textLen=${this.composeBatchText(existing).length} priority=${existing.priority} startSequence=${existing.startSequence} endSequence=${existing.endSequence}`,
        );
        void this.flushSession(request.sessionId, existing);
      }
    });
  }

  private async createBatch(request: TtsCoalescerRequest): Promise<TtsCoalescerResult> {
    return await new Promise<TtsCoalescerResult>((resolve, reject) => {
      const sequence = this.resolveRequestSequence(request);
      const batch: PendingBatch = {
        segments: new Map(),
        waiters: [{ sequence, resolve, reject }],
        timer: null,
        settled: false,
        priority: request.priority ?? 1,
        batchSequence: this.nextBatchSequence++,
        startSequence: Number.POSITIVE_INFINITY,
        endSequence: Number.NEGATIVE_INFINITY,
      };
      this.appendSegment(batch, request, sequence);

      this.sessions.set(request.sessionId, batch);
      this.log(
        `create-batch session=${request.sessionId} textLen=${this.composeBatchText(batch).length} priority=${batch.priority} flush=${request.flush ?? false} startSequence=${batch.startSequence} endSequence=${batch.endSequence}`,
      );

      if (request.flush || this.composeBatchText(batch).length >= this.maxBufferedChars) {
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
    const batchText = this.composeBatchText(batch);
    this.log(
      `flush-start session=${sessionId} textLen=${batchText.length} priority=${batch.priority} startSequence=${batch.startSequence} endSequence=${batch.endSequence} queued=${this.pendingSynthesisJobs.length} active=${this.activeSynthesis}`,
    );

    if (!batchText.trim()) {
      this.log(`flush-empty session=${sessionId}`);
      this.resolveWaiters(batch, null);
      return;
    }

    try {
      const audio = await this.scheduleSynthesis(sessionId, batch, batchText);
      this.log(`flush-complete session=${sessionId} textLen=${batchText.length} startSequence=${batch.startSequence} endSequence=${batch.endSequence}`);
      this.resolveWaiters(batch, audio);
    } catch (error) {
      this.log(
        `flush-error session=${sessionId} textLen=${batchText.length} startSequence=${batch.startSequence} endSequence=${batch.endSequence} error=${error instanceof Error ? error.message : String(error)}`,
      );
      for (const waiter of batch.waiters) {
        waiter.reject(error);
      }
    }
  }

  private async scheduleSynthesis(sessionId: string, batch: PendingBatch, text: string): Promise<Blob> {
    return await new Promise<Blob>((resolve, reject) => {
      this.pendingSynthesisJobs.push({
        sessionId,
        batch: {
          ...batch,
          segments: new Map(batch.segments),
        },
        resolve,
        reject,
      });
      this.pendingSynthesisJobs.sort((left, right) => (
        left.batch.priority - right.batch.priority
        || left.batch.batchSequence - right.batch.batchSequence
      ));
      this.log(
        `queue session=${sessionId} textLen=${text.length} priority=${batch.priority} startSequence=${batch.startSequence} endSequence=${batch.endSequence} pending=${this.pendingSynthesisJobs.length} active=${this.activeSynthesis}`,
      );
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
      const nextText = this.composeBatchText(nextJob.batch);
      this.log(
        `synthesize-start session=${nextJob.sessionId} textLen=${nextText.length} priority=${nextJob.batch.priority} startSequence=${nextJob.batch.startSequence} endSequence=${nextJob.batch.endSequence} pending=${this.pendingSynthesisJobs.length} active=${this.activeSynthesis}`,
      );
      void this.synthesize(nextJob.sessionId, nextText)
        .then((audio) => {
          this.log(
            `synthesize-complete session=${nextJob.sessionId} textLen=${nextText.length} startSequence=${nextJob.batch.startSequence} endSequence=${nextJob.batch.endSequence}`,
          );
          nextJob.resolve(audio);
        })
        .catch((error) => {
          this.log(
            `synthesize-error session=${nextJob.sessionId} textLen=${nextText.length} startSequence=${nextJob.batch.startSequence} endSequence=${nextJob.batch.endSequence} error=${error instanceof Error ? error.message : String(error)}`,
          );
          nextJob.reject(error);
        })
        .finally(() => {
          this.activeSynthesis -= 1;
          this.log(
            `synthesize-finally session=${nextJob.sessionId} pending=${this.pendingSynthesisJobs.length} active=${this.activeSynthesis}`,
          );
          this.drainSynthesisQueue();
        });
    }
  }

  private log(message: string): void {
    this.logger?.(`[tts-sidecar] ${message}`);
  }

  private appendSegment(batch: PendingBatch, request: TtsCoalescerRequest, segmentSequence: number): void {
    batch.segments.set(segmentSequence, request.text);
    batch.startSequence = Math.min(batch.startSequence, segmentSequence);
    batch.endSequence = Math.max(batch.endSequence, segmentSequence);
  }

  private resolveRequestSequence(request: TtsCoalescerRequest): number {
    return request.sequence ?? this.nextSyntheticSequence++;
  }

  private composeBatchText(batch: PendingBatch): string {
    return [...batch.segments.entries()]
      .sort((left, right) => left[0] - right[0])
      .map(([, text]) => text)
      .join('');
  }

  private resolveWaiters(batch: PendingBatch, audio: Blob | null): void {
    const ownerSequence = batch.waiters.reduce<number | null>((currentMin, waiter) => {
      if (!Number.isFinite(waiter.sequence)) {
        return currentMin;
      }

      if (currentMin === null) {
        return waiter.sequence;
      }

      return Math.min(currentMin, waiter.sequence);
    }, null);

    for (const waiter of batch.waiters) {
      const isOwner = audio !== null && ownerSequence !== null && waiter.sequence === ownerSequence;
      waiter.resolve({
        merged: !isOwner,
        audio: isOwner ? audio : null,
        startSequence: batch.startSequence,
        endSequence: batch.endSequence,
      });
    }
  }
}
