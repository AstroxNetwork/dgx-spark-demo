class PcmStreamPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.current = null;
    this.offset = 0;
    this.streamEnded = false;
    this.playbackId = 0;
    this.drainNotified = false;

    this.port.onmessage = (event) => {
      const data = event.data ?? {};
      if (data.type === 'clear') {
        this.queue = [];
        this.current = null;
        this.offset = 0;
        this.streamEnded = false;
        this.playbackId = data.playbackId ?? 0;
        this.drainNotified = false;
        return;
      }

      if (data.type === 'push') {
        if (!(data.samples instanceof Float32Array)) {
          return;
        }
        this.playbackId = data.playbackId ?? this.playbackId;
        this.queue.push(data.samples);
        this.drainNotified = false;
        return;
      }

      if (data.type === 'end') {
        this.playbackId = data.playbackId ?? this.playbackId;
        this.streamEnded = true;
      }
    };
  }

  process(_inputs, outputs) {
    const output = outputs[0]?.[0];
    if (!output) {
      return true;
    }

    output.fill(0);
    let written = 0;

    while (written < output.length) {
      if (!this.current || this.offset >= this.current.length) {
        this.current = this.queue.shift() ?? null;
        this.offset = 0;
        if (!this.current) {
          break;
        }
      }

      const remaining = this.current.length - this.offset;
      const copyLength = Math.min(output.length - written, remaining);
      output.set(this.current.subarray(this.offset, this.offset + copyLength), written);
      written += copyLength;
      this.offset += copyLength;
    }

    if (
      this.streamEnded &&
      !this.current &&
      this.queue.length === 0 &&
      !this.drainNotified
    ) {
      this.drainNotified = true;
      this.port.postMessage({ type: 'drained', playbackId: this.playbackId });
    }

    return true;
  }
}

registerProcessor('pcm-stream-player', PcmStreamPlayerProcessor);
