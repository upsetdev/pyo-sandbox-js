import { Daemon, type Access } from "./daemon.js";
import { PyoSandboxError, clientError } from "./errors.js";
import { CommandHandle, PortConnection, Pty, toBytes } from "./process.js";
import { PyoApi, envTeam, isMissingRoute } from "./pyo.js";
import type {
  ClientOptions,
  ConnectOptions,
  Connection,
  CreateOptions,
  ExecOptions,
  ExecResult,
  ListOptions,
  OpenPortOptions,
  PtyOptions,
  RemoveOptions,
  SandboxInfo,
  SpawnOptions,
  Ttl,
  WriteFileOptions,
} from "./types.js";
import type { Cmd, FileEntry, Response } from "./wire.js";

const DEFAULT_REFRESH_MARGIN_MS = 5 * 60_000;

export interface FromConnectionOptions extends ClientOptions {
  /**
   * Gets a new connection when the token is about to run out, for clients
   * that got their connection from your backend instead of an API key.
   */
  refreshToken?: () => Promise<Connection>;
  /**
   * @deprecated The sandbox server now adds the sandbox's env to every
   * command and terminal. Kept so older code still compiles. It does nothing.
   */
  env?: Record<string, string>;
}

/** The daemon's buffered exec answer. */
interface DaemonExecResult {
  exitCode: number | null;
  signal?: number;
  stdout: string;
  stderr: string;
  truncated?: boolean;
  timedOut?: boolean;
  durationMs: number;
}

/**
 * A sandbox: an isolated machine on one of your sandbox servers.
 *
 * Lifecycle calls (pause, resume, extend, delete, tokens, ports) go to
 * Pyo. Commands, terminals and files go straight to the sandbox server
 * with a short-lived token that the SDK renews through Pyo.
 */
export class Sandbox implements Access {
  readonly id: string;
  /** The sandbox as Pyo last showed it. Missing for `fromConnection` without an API key. */
  info?: SandboxInfo;
  readonly files: Files;
  readonly ports: Ports;

  private conn: Connection;
  private renewing?: Promise<Connection>;
  private readonly daemon: Daemon;
  private readonly margin: number;

  private constructor(
    conn: Connection,
    private readonly pyo: PyoApi | undefined,
    private readonly opts: FromConnectionOptions,
    info?: SandboxInfo,
  ) {
    this.id = conn.sandboxId;
    this.conn = conn;
    this.info = info;
    this.margin = opts.tokenRefreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
    this.daemon = new Daemon(this, { fetch: opts.fetch, WebSocket: opts.WebSocket });
    this.files = new Files(this.daemon);
    this.ports = new Ports(this, this.daemon);
  }

  /** Creates a sandbox and returns it once Pyo has started it. */
  static async create(opts: CreateOptions = {}): Promise<Sandbox> {
    const pyo = new PyoApi(opts);
    // Without one, Pyo takes the API key's only team, or says to pass one.
    const teamId = opts.teamId ?? envTeam();
    // Without one, Pyo starts it from its built-in template, base.
    const body: Record<string, unknown> = {
      ...(teamId ? { teamId } : {}),
      ...(opts.template ? { template: opts.template } : {}),
    };
    // Pyo refuses unknown fields, so only send what was given.
    const fields = [
      "name",
      "server",
      "cpus",
      "memoryMib",
      "diskMib",
      "ttl",
      "pauseWhenIdleSecs",
      "env",
      "network",
      "isolation",
      "labels",
      "projectId",
    ] as const;
    for (const k of fields) if (opts[k] !== undefined) body[k] = opts[k];
    const res = await pyo.create(body);
    return new Sandbox(res.connection, pyo, opts, res.sandbox ?? undefined);
  }

  /** Reconnects to an existing sandbox with a fresh token. */
  static async connect(id: string, opts: ConnectOptions = {}): Promise<Sandbox> {
    const pyo = new PyoApi(opts);
    const info = await pyo.get(id);
    // getSandbox brings a connection when the key may use the sandbox.
    const conn = info.connection ?? (await pyo.token(id));
    return new Sandbox(conn, pyo, opts, info);
  }

  /**
   * Uses a connection you already have, like one your backend made with
   * `Sandbox.create` and passed on. Lifecycle calls need an API key.
   */
  static fromConnection(conn: Connection, opts: FromConnectionOptions = {}): Sandbox {
    let pyo: PyoApi | undefined;
    try {
      pyo = new PyoApi(opts);
    } catch {
      pyo = undefined;
    }
    return new Sandbox(conn, pyo, opts);
  }

  /** A team's sandboxes. */
  static async list(opts: ListOptions = {}): Promise<SandboxInfo[]> {
    const pyo = new PyoApi(opts);
    const teamId = opts.teamId ?? envTeam();
    if (!teamId) throw clientError("Set PYO_TEAM or pass teamId.", "missingTeam");
    return (await pyo.list(teamId, opts.state)).sandboxes;
  }

  // ── Tokens ───────────────────────────────────────────────────────────────

