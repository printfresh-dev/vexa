import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Locator, Page } from 'playwright';
import { attemptGoogleLogin, generateTotp } from './google-auth';
import { readGoogleCredentials, runGoogleReauthentication, type ReauthDependencies } from './reauth-cli';
import { validateLoggedIn } from './validate';
import type { LoginStatus } from './types';

const failures: string[] = [];
const check = (condition: boolean, message: string): void => {
  if (!condition) failures.push(message);
};

function validationPage(
  finalUrl: string,
  cookies: Array<{ name: string; value: string }>,
  identity: 'match' | 'mismatch' | 'unknown' = 'unknown',
): Page {
  return {
    goto: async () => ({ ok: () => true }),
    waitForTimeout: async () => {},
    url: () => finalUrl,
    context: () => ({ cookies: async () => cookies }),
    evaluate: async () => ({
      matched: identity === 'match',
      mismatch: identity === 'mismatch',
    }),
  } as unknown as Page;
}

type LoginMode = 'challenge' | 'totp' | 'totp-rejected' | 'password-pending' | 'untrusted';
function loginPage(mode: LoginMode): { page: Page; fills: Array<{ field: string; origin: string }> } {
  let stage: 'email' | 'password' | 'totp' | 'invalid' | 'challenge' | 'account' | 'untrusted' = 'email';
  let url = 'about:blank';
  let authenticated = false;
  const fills: Array<{ field: string; origin: string }> = [];

  const kind = (
    selector: string,
  ): 'email' | 'password' | 'totp' | 'invalid' | 'captcha' | 'other' => {
    if (selector.includes('aria-invalid')) return 'invalid';
    if (selector.includes('identifier') || selector === 'input[type="email"]') return 'email';
    if (selector.includes('Passwd') || selector === 'input[type="password"]') return 'password';
    if (selector.includes('totpPin')) return 'totp';
    if (/captcha|recaptcha|name="ca"/.test(selector)) return 'captcha';
    return 'other';
  };
  const locatorFor = (selector: string): Locator => {
    const field = kind(selector);
    let locator: Locator;
    locator = {
      first: () => locatorFor(selector),
      isVisible: async () => (
        (field === stage)
        || (field === 'captcha' && stage === 'challenge')
      ),
      elementHandle: async () => locator,
      fill: async () => { fills.push({ field, origin: new URL(url).origin }); },
      press: async () => {
        if (field === 'email') {
          stage = 'password';
          url = 'https://accounts.google.com/v3/signin/challenge/pwd';
        } else if (field === 'password' && mode === 'challenge') {
          stage = 'challenge';
          url = 'https://accounts.google.com/v3/signin/challenge/dp';
        } else if (field === 'password' && (mode === 'totp' || mode === 'totp-rejected')) {
          stage = 'totp';
          url = 'https://accounts.google.com/v3/signin/challenge/totp';
        } else if (field === 'totp' && mode === 'totp-rejected') {
          stage = 'invalid';
        } else if (field === 'totp') {
          stage = 'account';
          authenticated = true;
          url = 'https://myaccount.google.com/';
        }
      },
      click: async () => {},
    } as unknown as Locator;
    return locator;
  };

  const page = {
    goto: async (target: string) => {
      if (target.startsWith('https://accounts.google.com/')) {
        if (mode === 'untrusted') {
          stage = 'untrusted';
          url = 'https://example.invalid/signin';
        } else {
          stage = 'email';
          url = target;
        }
      } else if (target.startsWith('https://myaccount.google.com/')) {
        if (authenticated) {
          stage = 'account';
          url = target;
        }
      }
      return { ok: () => true };
    },
    waitForTimeout: async () => {},
    url: () => url,
    locator: (selector: string) => locatorFor(selector),
    context: () => ({
      clearCookies: async () => {},
      cookies: async () => authenticated ? [{ name: 'SID', value: 'live' }] : [],
    }),
    evaluate: async () => ({ matched: authenticated, mismatch: false }),
  } as unknown as Page;
  return { page, fills };
}

