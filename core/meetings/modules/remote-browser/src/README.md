# remote-browser/src

Front door [`index.ts`](index.ts). The pieces:

- [`args.ts`](args.ts) — Chromium launch flags: `getAuthenticatedBrowserArgs` (persistent-context bot
  mode — minimal/clean, no detectable bypass flags, not incognito) and `getBrowserSessionArgs`
  (interactive VNC + CDP); `CDP_DEBUG_ARGS`.
- [`browser.ts`](browser.ts) — `launchPersistentBrowser`: the one true `launchPersistentContext` call
  (a persistent profile dir is what makes auth survive across launches).
- [`session-store.ts`](session-store.ts) — restore and explicitly persist the
  auth-essential profile subset through S3 or local storage.
- [`validate.ts`](validate.ts) — completed account-host navigation, auth-cookie,
  and optional expected-Google-identity validation.
- [`google-auth.ts`](google-auth.ts) — one bounded, trusted-origin Google
  email/password/TOTP attempt.
- [`reauth-cli.ts`](reauth-cli.ts) — machine-readable production check/recovery
  command; only a confirmed matching account reaches durable storage.
- [`login.ts`](login.ts) — interactive VNC provisioning.
- [`types.ts`](types.ts) — authentication status contracts.

External imports are Playwright plus Node builtins; TOTP uses Node crypto and
adds no dependency. Offline coverage lives in `auth.smoke.test.ts`,
`reauth.test.ts`, and `session-store.test.ts`.
