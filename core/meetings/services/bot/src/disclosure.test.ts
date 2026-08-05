import type { Page } from '@vexa/remote-browser';
import {
  discloseInGoogleMeet,
  startGoogleMeetDisclosureMonitor,
  type VoltaDisclosureConfig,
} from './disclosure.js';

let passed = 0;
let failed = 0;
function check(name: string, condition: boolean): void {
  if (condition) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${name}`);
    passed += 1;
  } else {
    console.log(`  \x1b[31mFAIL\x1b[0m  ${name}`);
    failed += 1;
  }
}

interface ParticipantElement {
  textContent: string;
  getAttribute(name: string): string | null;
  querySelector(): ParticipantElement | null;
}

function participant(id: string, label: string, selfName?: string): ParticipantElement {
  return {
    textContent: label,
    getAttribute(name) {
      if (name === 'data-participant-id') return id;
      if (name === 'aria-label') return label;
      if (name === 'data-self-name') return selfName ?? null;
      return null;
    },
    querySelector() { return null; },
  };
}

function fakePage(input: {
  participantSets: ParticipantElement[][];
  actions: string[];
  advanceTime?: (milliseconds: number) => void;
  chatInitiallyOpen?: boolean;
  submissionRenders?: boolean;
}): Page {
  let participantRead = 0;
  let chatOpen = input.chatInitiallyOpen ?? false;
  let composerText = '';
  let renderedText = false;
  const chatButton = {
    isVisible: async () => true,
    click: async () => {
      input.actions.push('chat-click');
      chatOpen = !chatOpen;
    },
  };
  const chatInput = {
    isVisible: async () => chatOpen,
    fill: async (text: string) => {
      composerText = text;
      input.actions.push(`fill:${text}`);
    },
    press: async (key: string) => {
      input.actions.push(`press:${key}`);
      if (key === 'Enter' && input.submissionRenders !== false) {
        composerText = '';
        renderedText = true;
      }
    },
  };
  return {
    locator(selector: string) {
      if (selector === '[data-participant-id]') {
        return {
          evaluateAll: async (callback: (elements: ParticipantElement[], name: string) => string[], name: string) => {
            const index = Math.min(participantRead, input.participantSets.length - 1);
            participantRead += 1;
            return callback(input.participantSets[index] ?? [], name);
          },
        };
      }
      return {
        first: () => selector.includes('textarea') || selector.includes('contenteditable')
          ? chatInput
          : chatButton,
      };
    },
    waitForFunction: async () => {
      if (composerText !== '' || !renderedText) throw new Error('message was not rendered');
    },
    waitForTimeout: async (milliseconds: number) => {
      input.actions.push('participant-wait');
      input.advanceTime?.(milliseconds);
    },
    isClosed: () => false,
  } as unknown as Page;
}

const originalFetch = globalThis.fetch;
globalThis.fetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as { status?: string };
  check('reports server-verified disclosure evidence', body.status === 'disclosure_verified');
  return new Response(null, { status: 204 });
};

console.log('\n=== disclosure: participant presence gates meeting chat ===');
const text = 'This meeting is being transcribed by Volta for authorized participants.';
const config: VoltaDisclosureConfig = {
  callbackUrl: 'https://control.example.test/disclosure',
  internalSecret: 'secret',
  text,
  botName: 'Volta Notetaker',
  participantDeadlineAt: new Date(Date.now() + 10_000).toISOString(),
};
const bot = participant('bot', 'Volta Notetaker (You)', 'Volta Notetaker');
const alice = participant('alice', 'Alice Example');
const actions: string[] = [];
const outcome = await discloseInGoogleMeet(
  fakePage({ participantSets: [[bot], [bot], [bot, alice]], actions }),
  'connection-1',
  config,
);
check('waits while only the bot is present', actions.filter((action) => action === 'participant-wait').length === 2);
check('does not open chat before a remote participant appears', actions.indexOf('chat-click') > actions.lastIndexOf('participant-wait'));
check('posts the exact configured disclosure', actions.includes(`fill:${text}`));
check('submits the message', actions.includes('press:Enter'));
check('returns disclosed participants', outcome.status === 'disclosed' && outcome.participantKeys.has('alice'));

const openChatActions: string[] = [];
await discloseInGoogleMeet(
  fakePage({
    participantSets: [[bot, alice]],
    actions: openChatActions,
    chatInitiallyOpen: true,
  }),
  'connection-open-chat',
  config,
);
check('does not toggle an already-open chat panel closed', !openChatActions.includes('chat-click'));

let unsentDisclosureRejected = false;
try {
  await discloseInGoogleMeet(
    fakePage({
      participantSets: [[bot, alice]],
      actions: [],
      submissionRenders: false,
    }),
    'connection-unsent',
    config,
  );
} catch (error) {
  unsentDisclosureRejected = String(error).includes('sent text could not be verified');
}
check('rejects a disclosure retained only in the composer', unsentDisclosureRejected);

const bob = participant('bob', 'Bob Example');
const monitorActions: string[] = [];
let inspectParticipants: (() => Promise<void>) | undefined;
let monitorCancelled = false;
const stopMonitor = startGoogleMeetDisclosureMonitor(
  fakePage({ participantSets: [[bot, alice, bob]], actions: monitorActions }),
  'connection-1',
  config,
  new Set(['alice']),
  (inspect) => {
    inspectParticipants = inspect;
    return () => { monitorCancelled = true; };
  },
);
await inspectParticipants!();
await inspectParticipants!();
stopMonitor();
check(
  'reannounces exactly once when a later participant joins',
  monitorActions.filter((action) => action === `fill:${text}`).length === 1,
);
check('stops the participant monitor', monitorCancelled);

const originalDateNow = Date.now;
let fakeNow = 1_000;
Date.now = () => fakeNow;
const emptyOutcome = await discloseInGoogleMeet(
  fakePage({
    participantSets: [[bot]],
    actions: [],
    advanceTime: (milliseconds) => { fakeNow += milliseconds; },
  }),
  'connection-2',
  { ...config, participantDeadlineAt: new Date(fakeNow + 500).toISOString() },
);
Date.now = originalDateNow;
check('returns no_participant when the meeting stays empty', emptyOutcome.status === 'no_participant');
globalThis.fetch = originalFetch;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
