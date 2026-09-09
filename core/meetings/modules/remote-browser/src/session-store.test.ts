/**
 * session-store.test — the S3 sync surface, offline (no real S3, no network).
 *
 * A fake `aws` executable on PATH records every invocation to a log file, so the REAL
 * syncBrowserDataToS3 / syncBrowserDataFromS3 run end-to-end and the assertions read
 * what actually crossed the process boundary. Covers the two contract-level behaviours:
 *
 *  1. CONFIRMED PROFILE SOURCE — syncBrowserDataToS3(config, dataDir) uploads
 *     only the auth-essential subset from the explicitly supplied profile.
 *  2. FAIL-LOUD RESTORE — a failing download surfaces as a typed
 *     SessionSyncError naming the session-restore step (and names a missing aws CLI),
 *     never an unattributed process death; the upload half reports 0.
 *
 * Same shape as auth.smoke.test.ts (tsx + exit code, no assert lib).
 */
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { syncBrowserDataToS3, syncBrowserDataFromS3, SessionSyncError, type S3Config } from './session-store';

const fails: string[] = [];
const check = (cond: boolean, msg: string) => { if (!cond) fails.push(msg); };

const work = mkdtempSync(join(tmpdir(), 'session-store-test-'));
const binDir = join(work, 'bin');
const logFile = join(work, 'aws-calls.log');
mkdirSync(binDir, { recursive: true });

/** Install the fake `aws` on PATH. mode: 'ok' records + exits 0; 'fail' records + exits 1. */
function installFakeAws(mode: 'ok' | 'fail'): void {
  const script = `#!/bin/sh\necho "$@" >> "${logFile}"\n${mode === 'fail' ? 'exit 1' : 'exit 0'}\n`;
  writeFileSync(join(binDir, 'aws'), script);
  chmodSync(join(binDir, 'aws'), 0o755);
}
const realPath = process.env.PATH ?? '';
const withFakePath = `${binDir}:${realPath}`;
const calls = (): string[] => (existsSync(logFile) ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean) : []);
const resetLog = (): void => { rmSync(logFile, { force: true }); };

const config: S3Config = {
  userdataS3Path: 'userdata/test-identity',
  s3Endpoint: 'http://minio.test:9000',
  s3Bucket: 'vexa-test',
  s3AccessKey: 'k',
  s3SecretKey: 's',
};

// A live-looking profile dir with an auth-essential subset present.
const liveDir = mkdtempSync(join(tmpdir(), 'browser-data-'));
mkdirSync(join(liveDir, 'Default', 'Local Storage'), { recursive: true });
writeFileSync(join(liveDir, 'Default', 'Cookies'), 'rotated-cookie-bytes');
writeFileSync(join(liveDir, 'Local State'), '{}');
writeFileSync(join(liveDir, 'Default', 'Local Storage', 'x.ldb'), 'ls');

// ── 1. confirmed profile upload uses one bounded auth-essential sync ────────
installFakeAws('ok');
process.env.PATH = withFakePath;
resetLog();
const uploaded = syncBrowserDataToS3(config, liveDir);
check(uploaded === 3, `profile upload should include the 3 present auth-essential items, got ${uploaded}`);
const upCalls = calls();
check(upCalls.length === 1, `expected one bounded aws sync invocation, got ${upCalls.length}`);
const uploadCall = upCalls[0] ?? '';
check(uploadCall.includes(`${liveDir}/`), 'profile upload must read from the explicit dataDir');
check(uploadCall.includes('--exclude *') && uploadCall.includes('--include Default/Cookies'),
  'profile upload must exclude non-auth data and include the Cookies file');
check(uploadCall.includes('s3://vexa-test/userdata/test-identity/browser-data'), 'upload must target the userdata prefix');

// ── 1b. incomplete config is a no-op (guest/anonymous path untouched) ───────
resetLog();
const noop = syncBrowserDataToS3({ userdataS3Path: 'x' }, liveDir);   // no endpoint/bucket
check(noop === 0 && calls().length === 0, 'incomplete S3 config must be a no-op (0 uploads, no aws calls)');

// ── 2. upload failures report zero without leaking raw process output ──────
installFakeAws('fail');
resetLog();
let threw = false;
let count = -1;
try { count = syncBrowserDataToS3(config, liveDir); } catch { threw = true; }
check(!threw, 'confirmed profile upload must return a result instead of throwing');
check(count === 0, `all-failing uploads must report 0 items, got ${count}`);

// ── 3. restore failure is a typed, attributed SessionSyncError (#724 C3) ────
let restoreErr: unknown;
try { syncBrowserDataFromS3(config, liveDir); } catch (e) { restoreErr = e; }
check(restoreErr instanceof SessionSyncError, 'failing restore must throw SessionSyncError (typed, not a bare exec death)');
if (restoreErr instanceof SessionSyncError) {
  check(restoreErr.step === 'session-restore', `restore error must name the session-restore step, got '${restoreErr.step}'`);
}

// ── 3b. a missing executable remains a typed recovery failure ───────────────
process.env.PATH = join(work, 'empty-bin');   // no aws anywhere on PATH
mkdirSync(process.env.PATH, { recursive: true });
let missingErr: unknown;
try { syncBrowserDataFromS3(config, liveDir); } catch (e) { missingErr = e; }
check(missingErr instanceof SessionSyncError, 'missing aws CLI must still surface as SessionSyncError');
process.env.PATH = realPath;

// ── 3c. restore with incomplete config is a no-op (anonymous bots unaffected) ──
let noopThrew = false;
try { syncBrowserDataFromS3({}, liveDir); } catch { noopThrew = true; }
check(!noopThrew, 'restore with no S3 config must be a no-op');

// ── verdict ─────────────────────────────────────────────────────────────────
rmSync(work, { recursive: true, force: true });
rmSync(liveDir, { recursive: true, force: true });
if (fails.length) {
  console.error(`session-store.test FAILED (${fails.length}):`);
  for (const f of fails) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('session-store.test OK — explicit auth-only upload; restore fail-loud + typed; upload failure returns zero.');
