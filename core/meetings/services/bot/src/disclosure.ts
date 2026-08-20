import { createHash } from 'node:crypto';
import type { Page } from '@vexa/remote-browser';

const GOOGLE_CHAT_BUTTON_SELECTORS = [
  'button[aria-label*="chat" i]',
  '[role="button"][aria-label*="chat" i]',
  'button[data-tooltip*="chat" i]',
  '[role="button"][data-tooltip*="chat" i]',
  'button:has(i.google-material-icons:text-is("chat"))',
] as const;

const ZOOM_CHAT_BUTTON_SELECTORS = [
  'button[aria-label*="chat" i]',
  '[role="button"][aria-label*="chat" i]',
  'button[data-title*="chat" i]',
  '[role="button"][data-title*="chat" i]',
] as const;

const GOOGLE_CHAT_INPUT_SELECTORS = [
  'textarea[aria-label*="message" i]',
  'textarea[placeholder*="message" i]',
  '[contenteditable="true"][aria-label*="message" i]',
  '[contenteditable="true"][data-placeholder*="message" i]',
] as const;

const ZOOM_CHAT_INPUT_SELECTORS = [
  'textarea[placeholder*="message" i]',
  'textarea[aria-label*="message" i]',
  '.chat-box__chat-textarea',
  '[contenteditable="true"][aria-label*="message" i]',
] as const;

const ZOOM_PARTICIPANT_SELECTORS = [
  '.participants-item__display-name',
  '.video-avatar__avatar-footer',
  '.video-avatar__avatar-name',
  '[class*="participant"] [class*="display-name"]',
] as const;

export type DisclosurePlatform = 'google_meet' | 'zoom';

const STEP_TIMEOUT_MS = 10_000;
const PARTICIPANT_POLL_MS = 250;
const PARTICIPANT_MONITOR_MS = 1_000;
const DISCLOSURE_RETRY_MS = 10_000;

export interface VoltaDisclosureConfig {
  text: string;
  callbackUrl: string;
  internalSecret: string;
  botName: string;
  participantDeadlineAt: string;
}

export type DisclosureOutcome =
  | { status: 'disclosed'; participantKeys: ReadonlySet<string> }
  | { status: 'no_participant' };

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('disclosure_aborted');
}

async function firstVisible(
  page: Page,
  selectors: readonly string[],
  signal?: AbortSignal,
) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  do {
    throwIfAborted(signal);
    for (const selector of selectors) {
      const candidate = page.locator(selector).first();
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    if (Date.now() < deadline) await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  return null;
}

async function firstVisibleNow(
  page: Page,
  selectors: readonly string[],
) {
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  return null;
}

interface BrowserElement {
  isContentEditable: boolean;
  textContent: string | null;
  value?: string;
  querySelector(selector: string): BrowserElement | null;
}

interface BrowserParticipantElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelector(selector: string): BrowserParticipantElement | null;
}

interface BrowserGlobal {
  document: {
    querySelectorAll(selector: string): ArrayLike<BrowserElement>;
  };
  getComputedStyle(element: BrowserElement): { display: string; visibility: string };
}

async function verifyRenderedText(page: Page, text: string): Promise<boolean> {
  return page.waitForFunction((expected) => {
    const browser = globalThis as unknown as BrowserGlobal;
    const composerSelector = [
      'textarea[aria-label*="message" i]',
      'textarea[placeholder*="message" i]',
      '[contenteditable="true"][aria-label*="message" i]',
      '[contenteditable="true"][data-placeholder*="message" i]',
    ].join(',');
    const composers = Array.from(browser.document.querySelectorAll(composerSelector));
    if (composers.some((element) => {
      const style = browser.getComputedStyle(element);
      return style.display !== 'none'
        && style.visibility !== 'hidden'
        && (element.value ?? element.textContent ?? '').trim() !== '';
    })) {
      return false;
    }
    const elements = Array.from(browser.document.querySelectorAll('div, span, p'));
    return elements.some((element) => {
      if (element.isContentEditable || element.querySelector(composerSelector) !== null) return false;
      const style = browser.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return element.textContent?.trim() === expected;
    });
  }, text, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);
}

async function remoteParticipantKeys(
  page: Page,
  botName: string,
  platform: DisclosurePlatform,
): Promise<Set<string>> {
  const normalizedBotName = botName.trim().toLocaleLowerCase();
  const selector = platform === 'zoom'
    ? ZOOM_PARTICIPANT_SELECTORS.join(',')
    : '[data-participant-id]';
  const keys = await page.locator(selector).evaluateAll((elements, input) => {
    const { expectedBotName, meetingPlatform } = input as {
      expectedBotName: string;
      meetingPlatform: DisclosurePlatform;
    };
    const normalize = (value: string | null): string => value?.trim().toLocaleLowerCase() ?? '';
    const effectsTile = /visual_effects|backgrounds and effects/i;
    const selfLabel = /(?:^|[\s,(])(?:you|me)(?:$|[\s,)])/i;
    const participants = Array.from(elements) as unknown as BrowserParticipantElement[];
    return participants.flatMap((element) => {
      const label = element.getAttribute('aria-label') || (element.textContent || '').trim();
      const normalizedLabel = normalize(label);
      const selfName = element.getAttribute('data-self-name')
        || element.querySelector('[data-self-name]')?.getAttribute('data-self-name')
        || '';
      if (
        normalizedLabel.length === 0
        || effectsTile.test(normalizedLabel)
        || normalize(selfName).length > 0
        || normalizedLabel === 'participants'
        || (expectedBotName.length > 0 && normalizedLabel.includes(expectedBotName))
        || selfLabel.test(label)
      ) {
        return [];
      }
      if (meetingPlatform === 'zoom') return [normalizedLabel];
      return [element.getAttribute('data-participant-id') || normalizedLabel];
    });
  }, { expectedBotName: normalizedBotName, meetingPlatform: platform }).catch(() => [] as string[]);
  return new Set(keys);
}

