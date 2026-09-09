import { createHmac } from 'node:crypto';
import type { Locator, Page } from 'playwright';
import { validateLoggedIn } from './validate';

export interface GoogleCredentials {
  email: string;
  password: string;
  totpSecret?: string;
}

export type AuthReasonCode =
  | 'auth_credentials_missing'
  | 'auth_invalid_credentials'
  | 'auth_challenge_required'
  | 'auth_session_missing'
  | 'auth_check_failed';

export type GoogleLoginResult =
  | { authenticated: true; reasonCode: null }
  | { authenticated: false; reasonCode: AuthReasonCode };

const GOOGLE_ACCOUNTS_ORIGIN = 'https://accounts.google.com';
const GOOGLE_ACCOUNT_ORIGIN = 'https://myaccount.google.com';
const GOOGLE_IDENTIFIER_URL =
  'https://accounts.google.com/signin/v2/identifier?service=accountsettings&continue=https%3A%2F%2Fmyaccount.google.com%2F&flowName=GlifWebSignIn&flowEntry=ServiceLogin';
const POLL_MS = 250;
const POLLS_PER_STAGE = 32;

const EMAIL_INPUTS = ['input[name="identifier"][type="email"]', 'input[type="email"]'];
const PASSWORD_INPUTS = ['input[name="Passwd"][type="password"]', 'input[type="password"]'];
const TOTP_INPUTS = ['input[name="totpPin"]'];
const INVALID_INPUTS = [
  'input[name="identifier"][aria-invalid="true"]',
  'input[name="Passwd"][aria-invalid="true"]',
  'input[name="totpPin"][aria-invalid="true"]',
  'div[jsname="B34EJ"]',
];
const CAPTCHA_SELECTORS = [
  'iframe[src*="recaptcha"]',
  'iframe[title*="captcha" i]',
  '#captchaimg',
  'input[name="ca"]',
];
const OTHER_ACCOUNT_SELECTORS = [
  'text="Use another account"',
  '[role="link"]:has-text("Use another account")',
];

type LoginStage =
  | 'account'
  | 'email'
  | 'password'
  | 'totp'
  | 'invalid'
  | 'challenge'
  | 'untrusted'
  | 'pending';

export function isTrustedGoogleAccountsUrl(value: string): boolean {
  try { return new URL(value).origin === GOOGLE_ACCOUNTS_ORIGIN; }
  catch { return false; }
}

function currentOriginAndPath(page: Page): { origin: string; path: string } | null {
  try {
    const url = new URL(page.url());
    return { origin: url.origin, path: url.pathname.toLowerCase() };
  } catch {
    return null;
  }
}

async function firstVisible(page: Page, selectors: readonly string[]): Promise<Locator | null> {
  for (const selector of selectors) {
    try {
      const locator = page.locator(selector).first();
      if (await locator.isVisible()) return locator;
    } catch { /* try the next exact selector */ }
  }
  return null;
}

async function observeStage(page: Page): Promise<LoginStage> {
  const location = currentOriginAndPath(page);
  if (!location) return 'untrusted';
  if (location.origin === GOOGLE_ACCOUNT_ORIGIN) return 'account';
  if (location.origin !== GOOGLE_ACCOUNTS_ORIGIN) return 'untrusted';
  if (await firstVisible(page, CAPTCHA_SELECTORS)) return 'challenge';
  if (await firstVisible(page, INVALID_INPUTS)) return 'invalid';
  if (location.path.includes('/challenge/totp') && await firstVisible(page, TOTP_INPUTS)) return 'totp';
  if (await firstVisible(page, PASSWORD_INPUTS)) return 'password';
  if (await firstVisible(page, EMAIL_INPUTS)) return 'email';
  if (location.path.includes('/challenge/')) return 'challenge';
  return 'pending';
}

async function waitForChangedStage(page: Page, previous: LoginStage): Promise<LoginStage> {
  for (let attempt = 0; attempt < POLLS_PER_STAGE; attempt++) {
    const stage = await observeStage(page);
    if (stage !== previous && stage !== 'pending') return stage;
    await page.waitForTimeout(POLL_MS);
  }
  return 'pending';
}

async function fillAndSubmit(page: Page, input: Locator, value: string): Promise<boolean> {
  if (!isTrustedGoogleAccountsUrl(page.url())) return false;
  try {
    const handle = await input.elementHandle();
    if (!handle || !isTrustedGoogleAccountsUrl(page.url())) return false;
    await handle.fill(value);
    if (!isTrustedGoogleAccountsUrl(page.url())) return false;
    await handle.press('Enter');
    return true;
  } catch {
    return false;
  }
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[\s-]/g, '');
  if (!/^[A-Z2-7]+=*$/.test(normalized) || normalized.replace(/=+$/, '').length === 0) {
    throw new Error('invalid TOTP secret');
  }
  const input = normalized.replace(/=+$/, '');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const character of input) {
    bits = (bits << 5) | alphabet.indexOf(character);
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >>> bitCount) & 0xff);
      bits &= (1 << bitCount) - 1;
    }
  }
  if (bytes.length === 0) throw new Error('invalid TOTP secret');
  return Buffer.from(bytes);
}

