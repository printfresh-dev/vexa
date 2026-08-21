/** Volta transcript egress adapter. A successful response means the callback durably staged the segment. */
import { createHash } from 'node:crypto';
import type { TranscriptSegment } from '../contracts.js';
import type { TranscriptSink } from '../ports.js';

export type TranscriptFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number }>;

export interface HttpTranscriptSinkOptions {
  callbackUrl: string;
  internalSecret: string;
  meetingId: string | number;
  nativeMeetingId?: string;
  fetchImpl?: TranscriptFetch;
  retries?: number;
  backoffMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const realSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createHttpTranscriptSink(options: HttpTranscriptSinkOptions): TranscriptSink {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const retries = Math.max(1, options.retries ?? 5);
  const backoffMs = Math.max(0, options.backoffMs ?? 100);
  const sleep = options.sleep ?? realSleep;

  return {
    async publish(segment: TranscriptSegment): Promise<void> {
      const identity = JSON.stringify({
        meeting_id: options.meetingId,
        native_meeting_id: options.nativeMeetingId,
        segment,
      });
      const body = JSON.stringify({
        type: 'transcription',
        delivery_id: createHash('sha256').update(identity, 'utf8').digest('hex'),
        meeting_id: options.meetingId,
        native_meeting_id: options.nativeMeetingId,
        segments: [segment],
      });
      let lastStatus: number | undefined;
      let lastError: unknown;
      for (let attempt = 0; attempt < retries; attempt += 1) {
        if (attempt > 0) await sleep(Math.min(2_000, backoffMs * (2 ** (attempt - 1))));
        try {
          const response = await fetchImpl(options.callbackUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-internal-secret': options.internalSecret,
            },
            body,
          });
          if (response.ok) return;
          lastStatus = response.status;
        } catch (error) {
          lastError = error;
        }
      }
      throw new Error(lastStatus === undefined
        ? `Volta transcript callback failed: ${String(lastError)}`
        : `Volta transcript callback returned HTTP ${lastStatus}`);
    },
  };
}
