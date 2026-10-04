# Poof

The API and the client engine behind [usepoof.chat](https://usepoof.chat): a private, account-free, temporary chatroom. Messages are end-to-end encrypted in the browser (AES-256-GCM with a hybrid key: the room key from the link plus ML-KEM-768) and travel directly between browsers over WebRTC. The server never sees keys or content.

- **The API** is a Cloudflare Worker with one Durable Object per quant-room, at `https://api.usepoof.chat`. It creates rooms, relays connection details between browsers (signaling), enforces room size and lifetime, and holds the one-time mailboxes behind 4-word phrases.
- **The engine** (`packages/core`) is everything the browser does: room creation, invite links and phrases, the post-quantum key exchange, encrypted frames, WebRTC, the room state machine. The web app at usepoof.chat is a separate project and loads it as one file (`pnpm build:engine`).

How to check a deployed release: [`VERIFICATION.md`](VERIFICATION.md). Reporting a vulnerability, threat model and enforced limits: [`SECURITY.md`](SECURITY.md). Invariants and the pull request checklist: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Layout

```
worker/              Cloudflare Worker + Durable Objects: HTTP API, WebSocket signaling, TURN credentials
packages/protocol/   Wire protocol: constants, zod schemas, types (shared by client and server)
packages/core/       Client engine: crypto, phrases, signaling, WebRTC, RoomSession state machine
src/                 React hooks over the engine (src/hooks, src/room) and a bare smoke-test page (src/main.tsx)
e2e/                 The real engine against a real `wrangler dev`; browser tests in e2e/browser
tooling/             Shared ESLint config
```

## Requirements

Node 22+ and pnpm 10 (`corepack enable`).

## Develop

```bash
pnpm install
pnpm dev          # Vite on :5173 (proxies /api and /ws) + wrangler dev on :8787
```

Open `http://localhost:5173`. It's a bare smoke-test page, never deployed: "Create room" on `/`, and on `/join/#<id>.<key>` the status, path (direct/relay), chat, "Poof it now" and the raw boot log. To test a room you need two browser profiles (or one normal and one private window). Add `?relay=1` before the `#` (`/join/?relay=1#<id>.<key>`) to force the connection through TURN.

Without TURN secrets the worker falls back to STUN only, which is enough on the same machine or LAN. To test relayed connections, put Cloudflare TURN credentials in `worker/.dev.vars`:

```
TURN_KEY_ID=...
TURN_API_TOKEN=...
```

`pnpm dev` also lets a site served on `http://localhost:3000` call the local API, which is how the web app is developed against it.

## The engine for the web app

```bash
pnpm build:engine   # → dist-engine/poof-engine.js, one ES module, not minified, same bytes on every build
```

```js
import { createRoom, RoomSession, browserSocketFactory, browserRtcFactory } from "./poof-engine.js";

const API = "https://api.usepoof.chat";
const room = await createRoom({ fetch, origin: API });
const session = new RoomSession({
  roomId: room.roomId,
  roomKey: room.key,
  origin: API, // REST + signaling
  appOrigin: location.origin, // where invite links open: <appOrigin>/join/#<id>.<key>
  ownerSecret: room.ownerSecret, // creator only: allows "Poof it now"
  fetch: fetch.bind(window),
  createSocket: browserSocketFactory,
  createPeerConnection: browserRtcFactory,
});
session.subscribe((state) => render(state)); // waiting → connecting → connected → sealed
await session.start();
```

A guest opens the invite link and the app reads it with `parseInviteFragment(location.hash)`. A phrase becomes the same link with `joinByPhrase({ fetch, origin: API, appOrigin: location.origin, code })`. Every release of the API also attests the engine file (VERIFICATION.md).

## Check everything

```bash
pnpm check          # typecheck + lint + unit tests + e2e
pnpm test:all       # unit tests only (hooks, protocol, core, worker)
pnpm test:e2e       # boots wrangler dev on :8798 and runs the engine against it
pnpm test:browser   # real Chrome over real WebRTC, through the smoke-test page and wrangler dev
pnpm --filter @poof/e2e run load -- --url http://localhost:8787   # load test against a running wrangler dev (SECURITY.md)
```

| Package                    | Tests                                                                                                                                                                                                                                                                                                                                              | What they cover                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `src/`                     | `useCreateRoom`, `usePhraseJoin`, `useCountdown`, `RoomProvider`/`useRoom` in jsdom with the engine's fake server: pairing, chat, destroy, unmount/pagehide leaves, StrictMode, invalid link                                                                                                                                                       | The React hooks over the engine       |
| `packages/protocol`        | schemas, ids, constants; fuzzed with arbitrary input                                                                                                                                                                                                                                                                                               | The wire contract                     |
| `packages/core`            | crypto (hybrid key exchange, AEAD frames, tamper/replay/reflection), property-based fuzzing of every parser (frames, file lane, handshake, text, links), browser support detection, signaling client (reconnect, heartbeat), WebRTC link (negotiation, ICE queueing, direct/relay detection), full `RoomSession` flows against an in-memory server | The client engine                     |
| `worker`                   | Durable Objects inside the real Workers runtime: rooms, pairing, relay, capacity, expiry alarms, hibernation, mailbox, rate limiting, CORS, body and message limits, socket fuzzing, TURN credentials                                                                                                                                              | The API                               |
| `e2e`                      | The real engine over real WebSockets against real Durable Objects                                                                                                                                                                                                                                                                                  | Client ↔ server compatibility         |
| `e2e/browser` (Playwright) | The smoke page in isolated Chrome contexts over real WebRTC: 2-person rooms (pair, chat, destroy, room full, tab close, creator-only destroy, phrase join) and a 4-person group room (mesh, nicknames, leave, capacity, files)                                                                                                                     | What the Node tests can only simulate |

## Deploy

Attested releases go through GitHub Actions (`.github/workflows/deploy.yml`), started by hand: Actions → Deploy → staging or production. It runs the checks, bundles the Worker and the engine, attests both, deploys exactly that bundle and checks that `/api/health` reports the commit. Production is `api.usepoof.chat` (a Workers custom domain); staging is its own Worker, `poof-staging`, on workers.dev, with its own Durable Objects.

Setup, once: GitHub environments `production` and `staging`, each with secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` and variable `API_URL`. TURN secrets live in the Worker:

```bash
cd worker
pnpm exec wrangler secret put TURN_KEY_ID --env staging     # likewise TURN_API_TOKEN, and with --env="" for production
```

## Invariants (do not break)

The full list, with the pull request checklist, is in [`CONTRIBUTING.md`](CONTRIBUTING.md). In short: the room key never leaves the browser, the server never sees content, rooms are ephemeral, the Worker writes no logs, the API only answers the web app's origin, and every input has a limit.

## License

MIT, see [`LICENSE`](LICENSE).
