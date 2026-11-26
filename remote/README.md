# Claake Remote

The iPhone web app (`app/`) and the relay (`worker/`), a Cloudflare Worker with one Durable Object.
The relay only routes end-to-end encrypted frames between the Mac and the phone, serves the built phone app, and sends Web Push notifications.

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in the VAPID keys (see below)
npm run build                    # builds the phone app into dist/
npm run relay                    # wrangler dev: relay and built app on http://localhost:8787
npm run dev                      # optional: the app with hot reload; relay routes go to :8787
```

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

The last two start `wrangler dev` on ports 8788 and 8789. Set `RELAY_URL=http://host:port` to test a running relay instead.

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
```

Then set `DEFAULT_RELAY_WS_URL` in `src-tauri/src/remote.rs` to `wss://claake-remote.<your-subdomain>.workers.dev/ws`.

## Workers Free plan

- The Durable Object uses SQLite storage (`new_sqlite_classes`), the only kind allowed on Free.
- WebSocket Hibernation keeps idle connections free of duration charges. Clients must send exactly `{"kind":"ping"}` every 25-30 s: the relay answers `{"kind":"pong"}` without waking the object.
- Incoming WebSocket messages count toward the daily request quota (20 incoming messages = 1 request). The limit is 100,000 requests per day.
- A WebSocket message can be up to 32 MiB.
- One phone socket per paired device: a reconnecting phone replaces its previous socket, which iOS often leaves half-open.
