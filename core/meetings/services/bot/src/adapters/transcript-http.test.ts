import type { TranscriptSegment } from '../contracts.js';
import { createHttpTranscriptSink } from './transcript-http.js';

let failed = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` - ${detail}`}`);
  if (!condition) failed += 1;
};

async function main(): Promise<void> {
  const segment: TranscriptSegment = {
    segment_id: 'segment-1',
    start: 1,
    end: 2,
    text: 'Durably delivered.',
    completed: true,
    speaker: 'Evan Luther',
  };
  const requests: Array<{ url: string; body: string; headers: Record<string, string> }> = [];
  let attempt = 0;
  const sink = createHttpTranscriptSink({
    callbackUrl: 'http://bridge.test/v1/vexa/transcript',
    internalSecret: 'secret',
    meetingId: 'run-1',
    nativeMeetingId: 'abc-defg-hij',
    retries: 2,
    backoffMs: 0,
    sleep: async () => undefined,
    fetchImpl: async (url, request) => {
      requests.push({ url, body: request.body, headers: request.headers });
      attempt += 1;
      return { ok: attempt === 2, status: attempt === 2 ? 204 : 503 };
    },
  });

  await sink.publish(segment);
  const first = JSON.parse(requests[0]!.body) as Record<string, unknown>;
  const second = JSON.parse(requests[1]!.body) as Record<string, unknown>;
  check('retries the durable callback', requests.length === 2, String(requests.length));
  check('keeps a stable delivery identity across retries', first.delivery_id === second.delivery_id);
  check('sends the internal secret', requests[0]!.headers['x-internal-secret'] === 'secret');
  check('sends the Vexa transcript envelope',
    first.type === 'transcription'
      && first.meeting_id === 'run-1'
      && Array.isArray(first.segments)
      && first.segments.length === 1);

  if (failed > 0) process.exit(1);
  console.log('\nPASS transcript-http: callback acceptance is load-bearing and retry-stable.');
}

void main();
