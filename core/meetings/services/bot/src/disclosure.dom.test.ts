import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchPersistentBrowser, type Page } from '@vexa/remote-browser';
import { discloseInMeeting, type VoltaDisclosureConfig } from './disclosure.js';

// The Zoom web client in a meeting, as the bot finds it: a tile for one other person, the footer
// chat button and, once the panel is open, the TipTap composer. Structure and class names are the
// live DOM recorded in the pre-0.12 bot (zoom/web/selectors.ts). disclosure.test.ts drives a fake
// page that accepts any selector, which is how selectors that match nothing in Zoom shipped.
// `enterSends` is whether Enter posts the message.
function zoomMeeting(enterSends: boolean): string {
  return `
    <div class="meeting-app">
      <div class="video-avatar__avatar-footer"><span>Alice Example</span></div>
      <div class="video-avatar__avatar-footer"><span>Volta Notetaker</span></div>
      <div id="panel" style="display:none">
        <div id="chat-list-content" aria-label="Chat Message List"></div>
        <div class="chat-rtf-box__editor-outer"><div class="chat-rtf-box__editor-wrapper"><div class="_rtfEditor_x1">
          <div class="tiptap ProseMirror" contenteditable="true"><p><br></p></div>
        </div></div></div>
      </div>
      <footer><button id="chat" aria-label="open the chat panel">Chat</button></footer>
    </div>
    <script>{
      const panel = document.getElementById('panel');
      const editor = document.querySelector('.chat-rtf-box__editor-outer .tiptap');
      document.getElementById('chat').addEventListener('click', (event) => {
        const open = panel.style.display === 'none';
        panel.style.display = open ? 'block' : 'none';
        event.currentTarget.setAttribute('aria-label', open ? 'close the chat panel' : 'open the chat panel');
      });
      editor.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || event.shiftKey) return;
        event.preventDefault();
        const text = editor.textContent.trim();
        if (!${enterSends} || text === '') return;
        const message = document.createElement('div');
        message.className = 'new-chat-message__container';
        message.innerHTML = '<div class="new-chat-message__text-box">'
          + '<div class="chat-rtf-box__display tiptap ProseMirror" contenteditable="false"><p></p></div></div>';
        message.querySelector('p').textContent = text;
        document.getElementById('chat-list-content').append(message);
        editor.innerHTML = '<p><br></p>';
      });
    }</script>`;
}

// tsx (esbuild) wraps named functions in `__name(...)`, a helper the page does not have, so the
// functions disclosure.ts evaluates in the page would throw there. The compiled bot has no such call.
async function load(page: Page, html: string): Promise<void> {
  await page.setContent(html);
  await page.evaluate('globalThis.__name = (value) => value');
}

async function main(): Promise<void> {
  const callbacks: Array<{ connection_id: string; status: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      callbacks.push(JSON.parse(body));
      response.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config: VoltaDisclosureConfig = {
    text: 'Volta uses Meta Muse to transcribe this meeting for authorized participants.',
    callbackUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/disclosure`,
    internalSecret: 'test-secret',
    botName: 'Volta Notetaker',
    participantDeadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const dataDir = await mkdtemp(join(tmpdir(), 'zoom-disclosure-dom-'));
  const { context, page } = await launchPersistentBrowser({ dataDir, args: ['--no-sandbox'], headless: true });
  try {
    await load(page, zoomMeeting(true));
    const outcome = await discloseInMeeting(page, 'connection-zoom-dom', config, 'zoom');
    assert.equal(outcome.status, 'disclosed', 'the notice is posted through Zoom\'s TipTap composer');
    assert.deepEqual(
      outcome.status === 'disclosed' ? [...outcome.participantKeys] : [],
      ['alice example'],
      'the other participant is recorded, the bot is not',
    );
    assert.deepEqual(
      await page.locator('.new-chat-message__container').allTextContents(),
      [config.text],
      'the chat shows the notice once',
    );
    assert.equal(await page.locator('#chat').getAttribute('aria-label'), 'close the chat panel',
      'the panel was opened and left open');
    assert.deepEqual(
      callbacks.map((callback) => [callback.connection_id, callback.status]),
      [['connection-zoom-dom', 'disclosure_verified']],
      'the verified notice is reported once',
    );

    // Typed but not posted: the composer's wrappers hold exactly the notice text, so they must not
    // be read as a rendered message.
    await load(page, zoomMeeting(false));
    await assert.rejects(
      discloseInMeeting(page, 'connection-zoom-unsent', config, 'zoom'),
      /sent text could not be verified in Zoom chat/,
      'text left in the composer is not a disclosure',
    );
    assert.equal(callbacks.length, 1, 'an unsent notice is not reported');
    console.log('Zoom disclosure DOM regression passed: the notice is posted through the TipTap composer and verified.');
  } finally {
    await context.close();
    await rm(dataDir, { recursive: true, force: true });
    server.close();
  }
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