  /** The current connection. Renews the token first when it's about to run out. */
  async connection(): Promise<Connection> {
    if (this.conn.expiresAt - Date.now() > this.margin) return this.conn;
    return this.refresh();
  }

  /** Asks Pyo for a new token now. */
  refresh(): Promise<Connection> {
    this.renewing ??= this.renew().finally(() => {
      this.renewing = undefined;
    });
    return this.renewing;
  }

  private async renew(): Promise<Connection> {
    let next: Connection;
    if (this.pyo) next = await this.pyo.token(this.id);
    else if (this.opts.refreshToken) next = await this.opts.refreshToken();
    else {
      throw clientError(
        "The sandbox token ran out and there's no way to get a new one. Pass an API key or refreshToken.",
        "tokenExpired",
      );
    }
    this.conn = next;
    return next;
  }

  /** Where the sandbox's server is, and the current token. */
  get url(): string {
    return this.conn.url;
  }

  get tokenExpiresAt(): number {
    return this.conn.expiresAt;
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  /**
   * Runs a command and waits for it. A string runs with `/bin/sh -c`, an
   * array runs as is. Streams output when you pass `onStdout` or
   * `onStderr`. A non-zero exit code is not an error.
   */
  async exec(cmd: Cmd, opts: ExecOptions = {}): Promise<ExecResult> {
    checkCmd(cmd);
    const transport =
      opts.transport && opts.transport !== "auto"
        ? opts.transport
        : opts.onStdout || opts.onStderr || opts.signal || opts.stdin instanceof Uint8Array
          ? "websocket"
          : "http";
    if (transport === "http") {
      if (opts.stdin instanceof Uint8Array) {
        throw clientError("Binary stdin needs the WebSocket transport.", "invalidOptions");
      }
      const r = await this.daemon.call<DaemonExecResult>("POST", "/exec", {
        body: {
          cmd,
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          env: opts.env ?? {},
          ...(opts.stdin === undefined ? {} : { stdin: opts.stdin }),
          ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }),
        },
      });
      return {
        stdout: r.stdout,
        stderr: r.stderr,
        exitCode: r.exitCode ?? null,
        ...(r.signal === undefined || r.signal === null ? {} : { signal: r.signal }),
        truncated: r.truncated ?? false,
        timedOut: r.timedOut ?? false,
        durationMs: r.durationMs,
      };
    }
    const h = await this.start(cmd, {
      cwd: opts.cwd,
      env: opts.env,
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      timeoutMs: opts.timeoutMs ?? 60_000,
      signal: opts.signal,
      stdin: opts.stdin !== undefined,
      // The server's output cap applies, as for HTTP exec.
      limited: true,
    }, opts.stdin === undefined ? undefined : toBytes(opts.stdin));
    return h.wait();
  }

  /**
   * Starts a command and returns at once, for long-running processes,
   * streaming output and interactive stdin. Each command has its own
   * WebSocket, closed when it ends.
   */
  spawn(cmd: Cmd, opts: SpawnOptions = {}): Promise<CommandHandle> {
    checkCmd(cmd);
    return this.start(cmd, opts);
  }

  private async start(cmd: Cmd, opts: SpawnOptions & { limited?: boolean }, stdin?: Uint8Array): Promise<CommandHandle> {
    const session = await this.daemon.session();
    const h = new CommandHandle(session, opts);
    try {
      return await h.start(
        {
          op: "exec",
          cmd,
          ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
          // The server adds the sandbox's env under this one.
          env: opts.env ?? {},
          stdin: opts.stdin === true,
          // The server kills it after this long and caps its output. 0: no
          // limits, for a spawned process that runs as long as it likes.
          timeoutMs: opts.limited || opts.timeoutMs ? (opts.timeoutMs ?? 60_000) : 0,
        },
        stdin,
      );
    } catch (e) {
      session.close();
      throw e;
    }
  }

  /** Opens a terminal. */
  async pty(opts: PtyOptions = {}): Promise<Pty> {
    const session = await this.daemon.session();
    const p = new Pty(session, opts.onData);
    try {
      return await p.start({
        op: "pty",
        ...(opts.cmd === undefined ? {} : { cmd: opts.cmd }),
        ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
        env: opts.env ?? {},
        cols: opts.cols ?? 80,
        rows: opts.rows ?? 24,
      });
    } catch (e) {
      session.close();
      throw e;
    }
  }

  // ── Lifecycle, through Pyo ───────────────────────────────────────────────

  private needPyo(what: string): PyoApi {
    if (!this.pyo) throw clientError(`${what} goes through Pyo and needs an API key.`, "missingApiKey");
    return this.pyo;
  }

  /** The sandbox as Pyo shows it now. */
  async getInfo(): Promise<SandboxInfo> {
    this.info = await this.needPyo("Reading the sandbox").get(this.id);
    return this.info;
  }

  /** Stops the machine and keeps its memory and files. Connections drop. */
  async pause(): Promise<SandboxInfo> {
    this.info = await this.needPyo("Pausing").pause(this.id);
    return this.info;
  }

  /** Starts a paused sandbox again where it was. */
  async resume(): Promise<SandboxInfo> {
    this.info = await this.needPyo("Resuming").resume(this.id);
    return this.info;
  }

  /** The sandbox now ends `ttl` from now, like `"30m"`, `"1h"` or `"7d"`. `"none"`: it runs until it's deleted. */
  async extend(ttl: Ttl): Promise<SandboxInfo> {
    this.info = await this.needPyo("Extending").extend(this.id, ttl);
    return this.info;
  }

  /** Gives the sandbox another name. Its id stays the same. */
  async rename(name: string): Promise<SandboxInfo> {
    this.info = await this.needPyo("Renaming").rename(this.id, name);
    return this.info;
  }

  /** Ends the sandbox and throws away its files. */
  async delete(): Promise<SandboxInfo> {
    this.info = await this.needPyo("Deleting").delete(this.id);
    return this.info;
  }

  /** @internal */
  openPortThroughPyo(port: number, isPublic: boolean): Promise<{ url: string }> {
    return this.needPyo("Opening a port").openPort(this.id, port, isPublic);
  }
}

