import { PyoSandboxError, clientError, codeForStatus } from "./errors.js";
import type { Connection, WebSocketInstance, WebSocketLike } from "./types.js";
import {
  Kind,
  WireError,
  decodeFrame,
  encodeFrame,
  negotiate,
  parseJson,
  type Frame,
  type Hello,
} from "./wire.js";

/** Hands out the current connection and gets a new token when asked. */
export interface Access {
  connection(): Promise<Connection>;
  refresh(): Promise<Connection>;
}

export interface DaemonOptions {
  fetch?: typeof fetch;
  WebSocket?: WebSocketLike;
}

interface CallOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Send the body as is, not as JSON. */
  raw?: boolean;
  /** Return the bytes, not JSON. */
  bytes?: boolean;
}

/** Calls to the sandbox server's daemon, straight from the client with the sandbox token. */
export class Daemon {
  private readonly fetch: typeof fetch;
  private readonly WS?: WebSocketLike;

  constructor(
    private readonly access: Access,
    opts: DaemonOptions = {},
  ) {
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw clientError("This runtime has no fetch. Pass one in the options.", "noFetch");
    this.fetch = f.bind(globalThis);
    this.WS = opts.WebSocket ?? (globalThis as { WebSocket?: WebSocketLike }).WebSocket;
  }

  /** A call on `/v1/sandboxes/{id}{sub}`. On 401 it gets a new token and tries once more. */
  async call<T>(method: string, sub: string, opts: CallOptions = {}): Promise<T> {
    let conn = await this.access.connection();
    try {
      return await this.once<T>(conn, method, sub, opts);
    } catch (e) {
      if (!(e instanceof PyoSandboxError) || e.source !== "server" || e.status !== 401) throw e;
      conn = await this.access.refresh();
      return this.once<T>(conn, method, sub, opts);
    }
  }

  private async once<T>(conn: Connection, method: string, sub: string, opts: CallOptions): Promise<T> {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) q.set(k, v);
    const qs = q.size > 0 ? `?${q}` : "";
    const url = `${trimSlash(conn.url)}/v1/sandboxes/${encodeURIComponent(conn.sandboxId)}${sub}${qs}`;
    const headers: Record<string, string> = { authorization: `Bearer ${conn.token}` };
    let body: BodyInit | undefined;
    if (opts.body !== undefined) {
      if (opts.raw) {
        headers["content-type"] = "application/octet-stream";
        body = opts.body as BodyInit;
      } else {
        headers["content-type"] = "application/json";
        body = JSON.stringify(opts.body);
      }
    }
    let res: Response;
    try {
      res = await this.fetch(url, { method, headers, body });
    } catch (e) {
      throw new PyoSandboxError(
        `Couldn't reach the sandbox server at ${conn.url}: ${(e as Error).message}. It answers on your tailnet only.`,
        { source: "server", code: "unreachable", cause: e },
      );
    }
    if (!res.ok) throw daemonError(res.status, await res.text());
    if (opts.bytes) return new Uint8Array(await res.arrayBuffer()) as T;
    const text = await res.text();
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /** Opens the sandbox's WebSocket and waits for envd's Hello. */
  async session(): Promise<Session> {
    if (!this.WS) {
      throw clientError(
        "This runtime has no global WebSocket. On Node 20, install `ws` and pass it: Sandbox.create({ ..., WebSocket })",
        "noWebSocket",
      );
    }
    const conn = await this.access.connection();
    try {
      return await Session.open(this.WS, conn);
    } catch (e) {
      // The daemon closes a refused connection with 4000 + the HTTP status
      // and the reason. A token that ran out gets one more try.
      if (e instanceof PyoSandboxError && e.status !== undefined) {
        if (e.status === 401) return Session.open(this.WS, await this.access.refresh());
        throw e;
      }
      // No reason given: a proxy in between, most likely. Ask over HTTP.
      const why = await this.once(conn, "GET", "", {}).then(
        () => null,
        (err: unknown) => err,
      );
      if (why instanceof PyoSandboxError && why.status === 401) {
        return Session.open(this.WS, await this.access.refresh());
      }
      throw why ?? e;
    }
  }
}

/** The subprotocols the daemon takes: `pyo`, and the token as `pyo.token.<token>`. */
export const WS_PROTOCOL = "pyo";
export const WS_TOKEN_PROTOCOL = "pyo.token.";

/**
 * Why the WebSocket closed. The daemon refuses a connection by closing it
 * with 4000 + the HTTP status (4401, 4403, 4404…) and the reason.
 */
