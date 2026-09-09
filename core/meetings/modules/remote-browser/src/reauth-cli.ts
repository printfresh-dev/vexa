import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import type { BrowserContext, Page } from 'playwright';
import { getAuthenticatedBrowserArgs } from './args';
import { launchPersistentBrowser } from './browser';
import {
  makeEphemeralProfileDir,
  removeProfileDir,
  syncBrowserDataFromS3,
  syncBrowserDataToS3,
  type S3Config,
} from './session-store';
import {
  attemptGoogleLogin,
  type AuthReasonCode,
  type GoogleCredentials,
  type GoogleLoginResult,
} from './google-auth';
import { validateLoggedIn } from './validate';
import type { LoginStatus } from './types';

export type ReauthResult =
  | { state: 'authenticated'; reasonCode: null }
  | { state: 'action_required'; reasonCode: AuthReasonCode };

export interface ReauthOutcome {
  result: ReauthResult;
  exitCode: 0 | 1 | 2;
}

interface ReauthBrowser {
  context: Pick<BrowserContext, 'close'>;
  page: Page;
}

export interface ReauthDependencies {
  makeProfileDir(): string;
  restore(config: S3Config, profileDir: string): void;
  launch(profileDir: string): Promise<ReauthBrowser>;
  validate(page: Page, expectedEmail: string): Promise<LoginStatus>;
  login(page: Page, credentials: GoogleCredentials): Promise<GoogleLoginResult>;
  persist(config: S3Config, profileDir: string): number;
  removeProfileDir(profileDir: string): void;
}

const REAL_DEPENDENCIES: ReauthDependencies = {
  makeProfileDir: makeEphemeralProfileDir,
  restore: (config, profileDir) => syncBrowserDataFromS3(config, profileDir, true, 20000),
  launch: (profileDir) => launchPersistentBrowser({
    dataDir: profileDir,
    args: getAuthenticatedBrowserArgs(),
    timeoutMs: 20000,
  }),
  validate: (page, expectedEmail) => validateLoggedIn(page, 'google', expectedEmail),
  login: attemptGoogleLogin,
  persist: (config, profileDir) => syncBrowserDataToS3(config, profileDir, 20000),
  removeProfileDir,
};

const authenticated = (): ReauthOutcome => ({
  result: { state: 'authenticated', reasonCode: null },
  exitCode: 0,
});
const actionRequired = (reasonCode: AuthReasonCode, transient: boolean = false): ReauthOutcome => ({
  result: { state: 'action_required', reasonCode },
  exitCode: transient ? 1 : 2,
});

export function readGoogleCredentials(path: string): GoogleCredentials {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > 64 * 1024) {
      throw new Error('credential file is not a 0600 regular file');
    }
    raw = readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(raw) > 64 * 1024) throw new Error('credential file is too large');
  } finally {
    closeSync(descriptor);
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('credential file is not an object');
  }
  const candidate = parsed as {
    email?: unknown;
    password?: unknown;
    totpSecret?: unknown;
  };
  const keys = Object.keys(parsed);
  if (keys.some((key) => !['email', 'password', 'totpSecret'].includes(key))) {
    throw new Error('credential file contains unsupported fields');
  }
  if (
    typeof candidate.email !== 'string'
    || !/^[^\s@]+@[^\s@]+$/.test(candidate.email.trim())
    || typeof candidate.password !== 'string'
    || candidate.password.length === 0
    || (candidate.totpSecret !== undefined && (
      typeof candidate.totpSecret !== 'string'
      || candidate.totpSecret.trim().length === 0
      || !/^[A-Z2-7\s-]+=*$/i.test(candidate.totpSecret)
    ))
  ) {
    throw new Error('credential file is incomplete');
  }
  return {
    email: candidate.email.trim(),
    password: candidate.password,
    ...(typeof candidate.totpSecret === 'string' ? { totpSecret: candidate.totpSecret } : {}),
  };
}