function checkCmd(cmd: Cmd): void {
  if (typeof cmd === "string" ? cmd.trim() === "" : !Array.isArray(cmd) || cmd.length === 0) {
    throw clientError("The command is empty.", "invalidOptions");
  }
}

/** Files in the sandbox. Each call moves at most 64 MiB. */
export class Files {
  constructor(private readonly daemon: Daemon) {}

  /** Writes a file, making it or replacing it. Parent directories must exist. */
  async write(path: string, data: string | Uint8Array | ArrayBuffer | Blob, opts: WriteFileOptions = {}): Promise<{ bytes: number }> {
    const body = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : toBytes(data);
    return this.daemon.call("PUT", "/files", {
      query: { path, mode: opts.mode === undefined ? undefined : opts.mode.toString(8) },
      body,
      raw: true,
    });
  }

  /** Reads a file as UTF-8 text. */
  async read(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readBytes(path));
  }

  /** Reads a file as bytes. */
  readBytes(path: string): Promise<Uint8Array> {
    return this.daemon.call("GET", "/files", { query: { path }, bytes: true });
  }

  /** The entries of a directory. */
  async list(path: string): Promise<FileEntry[]> {
    const r = await this.daemon.call<Extract<Response, { type: "entries" }>>("GET", "/files/list", { query: { path } });
    return r.entries;
  }

  async stat(path: string): Promise<FileEntry> {
    const r = await this.daemon.call<Extract<Response, { type: "entry" }>>("GET", "/files/stat", { query: { path } });
    return r.entry;
  }

  /** Whether a path exists. */
  async exists(path: string): Promise<boolean> {
    try {
      await this.stat(path);
      return true;
    } catch (e) {
      if (e instanceof PyoSandboxError && e.code === "notFound") return false;
      throw e;
    }
  }

  /** Makes a directory and its parents. */
  async mkdir(path: string): Promise<void> {
    await this.daemon.call("POST", "/files/mkdir", { query: { path } });
  }

  /** Removes a file, or a directory with `recursive`. */
  async remove(path: string, opts: RemoveOptions = {}): Promise<void> {
    await this.daemon.call("DELETE", "/files", { query: { path, recursive: opts.recursive ? "true" : undefined } });
  }
}

export interface PortConnectOptions {
  onData?: (data: Uint8Array) => void;
  /** The guest closed its side. */
  onEnd?: () => void;
}

/** Ports the sandbox listens on. */
export class Ports {
  constructor(
    private readonly sbx: Sandbox,
    private readonly daemon: Daemon,
  ) {}

  /**
   * Opens a port on the sandbox server's edge proxy and returns its URL,
   * like `https://3000-sbx-abc.sbx.example.com`. Public by default. A
   * private port needs a sandbox token on each request (`X-Pyo-Token`, or
   * once as `?pyo_token=` in a browser). Throws a `PyoSandboxError` with
   * code `conflict` when the server has no edge proxy, and `unsupported`
   * when this Pyo can't open ports yet.
   */
  async open(port: number, opts: OpenPortOptions = {}): Promise<string> {
    checkPort(port);
    try {
      return (await this.sbx.openPortThroughPyo(port, opts.public ?? true)).url;
    } catch (e) {
      if (isMissingRoute(e)) {
        throw new PyoSandboxError(
          "This Pyo can't open sandbox ports to the outside yet. Reach the port with sbx.ports.connect(port), or from inside the sandbox with exec.",
          { source: "pyo", code: "unsupported", status: (e as PyoSandboxError).status, cause: e },
        );
      }
      throw e;
    }
  }

  /**
   * A TCP connection to a port inside the sandbox, through the sandbox
   * server. Works without a network in the sandbox.
   */
  async connect(port: number, opts: PortConnectOptions = {}): Promise<PortConnection> {
    checkPort(port);
    const session = await this.daemon.session();
    const c = new PortConnection(session, opts.onData, opts.onEnd);
    try {
      return await c.start(port);
    } catch (e) {
      session.close();
      throw e;
    }
  }
}

function checkPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw clientError(`${port} isn't a port. Ports are 1 to 65535.`, "invalidOptions");
  }
}
