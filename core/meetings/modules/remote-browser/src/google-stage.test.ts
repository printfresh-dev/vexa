/**
 * google-stage — sign-in stage classification, in isolation (no browser).
 *
 * Regression origin: Google serves the ordinary password step at
 * `/v3/signin/challenge/pwd`. A catch-all on `/challenge/` classified it as a
 * human challenge whenever the password field had not rendered at the polling
 * instant. `attemptGoogleLogin` then aborted with `auth_challenge_required`
 * while Chrome went on to sign in successfully, so every automated
 * re-authentication reported failure and no worker was ever marked
 * authenticated. Observed 5/5 reproducible in production on 2026-09-18.
 *
 * An answerable step whose input has not appeared yet is 'pending', so the
 * caller keeps polling. Only genuinely human challenges are 'challenge'.
 */
import type { Page } from 'playwright';
import { isAnswerableChallengePath, observeStage, type LoginStage } from './google-auth';

const fails: string[] = [];
const check = (condition: boolean, message: string) => {
  if (!condition) fails.push(message);
};

/** Minimal Page stub: a URL plus the set of selectors currently visible. */
function makePage(url: string, visible: readonly string[] = []): Page {
  return {
    url: () => url,
    locator: (selector: string) => ({
      first: () => ({
        isVisible: async () => visible.includes(selector),
      }),
    }),
  } as unknown as Page;
}

const PASSWORD_INPUT = 'input[name="Passwd"][type="password"]';
const EMAIL_INPUT = 'input[name="identifier"]';
const TOTP_INPUT = 'input[name="totpPin"]';
const CAPTCHA_IFRAME = 'iframe[src*="recaptcha"]';

const PWD_URL = 'https://accounts.google.com/v3/signin/challenge/pwd?TL=abc';
const TOTP_URL = 'https://accounts.google.com/v3/signin/challenge/totp';
const IDENTIFIER_URL = 'https://accounts.google.com/v3/signin/identifier';

async function stage(url: string, visible: readonly string[] = []): Promise<LoginStage> {
  return observeStage(makePage(url, visible));
}

async function main(): Promise<void> {
  // The exact regression: password page, input not yet rendered.
  check(await stage(PWD_URL) === 'pending',
    'unrendered /challenge/pwd must be pending, not a human challenge');
  check(await stage(PWD_URL, [PASSWORD_INPUT]) === 'password',
    'rendered /challenge/pwd must be the password stage');

  // Same race on the TOTP step, which this module also answers itself.
  check(await stage(TOTP_URL) === 'pending',
    'unrendered /challenge/totp must be pending, not a human challenge');
  check(await stage(TOTP_URL, [TOTP_INPUT]) === 'totp',
    'rendered /challenge/totp must be the totp stage');

  // Steps that genuinely need an operator must still report a challenge.
  for (const path of ['ipp', 'dp', 'sk', 'selection', 'kpp', 'recovery']) {
    const url = `https://accounts.google.com/v3/signin/challenge/${path}`;
    check(await stage(url) === 'challenge', `/challenge/${path} must require an operator`);
  }

  // A CAPTCHA outranks everything, including on an answerable path.
  check(await stage(PWD_URL, [CAPTCHA_IFRAME, PASSWORD_INPUT]) === 'challenge',
    'a visible CAPTCHA must report a challenge even on /challenge/pwd');

  // Ordinary stages and origin fencing are unchanged.
  check(await stage(IDENTIFIER_URL, [EMAIL_INPUT]) === 'email',
    'identifier page with an email input must be the email stage');
  check(await stage('https://myaccount.google.com/') === 'account',
    'the account origin must be the account stage');
  check(await stage('https://example.com/v3/signin/challenge/pwd', [PASSWORD_INPUT]) === 'untrusted',
    'an untrusted origin must never be treated as a sign-in stage');
  check(await stage(IDENTIFIER_URL) === 'pending',
    'a rendering identifier page must be pending');

  // The path rule itself, independent of any page.
  check(isAnswerableChallengePath('/v3/signin/challenge/pwd'), 'pwd path is answerable');
  check(isAnswerableChallengePath('/v3/signin/challenge/totp'), 'totp path is answerable');
  check(!isAnswerableChallengePath('/v3/signin/challenge/ipp'), 'sms path is not answerable');
  check(!isAnswerableChallengePath('/v3/signin/identifier'), 'identifier path is not a challenge');

  if (fails.length > 0) {
    for (const failure of fails) console.error('❌', failure);
    console.error(`❌ google-stage: ${fails.length} failure(s)`);
    process.exit(1);
  }
  console.log('✅ google-stage — sign-in stage classification');
}

main().catch((error) => {
  console.error('❌ FAIL —', error?.message || error);
  process.exit(1);
});
