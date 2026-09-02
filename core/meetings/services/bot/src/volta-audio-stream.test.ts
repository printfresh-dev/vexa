import { WebSocketServer } from 'ws';
import { openVoltaAudioStreamFromEnvironment } from './volta-audio-stream.js';

const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise<void>((resolve) => server.once('listening', resolve));
const address = server.address();
if (typeof address === 'string') throw new Error('Expected a TCP address');
const received: Buffer[] = [];
server.on('connection', (socket) => {
  socket.on('message', (data, binary) => {
    if (binary) {
      received.push(Buffer.from(data as Buffer));
      return;
    }
    const frame = JSON.parse(data.toString()) as { type: string };
    if (frame.type === 'start') socket.send(JSON.stringify({ type: 'ready' }));
    if (frame.type === 'end') socket.send(JSON.stringify({ type: 'ended' }));
  });
});

const stream = await openVoltaAudioStreamFromEnvironment({
  VOLTA_AUDIO_STREAM_URL: `ws://127.0.0.1:${address.port}`,
  VOLTA_AUDIO_STREAM_INTERNAL_SECRET: 'test-secret',
});
if (stream === undefined) throw new Error('Expected an audio stream');
const now = Date.now();
stream.push(0, new Float32Array(1_600).fill(0.25), now);
stream.push(1, new Float32Array(1_600).fill(0.5), now);
stream.push(0, new Float32Array(1_600).fill(0.1), now + 500);
await stream.finish();
await new Promise<void>((resolve) => server.close(() => resolve()));

const pcm = Buffer.concat(received);
if (pcm.byteLength !== 9_600 * 2) {
  throw new Error(`Expected 9,600 mixed samples, received ${pcm.byteLength / 2}`);
}
const mixedSample = pcm.readInt16LE(100 * 2) / 0x7fff;
if (Math.abs(mixedSample - 0.75) > 0.001) {
  throw new Error(`Expected overlapping speakers to mix to 0.75, received ${mixedSample}`);
}
console.log('PASS Volta audio stream mixes overlapping speakers and drains on end');
