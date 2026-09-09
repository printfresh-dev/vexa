import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { openVoltaAudioStreamFromEnvironment } from './volta-audio-stream.js';

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (typeof address === 'string') throw new Error('Expected a TCP address');
const received: Buffer[] = [];
const audioEvents = new EventEmitter();
interface SpeakerObservation {
  type: 'speaker_observation';
  evidence: 'google_meet_active_speaker';
  source_channel: number;
  start_sample_offset: number;
  end_sample_offset: number;
  display_name: string | null;
}
const observations: SpeakerObservation[] = [];
server.on('connection', (socket) => {
  socket.on('message', (data, binary) => {
    if (binary) {
      received.push(Buffer.from(data as Buffer));
      audioEvents.emit('pcm');
      return;
    }
    const frame = JSON.parse(data.toString()) as { type: string };
    if (frame.type === 'speaker_observation') observations.push(frame as SpeakerObservation);
    if (frame.type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
    if (frame.type === 'end') socket.send(JSON.stringify({ type: 'ended' }));
  });
});

async function waitForAudio(predicate: () => boolean, message: string): Promise<void> {
  const signal = AbortSignal.timeout(5_000);
  try {
    while (!predicate()) await once(audioEvents, 'pcm', { signal });
  } catch (cause) {
    throw new Error(message, { cause });
  }
}

const environment = {
  VOLTA_AUDIO_STREAM_URL: `ws://127.0.0.1:${address.port}`,
  VOLTA_AUDIO_STREAM_INTERNAL_SECRET: 'test-secret',
};
const stream = await openVoltaAudioStreamFromEnvironment(environment);
if (stream === undefined) throw new Error('Expected an audio stream');
const now = Date.now();
stream.push(0, new Float32Array(1_600).fill(0.25), now, ' Alice Example ');
stream.push(1, new Float32Array(1_600).fill(0.5), now, 'Bob Example');
stream.push(0, new Float32Array(1_600).fill(0.1), now + 500);
await stream.finish();

const pcm = Buffer.concat(received);
let firstSpeechSample = 0;
while (firstSpeechSample * 2 < pcm.byteLength && pcm.readInt16LE(firstSpeechSample * 2) === 0) {
  firstSpeechSample += 1;
}
if (pcm.byteLength !== (firstSpeechSample + 9_600) * 2) {
  throw new Error(`Expected the complete 600ms mixed timeline, received ${pcm.byteLength / 2} samples`);
}
const mixedSample = pcm.readInt16LE((firstSpeechSample + 100) * 2) / 0x7fff;
if (Math.abs(mixedSample - 0.75) > 0.001) {
  throw new Error(`Expected overlapping speakers to mix to 0.75, received ${mixedSample}`);
}
if (
  observations.length !== 2
  || observations[0]!.source_channel !== 0
  || observations[0]!.display_name !== 'Alice Example'
  || observations[1]!.source_channel !== 1
  || observations[1]!.display_name !== 'Bob Example'
  || observations.some((frame) =>
    frame.start_sample_offset !== firstSpeechSample
    || frame.end_sample_offset !== firstSpeechSample + 1_600)
) {
  throw new Error(`Expected exact named source spans, received ${JSON.stringify(observations)}`);
}

received.length = 0;
const quietStream = await openVoltaAudioStreamFromEnvironment(environment);
if (quietStream === undefined) throw new Error('Expected a second audio stream');
quietStream.push(0, new Float32Array(1_600).fill(0.25), Date.now(), null);
await waitForAudio(
  () => received.filter((frame) => frame.every((byte) => byte === 0))
    .reduce((bytes, frame) => bytes + frame.byteLength, 0) >= 16_000,
  'Silence must stream continuously without waiting for another speech callback',
);
const beforeResume = received.length;
quietStream.push(0, new Float32Array(1_600).fill(0.5), Date.now());
await waitForAudio(
  () => received.slice(beforeResume).some((frame) => frame.some((byte) => byte !== 0)),
  'Resumed speech must arrive while capture is still active',
);
quietStream.push(1, new Float32Array(1_600).fill(0.5), Date.now() - 60_000, 'Too Late');
await quietStream.finish();
if (received.some((frame) => frame.byteLength > 16_000 * 2 / 4)) {
  throw new Error('A quiet gap must not be replayed as a large PCM burst');
}
if (observations.length !== 3 || observations[2]!.display_name !== null) {
  throw new Error(`Expected unresolved audio but no clipped identity span, received ${JSON.stringify(observations)}`);
}
await new Promise<void>((resolve) => server.close(() => resolve()));
console.log('PASS Volta audio stream mixes speakers and streams silence and resumed speech in real time');
