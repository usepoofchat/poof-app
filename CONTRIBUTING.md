# Contributing

Thanks for helping. Poof makes privacy promises to its users. The invariants below are how the code keeps them, and a change that breaks one won't be merged, however useful it is.

Security issues go through [`SECURITY.md`](SECURITY.md), not through public issues or pull requests.

## Setup

Node 22+ and pnpm 10 (`corepack enable`), then:

```bash
pnpm install
pnpm dev            # Vite on :5173 + wrangler dev on :8787
pnpm check          # typecheck + lint + unit tests + e2e: run before every pull request
pnpm test:browser   # real Chrome over real WebRTC, through the smoke-test page
```

[`README.md`](README.md) describes the layout and what each test suite covers.

## Where code goes

- **Logic** lives in `packages/core` (the headless engine) and in the hooks under `src/hooks` and `src/room`. **Components** read state and call actions from hooks. They never touch WebSockets, WebRTC or crypto.
- **Anything that crosses the wire** (HTTP bodies, WebSocket messages, DataChannel frames and their plaintexts) is defined once, as a zod schema in `packages/protocol`. The Worker and the client both use it.
- **The web app** (https://usepoof.chat) is a separate project. It loads the engine from `pnpm build:engine` and calls the API. When behaviour changes here, the claims in its docs have to change too.

## Invariants

1. **Keys are made in the browser and stay there.** The room key lives only in the URL fragment and in memory. It never appears in a request, a header, a log or storage. Session keys never leave the browser that derived them.
2. **The server never sees content.** Chat, files, file names and nicknames travel only as end-to-end encrypted DataChannel frames between browsers. Nothing readable is sent to the server or stored anywhere.
3. **Signaling is a relay, not a transport.** The Worker forwards WebRTC offers, answers and candidates, stamps the sender's id itself, and tracks presence. Chat never goes over the signaling socket, not even as a fallback.
4. **The server enforces capacity.** The Durable Object decides who gets a slot (2 people in a free room). A client can't talk its way past it.
5. **Rooms are ephemeral.** Durable Object storage is deleted when a room expires or is destroyed. A 4-word-code mailbox holds one encrypted blob for at most 3 minutes and is emptied when it's read.
6. **Logging stays off.** Workers observability stays disabled, the Worker doesn't call `console.*`, and there are no analytics, cookies, fingerprinting or third-party scripts. The only browser storage is the creator's owner secret, in the creator tab's `sessionStorage`.
7. **The API stays narrow.** Only the origins in `ALLOWED_ORIGINS` get CORS, without credentials, and the Worker serves nothing but `/api/*` and `/ws/*`.
8. **Every input has a limit.** A new endpoint or message gets a size cap in `packages/protocol/src/constants.ts`, a schema, a rate limit or budget, and tests that go past the limit. Anything that parses bytes from the network gets a property-based test (fast-check) next to the existing ones.
9. **The client doesn't trust the server for resources.** Values that make a browser allocate or connect (peer counts, file sizes, ICE servers) are capped on the client too.
10. **Wire changes are versioned.** An incompatible change to WebSocket or DataChannel messages bumps `PROTOCOL_VERSION`.
11. **Builds stay reproducible and attested.** Same commit, same bytes (CI checks this). Attested releases go through `.github/workflows/deploy.yml`; a deployment made any other way reports `"commit":"dev"` on `/api/health`.

## Pull request checklist

- [ ] `pnpm check` passes. If you touched the UI, WebRTC or the build, `pnpm test:browser` passes too.
- [ ] No invariant above is weakened. If one has to change, the pull request says so in its first line and explains why.
- [ ] No new identifier links a person to room activity (no stable ids, no IPs in storage, no new headers that carry either).
- [ ] New inputs have limits and tests that go past them (invariant 8).
- [ ] Claims in [`SECURITY.md`](SECURITY.md) and the web app's docs still match the code.
- [ ] New dependencies are necessary, maintained and small. Each one enters the attested build and the audit.

## Style

TypeScript strict, ESLint and Prettier (`pnpm format`). Tests sit next to the code they cover, or in the package's `test/` folder. Comments explain why the code does something, not what it does.
