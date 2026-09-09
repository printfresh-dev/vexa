# @vexa/remote-browser — browser-as-container + session persistence

_meetings/ · module · a VNC/CDP persistent browser whose login session is saved + retrievable._

One concern: a VNC/CDP-attachable **persistent** browser whose login session (cookies / localStorage /
Login Data) is saved and retrievable — so the join layer can be handed an already-authenticated page
(`BotConfig.authenticated`). Carved from `vexa-bot/core/src/{s3-sync,browser-session,constans}.ts`; the
bot now imports these instead of re-declaring them (one-way rule: services import bricks).

Three flows:

1. `provisionLogin()` — start browser + VNC → a human signs in → confirm the
   protected Google identity when configured, then persist.
2. `launchPersistentBrowser({ dataDir })` + `validateLoggedIn()` — restore + confirm.
3. `node dist/reauth-cli.js [--check-only]` — restore an ephemeral Google profile,
   verify the protected credential file's account identity, perform at most one
   password/TOTP sign-in when permitted, and persist only a confirmed matching account.
   Successful checks also persist refreshed session cookies after browser close;
   `--check-only` forbids password entry, not renewal of a validated session.
   The `0600` regular file at `BOT_GOOGLE_CREDENTIALS_FILE` is JSON
   `{email,password,totpSecret?}`. S3 configuration uses the existing `BOT_*`
   variables or the `VOLTA_VEXA_*` aliases. Standard output contains one result
   JSON line; operational output is written to standard error.

Backends: S3 (`syncBrowserData{To,From}S3`) or local (`saveSessionLocal` /
`loadSessionLocal`). Durable S3 writes belong only to confirmed provisioning and
reauthentication; meeting profiles are disposable read-only snapshots, so an older
meeting cannot overwrite newer credentials. Only the auth-essential profile subset is
persisted.

> Launch flags are deliberately restrained: NO `--disable-web-security` / `--ignore-certificate-errors`
> (Google's bot layer flags those → "You can't join this video call"), AutomationControlled disabled,
> NOT incognito (incognito wipes the stored cookies that make an authenticated join work). Session mode
> additionally carries the CDP debug args so an agent can attach over the gateway proxy.

## Surface
`provisionLogin` · `attemptGoogleLogin` · `generateTotp` · `launchPersistentBrowser` ·
`validateLoggedIn` · browser args · session store. The built CLI is exported as
`@vexa/remote-browser/reauth-cli` and emitted at `dist/reauth-cli.js`.

## Verify
Build with `pnpm --filter @vexa/remote-browser run build`. Run the offline
regressions with `pnpm --filter @vexa/remote-browser test`
(`auth.smoke.test.ts`, `reauth.test.ts`, and `session-store.test.ts`). A real
Google sign-in still requires headed Chromium, the protected credential file,
and live S3 credentials.