const presentS3 = {
  userdataS3Path: 'userdata/test',
  s3Endpoint: 'https://s3.invalid',
  s3Bucket: 'test',
};

async function main(): Promise<void> {
  const stale = await validateLoggedIn(
    validationPage(
      'https://accounts.google.com/v3/signin/confirmidentifier?continue=secret',
      [{ name: 'SID', value: 'stale' }],
    ),
    'google',
  );
  check(!stale.loggedIn && stale.reason === 'signed_out',
    'modern confirmidentifier redirect with stale SID must not authenticate');
  check(!stale.detail.includes('continue=') && !stale.detail.includes('secret'),
    'validation detail must not expose URL queries');

  const incompleteNavigation = await validateLoggedIn({
    goto: async () => { throw new Error('navigation did not complete'); },
  } as unknown as Page, 'google');
  check(!incompleteNavigation.loggedIn && incompleteNavigation.reason === 'check_failed',
    'an incomplete account navigation must fail closed even if prior page state existed');

  const matched = await validateLoggedIn(
    validationPage('https://myaccount.google.com/', [{ name: 'SID', value: 'live' }], 'match'),
    'google',
    'worker@example.test',
  );
  check(matched.loggedIn, 'authenticated Google account must match protected expected email');
  const mismatched = await validateLoggedIn(
    validationPage('https://myaccount.google.com/', [{ name: 'SID', value: 'live' }], 'mismatch'),
    'google',
    'worker@example.test',
  );
  check(!mismatched.loggedIn && mismatched.reason === 'identity_mismatch',
    'different Google account identity must fail closed');
  const root = globalThis as unknown as { document?: unknown };
  const previousDocument = root.document;
  const rememberedPage = {
    goto: async () => ({ ok: () => true }),
    waitForTimeout: async () => {},
    url: () => 'https://myaccount.google.com/',
    context: () => ({ cookies: async () => [{ name: 'SID', value: 'live' }] }),
    evaluate: async (
      evaluateIdentity: (expected: string) => { matched: boolean; mismatch: boolean },
      expected: string,
    ) => {
      root.document = {
        querySelectorAll: () => [
          {
            getAttribute: (name: string) => name === 'href'
              ? 'https://accounts.google.com/SignOutOptions'
              : name === 'aria-label' ? 'Google Account: active-wrong@example.test' : null,
          },
          {
            getAttribute: (name: string) => name === 'data-email'
              ? 'worker@example.test'
              : null,
          },
        ],
      };
      try { return evaluateIdentity(expected); } finally { root.document = previousDocument; }
    },
  } as unknown as Page;
  const rememberedIdentity = await validateLoggedIn(
    rememberedPage,
    'google',
    'worker@example.test',
  );
  check(
    !rememberedIdentity.loggedIn && rememberedIdentity.reason === 'identity_mismatch',
    'a remembered expected account must not override the active account control identity',
  );


  const challenged = loginPage('challenge');
  const challengeResult = await attemptGoogleLogin(challenged.page, {
    email: 'worker@example.test',
    password: 'not-a-real-password',
  });
  check(!challengeResult.authenticated && challengeResult.reasonCode === 'auth_challenge_required',
    'unsupported Google push/security challenge must require action');
  check(challenged.fills.length === 2 && challenged.fills.every((fill) => fill.origin === 'https://accounts.google.com'),
    'email and password must only be filled on the exact trusted accounts origin');

  const untrusted = loginPage('untrusted');
  const untrustedResult = await attemptGoogleLogin(untrusted.page, {
    email: 'worker@example.test',
    password: 'not-a-real-password',
  });
  check(!untrustedResult.authenticated && untrusted.fills.length === 0,
    'an untrusted redirect must receive no credential values');

  const pendingPassword = await attemptGoogleLogin(loginPage('password-pending').page, {
    email: 'worker@example.test',
    password: 'not-a-real-password',
  });
  check(
    !pendingPassword.authenticated && pendingPassword.reasonCode === 'auth_check_failed',
    'a password-stage timeout must remain transient rather than latching invalid credentials',
  );

  check(
    generateTotp('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 59_000) === '287082',
    'RFC6238 SHA-1 vector at 59 seconds must produce the expected six-digit suffix',
  );
  const totp = loginPage('totp');
  const totpResult = await attemptGoogleLogin(totp.page, {
    email: 'worker@example.test',
    password: 'not-a-real-password',
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  });
  check(totpResult.authenticated && totp.fills.map((fill) => fill.field).join(',') === 'email,password,totp',
    'recognized TOTP challenge must complete before confirming the expected account');

  const rejectedTotp = await attemptGoogleLogin(loginPage('totp-rejected').page, {
    email: 'worker@example.test',
    password: 'not-a-real-password',
    totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  });
  check(
    !rejectedTotp.authenticated && rejectedTotp.reasonCode === 'auth_challenge_required',
    'a rejected one-time TOTP code must require action rather than latching credentials invalid',
  );

  const work = mkdtempSync(join(tmpdir(), 'vexa-reauth-'));
  const credentialFile = join(work, 'google.json');
  writeFileSync(credentialFile, JSON.stringify({
    email: 'worker@example.test',
    password: 'not-a-real-password',
  }));
  chmodSync(credentialFile, 0o644);
  let insecureCredentialsRejected = false;
  try { readGoogleCredentials(credentialFile); } catch { insecureCredentialsRejected = true; }
  check(insecureCredentialsRejected, 'credential file with group/world permissions must be rejected');
  chmodSync(credentialFile, 0o600);
  const credentialLink = join(work, 'google-link.json');
  symlinkSync(credentialFile, credentialLink);
  let symlinkCredentialsRejected = false;
  try { readGoogleCredentials(credentialLink); } catch { symlinkCredentialsRejected = true; }
  check(symlinkCredentialsRejected, 'credential file symlinks must be rejected');
  let persisted = 0;
  let removed = 0;
  let closed = 0;
  let loginAttempts = 0;
  let validationCount = 0;
  const page = {} as unknown as Page;
  const dependencies: ReauthDependencies = {
    makeProfileDir: () => '/tmp/mock-profile',
    restore: () => {},
    launch: async () => ({ context: { close: async () => { closed++; } }, page }),
    validate: async (): Promise<LoginStatus> => {
      validationCount++;
      return validationCount === 1
        ? { loggedIn: false, reason: 'signed_out', detail: 'signed out' }
        : { loggedIn: false, reason: 'identity_mismatch', detail: 'identity mismatch' };
    },
    login: async () => { loginAttempts++; return { authenticated: true, reasonCode: null }; },
    persist: () => { persisted++; return 1; },
    removeProfileDir: () => { removed++; },
  };
  const checkOnly = await runGoogleReauthentication({
    credentialsFile: credentialFile,
    checkOnly: true,
    s3: presentS3,
  }, dependencies);
  check(
    checkOnly.result.state === 'action_required'
      && checkOnly.result.reasonCode === 'auth_session_missing'
      && loginAttempts === 0
      && persisted === 0,
    '--check-only must validate without entering credentials or persisting a profile',
  );
  const failedConfirmation = await runGoogleReauthentication({
    credentialsFile: credentialFile,
    checkOnly: false,
    s3: presentS3,
  }, dependencies);
  check(failedConfirmation.result.state === 'action_required' && persisted === 0,
    'a login whose expected account cannot be confirmed must not overwrite durable state');
  check(closed === 2 && removed === 2, 'each authentication attempt must close and delete its ephemeral profile');
  rmSync(work, { recursive: true, force: true });

  if (failures.length) {
    console.error(`reauth.test FAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
  }
  console.log('reauth.test OK — redirect, origin, challenge, identity, TOTP, and persistence gates hold');
}

void main().catch(() => {
  console.error('reauth.test FAILED with unexpected error');
  process.exit(1);
});