function validationFailure(status: LoginStatus): ReauthOutcome {
  if (status.reason === 'identity_mismatch') return actionRequired('auth_invalid_credentials');
  if (status.reason === 'identity_unknown' || status.reason === 'check_failed') {
    return actionRequired('auth_check_failed', true);
  }
  return actionRequired('auth_session_missing');
}
async function closeBrowser(context: Pick<BrowserContext, 'close'>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      context.close().then(() => true, () => false),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runGoogleReauthentication(
  options: {
    credentialsFile: string | undefined;
    checkOnly: boolean;
    s3: S3Config;
  },
  dependencies: ReauthDependencies = REAL_DEPENDENCIES,
): Promise<ReauthOutcome> {
  if (!options.credentialsFile) return actionRequired('auth_credentials_missing');

  let credentials: GoogleCredentials;
  try { credentials = readGoogleCredentials(options.credentialsFile); }
  catch { return actionRequired('auth_credentials_missing'); }

  if (!(options.s3.userdataS3Path && options.s3.s3Endpoint && options.s3.s3Bucket)) {
    return actionRequired('auth_check_failed', true);
  }

  let profileDir: string | undefined;
  let browser: ReauthBrowser | undefined;
  try {
    profileDir = dependencies.makeProfileDir();
    dependencies.restore(options.s3, profileDir);
    browser = await dependencies.launch(profileDir);

    const restored = await dependencies.validate(browser.page, credentials.email);
    if (!restored.loggedIn) {
      if (options.checkOnly) return validationFailure(restored);
      if (restored.reason === 'check_failed') return actionRequired('auth_check_failed', true);

      const login = await dependencies.login(browser.page, credentials);
      if (!login.authenticated) {
        return actionRequired(login.reasonCode, login.reasonCode === 'auth_check_failed');
      }

      const confirmed = await dependencies.validate(browser.page, credentials.email);
      if (!confirmed.loggedIn) return validationFailure(confirmed);
    }

    const context = browser.context;
    browser = undefined;
    if (!await closeBrowser(context)) return actionRequired('auth_check_failed', true);

    return dependencies.persist(options.s3, profileDir) > 0
      ? authenticated()
      : actionRequired('auth_check_failed', true);
  } catch {
    return actionRequired('auth_check_failed', true);
  } finally {
    if (browser) await closeBrowser(browser.context);
    if (profileDir) dependencies.removeProfileDir(profileDir);
  }
}

function envValue(env: NodeJS.ProcessEnv, primary: string, alias: string): string | undefined {
  return env[primary]?.trim() || env[alias]?.trim() || undefined;
}

export function s3ConfigFromEnvironment(env: NodeJS.ProcessEnv = process.env): S3Config {
  return {
    userdataS3Path: envValue(env, 'BOT_USERDATA_S3_PATH', 'VOLTA_VEXA_USERDATA_S3_PATH'),
    s3Endpoint: envValue(env, 'BOT_S3_ENDPOINT', 'VOLTA_VEXA_S3_ENDPOINT'),
    s3Bucket: envValue(env, 'BOT_S3_BUCKET', 'VOLTA_VEXA_S3_BUCKET'),
    s3AccessKey: envValue(env, 'BOT_S3_ACCESS_KEY', 'VOLTA_VEXA_S3_ACCESS_KEY'),
    s3SecretKey: envValue(env, 'BOT_S3_SECRET_KEY', 'VOLTA_VEXA_S3_SECRET_KEY'),
  };
}

async function main(): Promise<void> {
  console.log = (...values: unknown[]) => console.error(...values);
  const knownArgs: Record<string, true> = { '--check-only': true };
  const unknownArgument = process.argv.slice(2).some((argument) => !knownArgs[argument]);
  const outcome = unknownArgument
    ? actionRequired('auth_check_failed', true)
    : await runGoogleReauthentication({
        credentialsFile: process.env.BOT_GOOGLE_CREDENTIALS_FILE,
        checkOnly: process.argv.includes('--check-only'),
        s3: s3ConfigFromEnvironment(),
      });
  process.stdout.write(`${JSON.stringify(outcome.result)}\n`);
  process.exitCode = outcome.exitCode;
}

if (require.main === module) {
  void main().catch(() => {
    process.stdout.write(`${JSON.stringify({ state: 'action_required', reasonCode: 'auth_check_failed' })}\n`);
    process.exitCode = 1;
  });
}
