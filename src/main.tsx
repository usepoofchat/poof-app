// Smoke-test shell: a bare page that drives the real hooks (useCreateRoom, RoomProvider/useRoom,
// useCountdown) in a real browser. No design on purpose: it's how the browser tests drive poof end to end.
//
//   /                          → "Create room"
//   /join/#<id>.<key>          → the room
//   /join/?relay=1#<id>.<key>  → same, but force ICE through TURN (needs TURN secrets in worker/.dev.vars)
//
// The body carries data-status / data-connection / data-end-reason / data-error for the Playwright
// smoke test (e2e/browser).

import { StrictMode, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  PoofError,
  browserRtcFactory,
  type ChatItem,
  type RtcFactory,
  type RtcPeerConnectionLike,
} from "@poof/core";
import { useCountdown } from "./hooks/useCountdown.ts";
import { useCreateRoom } from "./hooks/useCreateRoom.ts";
import { useBrowserSupport } from "./hooks/useBrowserSupport.ts";
import { usePhraseJoin } from "./hooks/usePhraseJoin.ts";
import { RoomProvider } from "./room/RoomProvider.tsx";
import { useRoom } from "./room/useRoom.ts";
import "./smoke.css";

function errorText(error: unknown): string {
  return error instanceof PoofError ? `${error.code}: ${error.message}` : String(error);
}

// Keep ?relay=1 when moving into the room.
const keepQuery = (path: string) => {
  const [pathname, hash] = path.split("#");
  window.location.assign(`${pathname}${window.location.search}#${hash}`);
};

function JoinByCode() {
  const { join, joining, error } = usePhraseJoin({ navigate: keepQuery });
  const [code, setCode] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void join(code);
      }}
    >
      <h2>Have a code?</h2>
      <input
        data-testid="code-input"
        placeholder="four words"
        autoComplete="off"
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button data-testid="join" type="submit" disabled={joining}>
        Join
      </button>
      <p data-testid="join-error" className="error">
        {error ?? ""}
      </p>
    </form>
  );
}

function ShareByCode() {
  const { state, actions } = useRoom();
  const { label } = useCountdown(state.phrase?.expiresAt ?? null);
  const [error, setError] = useState("");
  return (
    <p>
      <button
        data-testid="share-code"
        onClick={() => {
          setError("");
          actions.createPhrase().catch((e: unknown) => setError(errorText(e)));
        }}
      >
        Share via code
      </button>{" "}
      {state.phrase ? (
        <>
          <strong data-testid="phrase">{state.phrase.code}</strong> (expires in {label})
        </>
      ) : null}
      <span className="error">{error}</span>
    </p>
  );
}

function Landing() {
  const { create, creating, error } = useCreateRoom({ navigate: keepQuery });
  return (
    <>
      <h1>poof · smoke test</h1>
      <button data-testid="create" disabled={creating} onClick={() => void create()}>
        Create room
      </button>
      <p data-testid="create-error" className="error">
        {error ? `${error.code}: ${error.message}` : ""}
      </p>
      <JoinByCode />
    </>
  );
}

