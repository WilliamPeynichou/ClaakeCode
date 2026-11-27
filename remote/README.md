# Claake Remote

The iPhone web app (`app/`) and its Cloudflare Worker (`worker/`). The app has three tabs:

- **Conversations** (Claake Ask): chats and projects with documents. The phone calls OpenRouter itself, with each user's own key (`app/src/ask/openrouter.ts`); the Worker only stores accounts and data in D1 (`worker/ask.ts`, schema in `migrations/`).
- **Vocal**: an Ask conversation driven by voice, answers read aloud.
- **Remote**: controls the agent on the Mac. The relay (one Durable Object) only routes end-to-end encrypted frames between the Mac and the phone, and sends Web Push notifications.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in the VAPID keys (see below)
npm run build                    # builds the phone app into dist/
npm run relay                    # wrangler dev: relay and built app on http://localhost:8787
npm run dev                      # optional: the app with hot reload; relay routes go to :8787
```

### Claake Ask locally

```sh
npx wrangler d1 migrations apply claake-ask --local
```

Sign-in needs a GitHub OAuth App: put `GITHUB_CLIENT_SECRET` and `ALLOWED_GITHUB_LOGINS` (comma-separated logins) in `.dev.vars`, and `GITHUB_CLIENT_ID` in `wrangler.toml` or with `--var`. `GITHUB_OAUTH_URL` and `GITHUB_API_URL` point the Worker at a fake GitHub, as `test/ask.test.mjs` does.

Subscriptions (`worker/providers.ts`): the phone signs in to Claude, ChatGPT, Gemini or Kimi once, with the same OAuth clients as the desktop app, or saves a Mistral API key. The Worker keeps the credentials AES-GCM encrypted in D1 with `PROVIDER_ENCRYPTION_KEY`, refreshes them, and relays `POST /v1/providers/<provider>/chat`: the phone builds the provider's request body (`app/src/ask/models.ts`), the Worker adds the account's headers and envelope and streams the answer back. `PROVIDER_TEST_URL` sends every upstream call to `test/fake-providers.mjs`.

### Phone app without the Mac

`test/fake-pc.mjs` is a fake Mac. It speaks the same protocol as `src-tauri/src/remote.rs` and serves French demo conversations.

```sh
node test/fake-pc.mjs ws://localhost:8787/ws
```

It prints a pairing code (`246810` by default) and keeps its state in `/tmp/claake-fake-pc.json`.
Open `http://localhost:8787/?code=246810` with iPhone emulation, then choose « Continuer dans Safari ».
A message containing « question » asks a question card; a message containing « erreur » ends the turn with an error.

### Desktop app

The Mac connects to `DEFAULT_RELAY_WS_URL` in `src-tauri/src/remote.rs`.
Set `CLAAKE_REMOTE_RELAY_URL=ws://localhost:8787/ws` to use a local relay instead.

## Tests

```sh
npm test       # all suites in test/
npm run check  # type-checks the phone app
```

- `push.test.mjs`: Web Push encryption and VAPID signatures.
- `relay.test.mjs`: relay routing, pairing and keepalive.
- `fake-pc.test.mjs`: drives the fake Mac like the phone does.
- `ask.test.mjs`: the Ask API and the subscriptions, signed in through a fake GitHub (port 8792), with fake providers (port 8793).

The last three start `wrangler dev` (ports 8788, 8789 and 8791), each with a fresh local D1. Set `RELAY_URL=http://host:port` to test a running relay instead.

## VAPID keys

```sh
npx web-push generate-vapid-keys
```

- Local: put both keys in `.dev.vars`.
- Production: store both keys as secrets (see Deploy). `VAPID_SUBJECT` stays in `wrangler.toml`.

## Deploy

```sh
npx wrangler login
npm run deploy                          # vite build + wrangler deploy
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler d1 migrations apply claake-ask --remote
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put ALLOWED_GITHUB_LOGINS   # e.g. alice,bob
openssl rand -base64 32 | npx wrangler secret put PROVIDER_ENCRYPTION_KEY
```

Changing `PROVIDER_ENCRYPTION_KEY` disconnects every subscription.

The GitHub OAuth App's callback URL is `https://<worker host>/v1/auth/github/callback`; its Client ID goes in `GITHUB_CLIENT_ID` in `wrangler.toml`.

Then set `DEFAULT_RELAY_WS_URL` in `src-tauri/src/remote.rs` to `wss://claake-remote.<your-subdomain>.workers.dev/ws`.

## Workers Free plan

- The Durable Object uses SQLite storage (`new_sqlite_classes`), the only kind allowed on Free.
- WebSocket Hibernation keeps idle connections free of duration charges. Clients must send exactly `{"kind":"ping"}` every 25-30 s: the relay answers `{"kind":"pong"}` without waking the object.
- Incoming WebSocket messages count toward the daily request quota (20 incoming messages = 1 request). The limit is 100,000 requests per day.
- A WebSocket message can be up to 32 MiB.
- D1 (Free: 5 GB) holds the Ask data. Documents are stored in base64 chunks of 1.5 MB (a D1 row holds at most 2 MB), up to 10 MB per file; the Worker never decodes them, which keeps its CPU time low.
- One phone socket per paired device: a reconnecting phone replaces its previous socket, which iOS often leaves half-open.