async function waitForRemoteParticipant(
  page: Page,
  config: VoltaDisclosureConfig,
  platform: DisclosurePlatform,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const deadline = Date.parse(config.participantDeadlineAt);
  if (!Number.isFinite(deadline)) {
    throw new Error('disclosure_failed: participant deadline is invalid');
  }
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const participants = await remoteParticipantKeys(page, config.botName, platform);
    if (participants.size > 0) return participants;
    await page.waitForTimeout(Math.min(PARTICIPANT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return null;
}

async function postDisclosure(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
  platform: DisclosurePlatform,
  signal?: AbortSignal,
): Promise<void> {
  const buttonSelectors = platform === 'zoom'
    ? ZOOM_CHAT_BUTTON_SELECTORS
    : GOOGLE_CHAT_BUTTON_SELECTORS;
  const inputSelectors = platform === 'zoom'
    ? ZOOM_CHAT_INPUT_SELECTORS
    : GOOGLE_CHAT_INPUT_SELECTORS;
  const platformName = platform === 'zoom' ? 'Zoom' : 'Google Meet';
  let input = await firstVisibleNow(page, inputSelectors);
  if (input === null) {
    const button = await firstVisible(page, buttonSelectors, signal);
    if (!button) throw new Error(`disclosure_failed: ${platformName} chat button was not found`);
    await button.click({ timeout: STEP_TIMEOUT_MS });
    input = await firstVisible(page, inputSelectors, signal);
  }
  if (!input) throw new Error(`disclosure_failed: ${platformName} chat input was not found`);
  await input.fill(config.text, { timeout: STEP_TIMEOUT_MS });
  const renderedAt = new Date().toISOString();
  await input.press('Enter', { timeout: STEP_TIMEOUT_MS });
  if (!await verifyRenderedText(page, config.text)) {
    throw new Error(`disclosure_failed: sent text could not be verified in ${platformName} chat`);
  }
  throwIfAborted(signal);
  const verifiedAt = new Date().toISOString();
  const response = await fetch(config.callbackUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-internal-secret': config.internalSecret,
    },
    body: JSON.stringify({
      connection_id: connectionId,
      status: 'disclosure_verified',
      rendered_text_sha256: createHash('sha256').update(config.text, 'utf8').digest('hex'),
      rendered_at: renderedAt,
      verified_at: verifiedAt,
    }),
    signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`disclosure_failed: callback returned HTTP ${response.status}`);
  }
}

export async function discloseInMeeting(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
  platform: DisclosurePlatform,
  signal?: AbortSignal,
): Promise<DisclosureOutcome> {
  const participantKeys = await waitForRemoteParticipant(page, config, platform, signal);
  if (participantKeys === null) return { status: 'no_participant' };
  await postDisclosure(page, connectionId, config, platform, signal);
  return { status: 'disclosed', participantKeys };
}

export function discloseInGoogleMeet(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
  signal?: AbortSignal,
): Promise<DisclosureOutcome> {
  return discloseInMeeting(page, connectionId, config, 'google_meet', signal);
}

export type DisclosureMonitorScheduler = (inspect: () => Promise<void>) => () => void;

const intervalDisclosureMonitor: DisclosureMonitorScheduler = (inspect) => {
  const timer = setInterval(() => { void inspect(); }, PARTICIPANT_MONITOR_MS);
  timer.unref();
  return () => clearInterval(timer);
};

export function startDisclosureMonitor(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
  platform: DisclosurePlatform,
  initiallyDisclosedParticipants: ReadonlySet<string>,
  schedule: DisclosureMonitorScheduler = intervalDisclosureMonitor,
): () => void {
  const disclosedParticipants = new Set(initiallyDisclosedParticipants);
  let stopped = false;
  let posting = false;
  let retryAt = 0;
  const inspect = async (): Promise<void> => {
    if (stopped || posting || page.isClosed() || Date.now() < retryAt) return;
    const participants = await remoteParticipantKeys(page, config.botName, platform);
    const hasUndisclosedParticipant = [...participants].some((key) => !disclosedParticipants.has(key));
    if (!hasUndisclosedParticipant) return;
    posting = true;
    try {
      await postDisclosure(page, connectionId, config, platform);
      for (const key of participants) disclosedParticipants.add(key);
      retryAt = 0;
    } catch (error) {
      retryAt = Date.now() + DISCLOSURE_RETRY_MS;
      console.error(`[bot] participant disclosure retry scheduled: ${String(error)}`);
    } finally {
      posting = false;
    }
  };
  const cancelScheduledInspection = schedule(inspect);
  return () => {
    stopped = true;
    cancelScheduledInspection();
  };
}

export function startGoogleMeetDisclosureMonitor(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
  initiallyDisclosedParticipants: ReadonlySet<string>,
  schedule: DisclosureMonitorScheduler = intervalDisclosureMonitor,
): () => void {
  return startDisclosureMonitor(
    page,
    connectionId,
    config,
    'google_meet',
    initiallyDisclosedParticipants,
    schedule,
  );
}