/** RFC 6238 TOTP (SHA-1, 30-second step, six digits), using only Node crypto. */
export function generateTotp(secret: string, nowMs: number = Date.now()): string {
  const counter = BigInt(Math.floor(nowMs / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac('sha1', decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  ) % 1_000_000;
  return String(code).padStart(6, '0');
}

async function confirmExpectedAccount(page: Page, expectedEmail: string): Promise<GoogleLoginResult> {
  const status = await validateLoggedIn(page, 'google', expectedEmail);
  if (status.loggedIn) return { authenticated: true, reasonCode: null };
  if (status.reason === 'identity_mismatch') {
    return { authenticated: false, reasonCode: 'auth_invalid_credentials' };
  }
  if (status.reason === 'identity_unknown' || status.reason === 'check_failed') {
    return { authenticated: false, reasonCode: 'auth_check_failed' };
  }
  return { authenticated: false, reasonCode: 'auth_check_failed' };
}

/** One bounded Google sign-in attempt. Credentials are entered only on the exact HTTPS accounts origin. */
export async function attemptGoogleLogin(
  page: Page,
  credentials: GoogleCredentials,
): Promise<GoogleLoginResult> {
  try {
    await page.context().clearCookies({ domain: /(^|\.)google\.com$/ });
  } catch {
    return { authenticated: false, reasonCode: 'auth_check_failed' };
  }

  try {
    const response = await page.goto(GOOGLE_IDENTIFIER_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 15_000,
    });
    if (!response || !response.ok()) {
      return { authenticated: false, reasonCode: 'auth_check_failed' };
    }
    if (!isTrustedGoogleAccountsUrl(page.url())) {
      return { authenticated: false, reasonCode: 'auth_challenge_required' };
    }
  } catch {
    return { authenticated: false, reasonCode: 'auth_check_failed' };
  }

  let emailInput: Locator | null = null;
  let clickedOtherAccount = false;
  for (let attempt = 0; attempt < POLLS_PER_STAGE; attempt++) {
    const stage = await observeStage(page);
    if (stage === 'challenge' || stage === 'password' || stage === 'totp') {
      return { authenticated: false, reasonCode: 'auth_challenge_required' };
    }
    if (stage === 'invalid') return { authenticated: false, reasonCode: 'auth_invalid_credentials' };
    if (stage === 'untrusted') return { authenticated: false, reasonCode: 'auth_challenge_required' };
    if (stage === 'account') return confirmExpectedAccount(page, credentials.email);
    if (stage === 'email') {
      emailInput = await firstVisible(page, EMAIL_INPUTS);
      break;
    }
    if (!clickedOtherAccount) {
      const otherAccount = await firstVisible(page, OTHER_ACCOUNT_SELECTORS);
      if (otherAccount) {
        const handle = await otherAccount.elementHandle().catch(() => null);
        if (!handle || !isTrustedGoogleAccountsUrl(page.url())) {
          return { authenticated: false, reasonCode: 'auth_challenge_required' };
        }
        try { await handle.click(); } catch {
          return { authenticated: false, reasonCode: 'auth_check_failed' };
        }
        clickedOtherAccount = true;
      }
    }
    await page.waitForTimeout(POLL_MS);
  }
  if (!emailInput || !await fillAndSubmit(page, emailInput, credentials.email)) {
    return { authenticated: false, reasonCode: 'auth_check_failed' };
  }

  const afterEmail = await waitForChangedStage(page, 'email');
  if (afterEmail === 'invalid') return { authenticated: false, reasonCode: 'auth_invalid_credentials' };
  if (afterEmail === 'account') return confirmExpectedAccount(page, credentials.email);
  if (afterEmail !== 'password') {
    return { authenticated: false, reasonCode: afterEmail === 'pending' ? 'auth_check_failed' : 'auth_challenge_required' };
  }
  const passwordInput = await firstVisible(page, PASSWORD_INPUTS);
  if (!passwordInput || !await fillAndSubmit(page, passwordInput, credentials.password)) {
    return { authenticated: false, reasonCode: 'auth_check_failed' };
  }

  const afterPassword = await waitForChangedStage(page, 'password');
  if (afterPassword === 'invalid') return { authenticated: false, reasonCode: 'auth_invalid_credentials' };
  if (afterPassword === 'challenge' || afterPassword === 'untrusted') {
    return { authenticated: false, reasonCode: 'auth_challenge_required' };
  }
  if (afterPassword === 'totp') {
    if (!credentials.totpSecret) {
      return { authenticated: false, reasonCode: 'auth_challenge_required' };
    }
    let code: string;
    try { code = generateTotp(credentials.totpSecret); }
    catch { return { authenticated: false, reasonCode: 'auth_credentials_missing' }; }
    const totpInput = await firstVisible(page, TOTP_INPUTS);
    if (!totpInput || !await fillAndSubmit(page, totpInput, code)) {
      return { authenticated: false, reasonCode: 'auth_check_failed' };
    }
    const afterTotp = await waitForChangedStage(page, 'totp');
    if (afterTotp === 'invalid') return { authenticated: false, reasonCode: 'auth_challenge_required' };
    if (afterTotp === 'challenge' || afterTotp === 'untrusted') {
      return { authenticated: false, reasonCode: 'auth_challenge_required' };
    }
  }

  return confirmExpectedAccount(page, credentials.email);
}
