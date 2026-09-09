import WebSocket from 'ws';

const SAMPLE_RATE = 16_000;
const MIX_DELAY_MS = 200;
const MAX_PCM_SAMPLES = 24_000;
const MAX_TIMESTAMP_SKEW_MS = 10 * 60 * 1_000;

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

export interface VoltaAudioStream {
  push(speakerIndex: number, pcm: Float32Array, capturedAtMs: number): void;
  finish(): Promise<void>;
}

class LiveVoltaAudioStream implements VoltaAudioStream {
  private originMs: number | undefined;
  private samples = new Float32Array(SAMPLE_RATE);
  private emittedSamples = 0;
  private highestSample = 0;
  private highestTimestampMs = 0;
  private failure: Error | undefined;
  private finished = false;
  constructor(private readonly socket: WebSocket) {
    socket.on('error', (error) => { this.failure ??= error; });
    socket.on('close', () => {
      if (!this.finished) this.failure ??= new Error('Volta audio stream closed during capture');
    });
  }

  push(_speakerIndex: number, pcm: Float32Array, capturedAtMs: number): void {
    if (this.finished || pcm.length === 0) return;
    const now = Date.now();
    const timestamp = Number.isFinite(capturedAtMs) && Math.abs(capturedAtMs - now) <= MAX_TIMESTAMP_SKEW_MS
      ? capturedAtMs
      : now;
    this.originMs ??= timestamp;
    this.highestTimestampMs = Math.max(this.highestTimestampMs, timestamp);
    let sourceOffset = 0;
    let start = Math.round((timestamp - this.originMs) * SAMPLE_RATE / 1_000);
    if (start < this.emittedSamples) {
      sourceOffset = Math.min(pcm.length, this.emittedSamples - start);
      start += sourceOffset;
    }
    const end = start + pcm.length - sourceOffset;
    this.ensureCapacity(end - this.emittedSamples);
    for (let source = sourceOffset, target = start - this.emittedSamples; source < pcm.length; source++, target++) {
      this.samples[target] = Math.max(-1, Math.min(1, this.samples[target]! + pcm[source]!));
    }
    this.highestSample = Math.max(this.highestSample, end);
    const safeThrough = Math.max(
      this.emittedSamples,
      Math.round((this.highestTimestampMs - this.originMs - MIX_DELAY_MS) * SAMPLE_RATE / 1_000),
    );
    this.flushThrough(Math.min(safeThrough, this.highestSample));
  }

  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.flushThrough(this.highestSample);
    if (this.socket.readyState !== WebSocket.OPEN) {
      throw this.failure ?? new Error('Volta audio stream is unavailable');
    }
    const ended = deferred<void>();
    const timer = setTimeout(() => ended.resolve(), 5_000);
    timer.unref();
    this.socket.once('message', (data) => {
      try {
        if (JSON.parse(data.toString()).type === 'ended') ended.resolve();
      } catch { /* a final relay event is not part of this control handshake */ }
    });
    this.socket.once('close', () => ended.resolve());
    this.socket.send(JSON.stringify({ type: 'end' }));
    await ended.promise.finally(() => clearTimeout(timer));
    this.socket.close();
  }

  private ensureCapacity(required: number): void {
    if (required <= this.samples.length) return;
    let capacity = this.samples.length;
    while (capacity < required) capacity *= 2;
    const grown = new Float32Array(capacity);
    grown.set(this.samples);
    this.samples = grown;
  }

  private flushThrough(sampleOffset: number): void {
    let count = sampleOffset - this.emittedSamples;
    while (count > 0 && this.socket.readyState === WebSocket.OPEN) {
      const chunkSamples = Math.min(count, MAX_PCM_SAMPLES);
      const pcm = Buffer.allocUnsafe(chunkSamples * 2);
      for (let index = 0; index < chunkSamples; index++) {
        pcm.writeInt16LE(Math.round(this.samples[index]! * 0x7fff), index * 2);
      }
      this.socket.send(pcm, { binary: true });
      this.samples.copyWithin(0, chunkSamples);
      this.samples.fill(0, this.samples.length - chunkSamples);
      this.emittedSamples += chunkSamples;
      count -= chunkSamples;
    }
  }
}

export async function openVoltaAudioStreamFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Promise<VoltaAudioStream | undefined> {
  const url = env.VOLTA_AUDIO_STREAM_URL;
  const secret = env.VOLTA_AUDIO_STREAM_INTERNAL_SECRET;
  if (url === undefined || secret === undefined) return undefined;
  const socket = new WebSocket(url);
  const ready = deferred<void>();
  const timer = setTimeout(() => ready.reject(new Error('Volta audio stream handshake timed out')), 10_000);
  timer.unref();
  socket.once('open', () => socket.send(JSON.stringify({ type: 'start', secret })));
  socket.on('message', (data) => {
    try {
      const frame = JSON.parse(data.toString()) as { type?: string; message?: string };
      if (frame.type === 'ready') ready.resolve();
      if (frame.type === 'error') ready.reject(new Error(frame.message ?? 'Volta audio stream rejected'));
    } catch { /* binary is server-invalid and will close the socket */ }
  });
  socket.once('error', ready.reject);
  socket.once('close', () => ready.reject(new Error('Volta audio stream closed before ready')));
  await ready.promise.finally(() => clearTimeout(timer));
  return new LiveVoltaAudioStream(socket);
}
