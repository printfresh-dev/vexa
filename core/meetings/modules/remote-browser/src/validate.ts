/**
 * Validate a restored browser session by completing an auth-gated navigation,
 * checking the final HTTPS account host, and confirming a live auth cookie.
 * Google callers may also require the protected credential file's account email.
 */
import type { Page } from 'playwright';
import { AuthPlatform, LoginStatus } from './types';

const ACCOUNT_URLS: Record<AuthPlatform, string> = {
  zoom: 'https://zoom.us/profile',
  google: 'https://myaccount.google.com/',
  teams: 'https://teams.microsoft.com/',
};

const SIGNIN_URL_MARKERS: Record<AuthPlatform, string[]> = {
  zoom: ['/signin', '/login'],
  google: [
    'accounts.google.com/signin',
    'accounts.google.com/servicelogin',
    '/v3/signin/confirmidentifier',
  ],
  teams: ['login.microsoftonline.com', 'login.live.com', '/_#/login'],
};

export const AUTH_COOKIES: Record<AuthPlatform, string[]> = {
  zoom: ['_zm_ssid', 'zm_aid'],
  google: ['SID', '__Secure-1PSID', 'SAPISID'],
  teams: ['ESTSAUTHPERSISTENT', 'ESTSAUTH', 'ESTSAUTHLIGHT'],
};

export const AUTH_LOGIN_URLS: Record<AuthPlatform, string> = {
  zoom: 'https://zoom.us/signin',
  google: 'https://accounts.google.com/',
  teams: 'https://teams.microsoft.com/',
};

function isAuthenticatedHost(platform: AuthPlatform, value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return false;
    if (platform === 'google') return url.origin === 'https://myaccount.google.com';
    if (platform === 'zoom') return url.hostname === 'zoom.us' || url.hostname.endsWith('.zoom.us');
    return url.hostname === 'teams.microsoft.com';
  } catch {
    return false;
  }
}

async function googleIdentityMatches(
  page: Page,
  expectedEmail: string,
): Promise<'match' | 'mismatch' | 'unknown'> {
  let mismatchObserved = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const result = await page.evaluate((expected) => {
        const wanted = expected.trim().toLowerCase();
        const emailPattern = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
        const identities = new Set<string>();
        for (const node of Array.from(document.querySelectorAll('a[href]'))) {
          let href: URL;
          try { href = new URL(node.getAttribute('href') || ''); } catch { continue; }
          if (
            href.origin !== 'https://accounts.google.com'
            || href.pathname.toLowerCase() !== '/signoutoptions'
          ) continue;
          const label = (node.getAttribute('aria-label') || '').toLowerCase();
          for (const email of label.match(emailPattern) || []) identities.add(email);
        }
        return {
          matched: identities.size === 1 && identities.has(wanted),
          mismatch: identities.size === 1 && !identities.has(wanted),
        };
      }, expectedEmail);
      if (result.matched) return 'match';
      mismatchObserved ||= result.mismatch;
    } catch {
      return 'unknown';
    }
    if (attempt < 7) await page.waitForTimeout(250);
  }
  return mismatchObserved ? 'mismatch' : 'unknown';
}

export async function validateLoggedIn(
  page: Page,
  platform: AuthPlatform,
  expectedGoogleEmail?: string,
): Promise<LoginStatus> {
  const checkUrl = ACCOUNT_URLS[platform];
  try {
    const response = await page.goto(checkUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
    if (!response || !response.ok()) {
      return { loggedIn: false, reason: 'check_failed', detail: `platform=${platform} account navigation failed` };
    }
    await page.waitForTimeout(1000);
  } catch {
    return { loggedIn: false, reason: 'check_failed', detail: `platform=${platform} account navigation failed` };
  }

  let currentUrl = '';
  try { currentUrl = page.url(); } catch {
    return { loggedIn: false, reason: 'check_failed', detail: `platform=${platform} account location unavailable` };
  }
  const lowerUrl = currentUrl.toLowerCase();
  const signedOut = SIGNIN_URL_MARKERS[platform].some((marker) => lowerUrl.includes(marker.toLowerCase()));
  const authenticatedHost = isAuthenticatedHost(platform, currentUrl);
  if (signedOut || !authenticatedHost) {
    return {
      loggedIn: false,
      reason: 'signed_out',
      detail: `platform=${platform} authenticatedHost=false authCookie=unchecked`,
    };
  }

  let cookies: Array<{ name: string; value: string }>;
  try {
    cookies = await page.context().cookies(checkUrl);
  } catch {
    return { loggedIn: false, reason: 'check_failed', detail: `platform=${platform} cookie check failed` };
  }
  const hasAuthCookie = AUTH_COOKIES[platform].some(
    (name) => cookies.some((cookie) => cookie.name === name && !!cookie.value),
  );
  if (!hasAuthCookie) {
    return {
      loggedIn: false,
      reason: 'signed_out',
      detail: `platform=${platform} authenticatedHost=true authCookie=false`,
    };
  }

  if (platform === 'google' && expectedGoogleEmail) {
    const identity = await googleIdentityMatches(page, expectedGoogleEmail);
    if (identity !== 'match') {
      return {
        loggedIn: false,
        reason: identity === 'mismatch' ? 'identity_mismatch' : 'identity_unknown',
        detail: `platform=google authenticatedHost=true authCookie=true identity=${identity}`,
      };
    }
  }

  return {
    loggedIn: true,
    reason: 'authenticated',
    detail: `platform=${platform} authenticatedHost=true authCookie=true identity=${platform === 'google' && expectedGoogleEmail ? 'match' : 'unchecked'}`,
  };
}
