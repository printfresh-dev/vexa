import { createHash } from 'node:crypto';
import type { Page } from '@vexa/remote-browser';

const CHAT_BUTTON_SELECTORS = [
  'button[aria-label*="chat" i]',
  '[role="button"][aria-label*="chat" i]',
  'button[data-tooltip*="chat" i]',
  '[role="button"][data-tooltip*="chat" i]',
  'button:has(i.google-material-icons:text-is("chat"))',
] as const;

const CHAT_INPUT_SELECTORS = [
  'textarea[aria-label*="message" i]',
  'textarea[placeholder*="message" i]',
  '[contenteditable="true"][aria-label*="message" i]',
  '[contenteditable="true"][data-placeholder*="message" i]',
] as const;

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

interface BrowserElement {
  isContentEditable: boolean;
  textContent: string | null;
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
    const elements = Array.from(browser.document.querySelectorAll('div, span, p'));
    return elements.some((element) => {
      if (element.isContentEditable) return false;
      const style = browser.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
      return element.textContent?.trim() === expected;
    });
  }, text, { timeout: STEP_TIMEOUT_MS }).then(() => true, () => false);
}

async function remoteParticipantKeys(page: Page, botName: string): Promise<Set<string>> {
  const normalizedBotName = botName.trim().toLocaleLowerCase();
  const keys = await page.locator('[data-participant-id]').evaluateAll((elements, expectedBotName) => {
    const normalize = (value: string | null): string => value?.trim().toLocaleLowerCase() ?? '';
    const effectsTile = /visual_effects|backgrounds and effects/i;
    const selfLabel = /(?:^|[\s,(])you(?:$|[\s,)])/i;
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
        || (expectedBotName.length > 0 && normalizedLabel.includes(expectedBotName))
        || selfLabel.test(label)
      ) {
        return [];
      }
      return [element.getAttribute('data-participant-id') || normalizedLabel];
    });
  }, normalizedBotName).catch(() => [] as string[]);
  return new Set(keys);
}

async function waitForRemoteParticipant(
  page: Page,
  config: VoltaDisclosureConfig,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const deadline = Date.parse(config.participantDeadlineAt);
  if (!Number.isFinite(deadline)) {
    throw new Error('disclosure_failed: participant deadline is invalid');
  }
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const participants = await remoteParticipantKeys(page, config.botName);
    if (participants.size > 0) return participants;
    await page.waitForTimeout(Math.min(PARTICIPANT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  return null;
}

async function postDisclosure(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
  signal?: AbortSignal,
): Promise<void> {
  const button = await firstVisible(page, CHAT_BUTTON_SELECTORS, signal);
  if (!button) throw new Error('disclosure_failed: Google Meet chat button was not found');
  await button.click({ timeout: STEP_TIMEOUT_MS });

  const input = await firstVisible(page, CHAT_INPUT_SELECTORS, signal);
  if (!input) throw new Error('disclosure_failed: Google Meet chat input was not found');
  await input.fill(config.text, { timeout: STEP_TIMEOUT_MS });
  const renderedAt = new Date().toISOString();
  await input.press('Enter', { timeout: STEP_TIMEOUT_MS });
  if (!await verifyRenderedText(page, config.text)) {
    throw new Error('disclosure_failed: sent text could not be verified in Google Meet chat');
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

export async function discloseInGoogleMeet(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
  signal?: AbortSignal,
): Promise<DisclosureOutcome> {
  const participantKeys = await waitForRemoteParticipant(page, config, signal);
  if (participantKeys === null) return { status: 'no_participant' };
  await postDisclosure(page, connectionId, config, signal);
  return { status: 'disclosed', participantKeys };
}

export type DisclosureMonitorScheduler = (inspect: () => Promise<void>) => () => void;

const intervalDisclosureMonitor: DisclosureMonitorScheduler = (inspect) => {
  const timer = setInterval(() => { void inspect(); }, PARTICIPANT_MONITOR_MS);
  timer.unref();
  return () => clearInterval(timer);
};

export function startGoogleMeetDisclosureMonitor(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
  initiallyDisclosedParticipants: ReadonlySet<string>,
  schedule: DisclosureMonitorScheduler = intervalDisclosureMonitor,
): () => void {
  const disclosedParticipants = new Set(initiallyDisclosedParticipants);
  let stopped = false;
  let posting = false;
  let retryAt = 0;
  const inspect = async (): Promise<void> => {
    if (stopped || posting || page.isClosed() || Date.now() < retryAt) return;
    const participants = await remoteParticipantKeys(page, config.botName);
    const hasUndisclosedParticipant = [...participants].some((key) => !disclosedParticipants.has(key));
    if (!hasUndisclosedParticipant) return;
    posting = true;
    try {
      await postDisclosure(page, connectionId, config);
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
