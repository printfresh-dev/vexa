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

export interface VoltaDisclosureConfig {
  text: string;
  callbackUrl: string;
  internalSecret: string;
}

async function firstVisible(page: Page, selectors: readonly string[]) {
  const deadline = Date.now() + STEP_TIMEOUT_MS;
  do {
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

export async function discloseInGoogleMeet(
  page: Page,
  connectionId: string,
  config: VoltaDisclosureConfig,
): Promise<void> {
  const button = await firstVisible(page, CHAT_BUTTON_SELECTORS);
  if (!button) throw new Error('disclosure_failed: Google Meet chat button was not found');
  await button.click({ timeout: STEP_TIMEOUT_MS });

  const input = await firstVisible(page, CHAT_INPUT_SELECTORS);
  if (!input) throw new Error('disclosure_failed: Google Meet chat input was not found');
  await input.fill(config.text, { timeout: STEP_TIMEOUT_MS });
  const renderedAt = new Date().toISOString();
  await input.press('Enter', { timeout: STEP_TIMEOUT_MS });
  if (!await verifyRenderedText(page, config.text)) {
    throw new Error('disclosure_failed: sent text could not be verified in Google Meet chat');
  }
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