export function closeError(code?: number, reason?: string): PyoSandboxError {
  if (code !== undefined && code >= 4000 && code < 5000) {
    const status = code - 4000;
    return new PyoSandboxError(reason || `The sandbox server refused the connection (${status}).`, {
      source: "server",
      code: codeForStatus(status),
      status,
    });
  }
  return new PyoSandboxError(
    `The WebSocket to the sandbox closed${code ? ` (${code}${reason ? `: ${reason}` : ""})` : ""}.`,
    { source: "server", code: "closed" },
  );
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

export function daemonError(status: number, text: string): PyoSandboxError {
  let code = codeForStatus(status);
  let message = "";
  try {
    const body = JSON.parse(text) as { type?: string; error?: { code?: string; message?: string } };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // Not the daemon's JSON.
  }
  if (!message) message = `The sandbox server answered ${status}${text ? `: ${text.slice(0, 200)}` : "."}`;
  return new PyoSandboxError(message, { source: "server", code, status });
}

// ── The WebSocket ──────────────────────────────────────────────────────────

export interface StreamHandler {
  onFrame(f: Frame): void;
  /** The connection ended before the stream did. */
  onClose(err: PyoSandboxError): void;
}

const OPEN = 1;
const HELLO_TIMEOUT_MS = 15_000;

/**
 * One WebSocket to the sandbox, carrying many streams. The daemon opens a
 * fresh envd connection for each WebSocket, and checks every request
 * against the token the WebSocket opened with.
 */
export class Session {
  hello!: Hello;
  protocol = 0;
  private next = 1;
  private readonly streams = new Map<number, StreamHandler>();
  private closed: PyoSandboxError | null = null;
  private chain: Promise<void> = Promise.resolve();
  private onHello?: (err: Error | null) => void;

  private constructor(private readonly ws: WebSocketInstance) {}

  static open(WS: WebSocketLike, conn: Connection): Promise<Session> {
    const base = trimSlash(conn.url).replace(/^http/, "ws");
    // Browsers can't set headers on a WebSocket, so the token goes as a
    // subprotocol, which keeps it out of URLs and logs.
    const url = `${base}/v1/sandboxes/${encodeURIComponent(conn.sandboxId)}/connect`;
    let ws: WebSocketInstance;
    try {
      ws = new WS(url, [WS_PROTOCOL, `${WS_TOKEN_PROTOCOL}${conn.token}`]);
    } catch (e) {
      return Promise.reject(clientError(`Couldn't open the WebSocket: ${(e as Error).message}`, "websocket", e));
    }
    ws.binaryType = "arraybuffer";
    const s = new Session(ws);
    return new Promise<Session>((resolve, reject) => {
      const timer = setTimeout(() => {
        s.onHello = undefined;
        ws.close();
        reject(new PyoSandboxError("The sandbox didn't greet the WebSocket in time.", { source: "server", code: "timeout" }));
      }, HELLO_TIMEOUT_MS);
      s.onHello = (err) => {
        clearTimeout(timer);
        s.onHello = undefined;
        if (err) {
          ws.close();
          reject(err);
        } else resolve(s);
      };
      ws.onmessage = (ev) => s.receive(ev.data);
      ws.onerror = () => s.end(new PyoSandboxError("The WebSocket to the sandbox failed.", { source: "server", code: "websocket" }));
      ws.onclose = (ev) => s.end(closeError(ev?.code, ev?.reason));
    });
  }

  private receive(data: unknown): void {
    // Keep frames in order even when some arrive as Blobs.
    this.chain = this.chain.then(async () => {
      const bytes = await toBytes(data);
      if (!bytes) return;
      let f: Frame;
      try {
        f = decodeFrame(bytes);
      } catch (e) {
        this.end(new PyoSandboxError(`A bad frame from the sandbox: ${(e as Error).message}`, { source: "server", code: "protocol", cause: e }));
        this.ws.close();
        return;
      }
      this.dispatch(f);
    });
  }

  private dispatch(f: Frame): void {
    if (this.onHello) {
      if (f.kind !== Kind.Hello) {
        this.onHello(new PyoSandboxError("The sandbox's first frame wasn't Hello.", { source: "server", code: "protocol" }));
        return;
      }
      try {
        this.hello = parseJson<Hello>(f);
        this.protocol = negotiate(this.hello);
        this.onHello(null);
      } catch (e) {
        const msg = e instanceof WireError ? e.message : `Bad Hello: ${(e as Error).message}`;
        this.onHello(new PyoSandboxError(msg, { source: "sandbox", code: "protocol", cause: e }));
      }
      return;
    }
    if (f.stream === 0) return;
    this.streams.get(f.stream)?.onFrame(f);
  }

  private end(err: PyoSandboxError): void {
    if (this.closed) return;
    this.closed = err;
    this.onHello?.(err);
    const handlers = [...this.streams.values()];
    this.streams.clear();
    for (const h of handlers) h.onClose(err);
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === OPEN;
  }

  /** Takes a new stream number for `handler`. */
  stream(handler: StreamHandler): number {
    if (this.closed) throw this.closed;
    const id = this.next++;
    this.streams.set(id, handler);
    return id;
  }

  /** Forgets a stream that ended. */
  release(id: number): void {
    this.streams.delete(id);
  }

  send(f: Frame): void {
    if (this.closed) throw this.closed;
    this.ws.send(encodeFrame(f));
  }

  close(): void {
    this.end(new PyoSandboxError("The connection was closed.", { source: "client", code: "closed" }));
    try {
      this.ws.close();
    } catch {
      // Already gone.
    }
  }
}

async function toBytes(data: unknown): Promise<Uint8Array | null> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data)) {
    // `ws` may hand over a list of Buffers.
    const parts = data as Uint8Array[];
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  // Text messages aren't part of the protocol.
  return null;
}
