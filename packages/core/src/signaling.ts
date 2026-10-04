import {
  PROTOCOL_VERSION,
  TERMINAL_CLOSE_CODES,
  WS_PING,
  WS_PING_INTERVAL_MS,
  WS_PONG,
  WS_PONG_TIMEOUT_MS,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "@poof/protocol";

/** The subset of the browser WebSocket we use. Node 22's global WebSocket satisfies it too. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type SocketFactory = (url: string) => WebSocketLike;

/** Real browser WebSocket behind the structural interface. The one cast lives here, at the boundary. */
export const browserSocketFactory: SocketFactory = (url) =>
  new WebSocket(url) as unknown as WebSocketLike;

export const WS_OPEN = 1;

export type SignalingStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface SignalingOptions {
  url: string;
  createSocket: SocketFactory;
  onMessage: (msg: ServerMessage) => void;
  onStatus?: (status: SignalingStatus) => void;
  /** The server closed the socket with a code after which reconnecting is pointless. */
  onTerminalClose: (code: number, reason: string) => void;
  /** Delay before reconnect attempt n (the last value repeats). */
  backoffMs?: readonly number[];
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

const DEFAULT_BACKOFF_MS = [500, 1000, 2000, 4000, 5000] as const;

/**
 * Signaling WebSocket with the two behaviours the room protocol needs:
 *  - an application heartbeat: a literal "ping" every interval; if nothing arrives back within the
 *    timeout the socket is treated as dead (mobile browsers can lose a socket without a close
 *    event) and replaced. The Durable Object answers "pong" without waking up, so this is free.
 *  - reconnection with backoff using the SAME peerId (it's in the URL), which the server treats as
 *    "replace my old socket", so a returning client never pairs with its own zombie.
 */
export class SignalingClient {
  private socket: WebSocketLike | null = null;
  private attempt = 0;
  private closedByUs = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly opts: SignalingOptions) {}

  connect(): void {
    if (this.closedByUs) return;
    this.opts.onStatus?.(this.attempt === 0 ? "connecting" : "reconnecting");
    const socket = this.opts.createSocket(this.opts.url);
    this.socket = socket;

    socket.onopen = () => {
      if (socket !== this.socket) return;
      this.attempt = 0;
      this.opts.onStatus?.("open");
      this.startHeartbeat(socket);
    };
    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.onData(event.data);
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.handleDown(socket, event.code, event.reason);
    };
    socket.onerror = () => {
      // A close event always follows; nothing to do here.
    };
  }

  /** Returns false if the socket isn't open (the message is NOT queued). */
  send(msg: ClientMessage): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WS_OPEN;
  }

  close(): void {
    this.closedByUs = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      try {
        socket.close(1000, "client_closed");
      } catch {
        /* already closed */
      }
    }
    this.opts.onStatus?.("closed");
  }

  private onData(data: unknown): void {
    // Any inbound traffic proves the socket is alive, not just "pong".
    this.clearPongTimer();
    if (typeof data !== "string" || data === WS_PONG) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = serverMessageSchema.safeParse(json);
    if (!parsed.success || parsed.data.v !== PROTOCOL_VERSION) return;
    this.opts.onMessage(parsed.data);
  }

  private startHeartbeat(socket: WebSocketLike): void {
    this.stopHeartbeat();
    const interval = this.opts.pingIntervalMs ?? WS_PING_INTERVAL_MS;
    const timeout = this.opts.pongTimeoutMs ?? WS_PONG_TIMEOUT_MS;
    this.pingTimer = setInterval(() => {
      if (socket !== this.socket) return;
      try {
        socket.send(WS_PING);
      } catch {
        this.handleDown(socket, 4999, "send_failed");
        return;
      }
      this.clearPongTimer();
      this.pongTimer = setTimeout(() => {
        if (socket === this.socket) this.handleDown(socket, 4998, "pong_timeout");
      }, timeout);
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPongTimer();
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  /** The socket closed (or was declared dead). Reconnect unless the server said not to. */
  private handleDown(socket: WebSocketLike, code: number, reason: string): void {
    if (this.closedByUs || socket !== this.socket) return;
    this.stopHeartbeat();
    this.socket = null;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close(1000, "replaced_by_client");
    } catch {
      /* already closed */
    }

    if (TERMINAL_CLOSE_CODES.has(code)) {
      this.closedByUs = true;
      this.opts.onStatus?.("closed");
      this.opts.onTerminalClose(code, reason);
      return;
    }

    const backoff = this.opts.backoffMs ?? DEFAULT_BACKOFF_MS;
    const delay = backoff[Math.min(this.attempt, backoff.length - 1)] ?? 1000;
    this.attempt += 1;
    this.opts.onStatus?.("reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }
}