/** Group rooms: who's here, with their path, plus your own nickname. */
function Members() {
  const { state, actions } = useRoom();
  const [name, setName] = useState("");
  return (
    <div>
      <p>
        <input
          data-testid="nickname-input"
          placeholder="Your name (optional)"
          maxLength={64}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button data-testid="nickname-save" onClick={() => actions.setNickname(name)}>
          Set name
        </button>{" "}
        You: {state.nickname ?? "(no name)"} · {state.members.length + 1}/{state.maxPeers} people
      </p>
      {state.membersMismatch ? (
        <p data-testid="mismatch" className="error">
          Not everyone sees the same people in this room.
        </p>
      ) : null}
      <ul data-testid="members">
        {state.members.map((m) => (
          <li key={m.peerId} data-state={m.state}>
            {`${m.nickname ? `${m.nickname} · ` : ""}${m.label} — ${m.state}${m.connectionType ? ` (${m.connectionType})` : ""}`}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A file bubble: status, progress, "delivered to N of M", download link, cancel. */
function FileLine({ item }: { item: Extract<ChatItem, { kind: "file" }> }) {
  const { actions } = useRoom();
  const active = item.status === "sending" || item.status === "sent" || item.status === "receiving";
  const detail = [
    item.status,
    active ? `${Math.round(item.progress * 100)}%` : null,
    item.mine ? `delivered to ${item.delivered} of ${item.recipients}` : null,
    item.error ? `(${item.error})` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      {`[file] ${item.name} (${item.size} B) — `}
      <span data-testid="file-status">{detail}</span>{" "}
      {item.url ? (
        <a data-testid="file-link" href={item.url} download={item.name}>
          Download
        </a>
      ) : null}
      {active ? (
        <button data-testid="file-cancel" onClick={() => actions.abortTransfer(item.id)}>
          Cancel
        </button>
      ) : null}
    </>
  );
}

function Room({ forceRelay }: { forceRelay: boolean }) {
  const { state, actions } = useRoom();
  const { label } = useCountdown(state.expiresAt);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState("");

  useEffect(() => {
    const body = document.body.dataset;
    body.status = state.status;
    body.connection = state.connectionType ?? "";
    body.endReason = state.endReason ?? "";
    body.error = state.error?.code ?? "";
    body.members = String(state.members.filter((m) => m.state === "sealed").length);
    body.mismatch = String(state.membersMismatch);
    body.files = String(state.limits.fileTransfer);
  }, [
    state.status,
    state.connectionType,
    state.endReason,
    state.error,
    state.members,
    state.membersMismatch,
    state.limits,
  ]);

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSendError("");
    actions
      .sendMessage(draft)
      .then(() => setDraft(""))
      .catch((error: unknown) => setSendError(errorText(error)));
  };

  const connected = state.status === "sealed";
  const ended = ["terminated", "expired", "error"].includes(state.status);
  const group = state.maxPeers > 2;
  const nameOf = (peerId: string) => {
    const m = state.members.find((x) => x.peerId === peerId);
    const label = m?.label ?? peerId.slice(0, 6);
    return m?.nickname ? `${m.nickname} · ${label}` : label;
  };
  const statusLine = [
    state.status,
    state.isOwner ? "creator" : "guest",
    state.role ? `role ${state.role}` : null,
    state.connectionType ? `path ${state.connectionType}` : null,
    state.endReason ? `ended: ${state.endReason}` : null,
    state.error ? `error ${state.error.code}: ${state.error.message}` : null,
    forceRelay ? "relay forced" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <h1>poof · smoke test</h1>
      <p data-testid="status">{statusLine}</p>
      <p>
        Expires in <span data-testid="timer">{label}</span>
      </p>
      <p>
        Invite: <input data-testid="invite" readOnly size={80} value={state.inviteUrl} />
        <button onClick={() => void navigator.clipboard.writeText(state.inviteUrl).catch(() => {})}>
          Copy link
        </button>
      </p>
      <ShareByCode />
      {group ? <Members /> : null}
      <ul data-testid="messages" className="messages">
        {state.messages.map((item) =>
          item.kind === "system" ? (
            <li key={item.id} className="system" data-system={item.event}>
              {`${nameOf(item.peerId)} ${item.event}`}
            </li>
          ) : (
            <li
              key={item.id}
              className={item.mine ? "mine" : "theirs"}
              data-mine={String(item.mine)}
              data-kind={item.kind}
              {...(item.kind === "file" ? { "data-file-status": item.status } : {})}
            >
              {group && !item.mine && item.from ? (
                <span className="who">{`${nameOf(item.from)}: `}</span>
              ) : null}
              {item.kind === "text" ? item.text : <FileLine item={item} />}
            </li>
          ),
        )}
      </ul>
      <form onSubmit={onSubmit}>
        <input
          data-testid="message-input"
          placeholder="Message"
          autoComplete="off"
          disabled={!connected}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button data-testid="send" type="submit" disabled={!connected}>
          Send
        </button>
      </form>
      {state.limits.fileTransfer ? (
        <p>
          Send a file (≤ {state.limits.fileMaxBytes} B):{" "}
          <input
            data-testid="file-input"
            type="file"
            disabled={!connected}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setSendError("");
              actions.sendFile(file).catch((error: unknown) => setSendError(errorText(error)));
            }}
          />
        </p>
      ) : (
        <p>Files are available in super rooms.</p>
      )}
      <p data-testid="send-error" className="error">
        {sendError}
      </p>
      {state.isOwner ? (
        <button data-testid="destroy" disabled={ended} onClick={() => void actions.destroy()}>
          Poof it now
        </button>
      ) : (
        <button
          data-testid="leave"
          disabled={ended}
          onClick={() => void actions.leave().then(() => window.location.assign("/"))}
        >
          Leave
        </button>
      )}
      <h2>Boot log</h2>
      <ol data-testid="log" className="log">
        {state.log.map((entry, i) => (
          <li key={i} className={entry.level}>
            {`${new Date(entry.ts).toISOString().slice(11, 23)} [${entry.level}] ${entry.code}${
              entry.data ? ` ${JSON.stringify(entry.data)}` : ""
            }`}
          </li>
        ))}
      </ol>
    </>
  );
}

const relayOnly: RtcFactory = (config) =>
  new RTCPeerConnection({
    ...config,
    iceTransportPolicy: "relay",
  }) as unknown as RtcPeerConnectionLike;

/** What a UI shows when this browser can't run a room, or is an app's browser. */
function Unsupported({ missing }: { missing: string[] }) {
  return (
    <div data-testid="unsupported" data-missing={missing.join(" ")}>
      <h1>This browser can't open poof</h1>
      <p>
        Missing: {missing.join(", ")}. Open the link in an up-to-date Chrome, Firefox, Safari or
        Edge.
      </p>
    </div>
  );
}

function InAppNotice({ app, platform }: { app: string; platform: string }) {
  return (
    <p data-testid="in-app" data-app={app} data-platform={platform} className="warn">
      You opened this inside {app === "webview" ? "another app" : app}. That app can see the page,
      keys included: open the link in your browser instead.
    </p>
  );
}

function Route() {
  const support = useBrowserSupport();
  const path = window.location.pathname.replace(/\/+$/, "");
  if (!support.ok) return <Unsupported missing={support.missing} />;
  const notice = support.inApp ? (
    <InAppNotice app={support.inApp} platform={support.platform} />
  ) : null;
  if (path !== "/join") {
    return (
      <>
        {notice}
        <Landing />
      </>
    );
  }
  const forceRelay = new URLSearchParams(window.location.search).get("relay") === "1";
  return (
    <>
      {notice}
      <RoomProvider createPeerConnection={forceRelay ? relayOnly : browserRtcFactory}>
        <Room forceRelay={forceRelay} />
      </RoomProvider>
    </>
  );
}

function App() {
  return <Route />;
}

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
