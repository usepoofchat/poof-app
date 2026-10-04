# Security

Poof is an end-to-end encrypted, peer-to-peer chat that runs in the browser. This repository holds its API (the Cloudflare Worker at `api.usepoof.chat`) and the client engine the web app runs. This page explains how to report a vulnerability, what Poof claims to protect against and what it doesn't, and the limits the code enforces.

## Reporting a vulnerability

Email **security@usepoof.chat** with a description, steps to reproduce and the impact you expect. Don't open a public issue for anything that could put users at risk.

- Please don't test against other people's quant-rooms, and don't publish details until we've had time to fix it.
- Include your PGP key if you'd like an encrypted reply.
- Mention the commit you tested. `GET https://api.usepoof.chat/api/health` returns the deployed one.

We acknowledge every report within 48 hours, assess severity, agree a fix plan and coordinate the disclosure date with you. We credit reporters publicly if they wish.

Only the current deployment of `main` is supported. There are no older releases to patch.

### Severity

| Level    | Examples                                                                        |
| -------- | ------------------------------------------------------------------------------- |
| Critical | Reading message content, recovering keys, bypassing end-to-end encryption       |
| High     | Joining quant-rooms without the link or phrase, linking payments to quant-rooms |
| Medium   | Metadata leaks beyond what the threat model describes                           |
| Low      | Hardening gaps without a direct impact                                          |

### Safe harbour

We won't take legal action against good-faith research that avoids privacy violations, data destruction and service disruption, accesses no more than needed to show the issue, and gives us reasonable time to fix it before disclosure.

## What poof protects, and what it doesn't

| Who                                                           | What they get                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The network, Cloudflare, the TURN relay                       | IP addresses, timing and traffic sizes. No keys, no content.                                                                                                                                                                                                                                                             |
| Our server, honest but curious                                | The same, plus room metadata while a room exists. It can't open a 4-word-code mailbox: the address comes from a slow KDF and the blob is encrypted.                                                                                                                                                                      |
| Our server, malicious, without the link                       | Can sit in the middle of the WebRTC/ML-KEM exchange, but can't derive the keys without the room key from the link, so key confirmation fails and the connection is refused. It can deny service. It can't make a browser allocate without limit: clients cap links, ICE servers and file sizes whatever the server says. |
| Our server, malicious, with the link                          | Can sit in the middle. There is no safety code to compare yet.                                                                                                                                                                                                                                                           |
| A server sending malicious JavaScript                         | Game over, as with any web app. The engine is open source, and each API release is attested ([`VERIFICATION.md`](VERIFICATION.md)).                                                                                                                                                                                      |
| Someone with the link                                         | Is a participant. A free room holds two people, so a third one is refused.                                                                                                                                                                                                                                               |
| Another app's built-in browser (Instagram, Facebook, TikTok…) | Can read the page. poof detects the common ones and tells the person to open the link in their browser.                                                                                                                                                                                                                  |
| A compromised device, extensions, browser history             | Out of scope. The threat model at usepoof.chat/docs says so.                                                                                                                                                                                                                                                             |

Reports that show a gap between this table and the code are exactly what we want.

### Out of scope

- Attacks that need a compromised device or browser (including a malicious extension or in-app browser), and social engineering.
- Denial of service through volume. Rate limits are per IP and per Cloudflare location.
- Issues in third-party services outside Poof's control.
- Missing security headers on `/api/*` JSON responses. They aren't documents, and they carry `nosniff` and `no-store`.
- Reports that only come from automated scanners, without a concrete impact.

## Limits the code enforces

Every input has a size, a rate or both. The values live in [`packages/protocol/src/constants.ts`](packages/protocol/src/constants.ts) and [`worker/wrangler.jsonc`](worker/wrangler.jsonc).

| Input                          | Limit                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `POST /api/rooms`              | 5 per minute per IP. Body ≤ 4 KiB, cut off while reading (413).                                                             |
| `GET /api/rooms/:id`           | 30 per minute per IP                                                                                                        |
| `PUT`/`POST /api/handshakes/*` | 10 per minute per IP. Body ≤ 4 KiB, blob ≤ 2 KiB, one-time, 3 minutes.                                                      |
| WebSocket joins                | 10 per minute per IP. Browsers from origins outside `ALLOWED_ORIGINS` are refused.                                          |
| WebSocket messages             | Text only, ≤ 32 KiB in UTF-8, schema-checked. The second malformed message (or wrong destroy secret) closes the socket.     |
| Signals                        | ≤ 16 KiB each, 200 per pairing per link. Refused signals count too.                                                         |
| Room size                      | 2 people (free). Capacity is decided by the Durable Object, not the client.                                                 |
| Chat message                   | 5000 characters, normalised (NFKC, no control characters).                                                                  |
| Files (super rooms only)       | 2 MB by default. Clients refuse anything over 64 MiB whatever the server says.                                              |
| Frames between browsers        | AES-256-GCM, per-direction keys, strict sequence numbers. Anything altered, replayed, dropped or reordered closes the link. |

The tests check these limits, mostly in `worker/test/limits.test.ts`. The parsers are fuzzed in `packages/core/test/fuzz.test.ts`, `packages/protocol/test/fuzz.test.ts` and in the socket section of `worker/test/limits.test.ts`.

## Hardening in place

- **CORS**: only the origins in `ALLOWED_ORIGINS` (`https://usepoof.chat` in production) may call the API from a browser, without credentials. Writes need `Content-Type: application/json`, which forces a preflight.
- **TURN**: relay credentials are minted only when two people are paired, live as long as the room has left, and only TURN over TLS (`turns:`) is handed out.
- **Supply chain**: `pnpm audit` in CI, Dependabot for npm and GitHub Actions, actions pinned to commit SHAs, and a reproducible Worker bundle with its checksum attested on GitHub.
- **No logs of our own**: the Worker writes no logs, Workers observability is off, and there are no analytics or cookies. Cloudflare still keeps its own platform-level request metrics.

## Load testing

`e2e/load/load-test.ts` opens many rooms at once, pairs two sockets in each, sends bursts of signals both ways, can leave the rooms idle so the Durable Objects hibernate, then destroys them:

```bash
pnpm --filter @poof/worker exec wrangler dev --port 8799
pnpm --filter @poof/e2e run load -- --url http://localhost:8799 --rooms 1000 --concurrency 100 --signals 150
```

Against a deployed Worker, Cloudflare sets the client IP itself. From one machine, the rate limits cap the test at 5 new rooms a minute.
