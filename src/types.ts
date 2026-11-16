import type { Cmd, FileEntry } from "./wire.js";

export type { Cmd, FileEntry, FileKind } from "./wire.js";

export type SandboxState =
  | "creating"
  | "running"
  | "pausing"
  | "paused"
  | "resuming"
  | "stopping"
  | "stopped"
  | "failed";

export type Runtime = "firecracker" | "gvisor";
export type NetworkMode = "internet" | "none";
/** `auto` runs on Firecracker where it can and on gVisor elsewhere. `vm` needs Firecracker. */
export type Isolation = "auto" | "vm";

/**
 * A lifetime like `"30m"`, `"1h"`, `"7d"` or `"1h30m"`, or a number of
 * seconds, up to 365 days and the team's longest. `"none"`: the sandbox runs
 * until it's deleted, when the team has no limit.
 */
export type Ttl = "none" | (string & {}) | number;

/** Where a client reaches its sandbox, and with what. Pyo signs a new one on request. */
export interface Connection {
  /** The sandbox server's daemon, on your tailnet. */
  url: string;
  sandboxId: string;
  /** `Authorization: Bearer <token>` for exec, terminals, files and ports. */
  token: string;
  /** When the token runs out, in epoch milliseconds. */
  expiresAt: number;
}

/** A sandbox as Pyo shows it. */
export interface SandboxInfo {
  id: string;
  /** For people to tell it apart. Not unique: the id addresses it. */
  name: string;
  teamId: string;
  projectId: string | null;
  serverId: string | null;
  server: string | null;
  template: string;
  templateId: string | null;
  state: SandboxState;
  runtime: Runtime | null;
  cpus: number;
  memoryMib: number;
  diskMib: number;
  network: NetworkMode;
  isolation: Isolation;
  labels: Record<string, string>;
  pauseWhenIdleSecs: number | null;
  /** Names only. Pyo never keeps the values. */
  env: string[];
  /** The daemon URL of its server. */
  url: string | null;
  /** Its server's edge proxy, where open ports are served. Null without one. */
  edgeUrl?: string | null;
  /** Ports open on the edge proxy, with their URLs. */
  ports?: OpenPort[];
  /**
   * `getInfo()` and `connect()`: a fresh connection when the API key may use
   * the sandbox and it lives, else null with `connectionNote` saying why.
   */
  connection?: Connection | null;
  connectionNote?: string;
  error: string | null;
  createdBy: string | null;
  createdAt: number;
  startedAt: number | null;
  /** When its lifetime ends. Null: it runs until it's deleted. */
  expiresAt: number | null;
  pausedAt: number | null;
  endedAt: number | null;
}

/** A sandbox port on its server's edge proxy. */
export interface OpenPort {
  port: number;
  /** A public port answers anyone. A private one needs a sandbox token. */
  public: boolean;
  url: string | null;
}

export interface OpenPortOptions {
  /** `true` by default. A private port needs a sandbox token on each request. */
  public?: boolean;
}

export interface ClientOptions {
  /** A Pyo API key with sandboxes (or full) access. Defaults to `PYO_API_KEY`, then `PYO_TOKEN`. */
  apiKey?: string;
  /** Your Pyo, like `https://pyo.example.com`. Defaults to `PYO_URL`. */
  baseUrl?: string;
  /** A fetch to use instead of the global one. */
  fetch?: typeof fetch;
  /**
   * A WebSocket class to use instead of the global one. Node 20 has no
   * global WebSocket, so pass `ws` there for streaming exec, terminals and
   * port connections.
   */
  WebSocket?: WebSocketLike;
  /**
   * Ask Pyo for a new sandbox token this long before the old one runs out.
   * 5 minutes by default. Tokens last an hour.
   */
  tokenRefreshMarginMs?: number;
}

export interface CreateOptions extends ClientOptions {
  /**
   * The team's id. Defaults to `PYO_TEAM`, else Pyo takes the API key's
   * only team.
   */
  teamId?: string;
  /**
   * A name to tell it apart, like `"checkout tests"`: up to 63 letters,
   * digits, spaces, dashes, underscores and dots. It needn't be unique. Pyo
   * makes up a short one like `quiet-river` by default.
   */
  name?: string;
  /**
   * A sandbox template's name or id, like `node-22`. `base` by default:
   * Pyo's built-in Ubuntu 24.04 with git, Python, uv, Node.js, pnpm and
   * more. A server makes `base` the first time it's used there, so that
   * first create takes longer.
   */
  template?: string;
  /**
   * A sandbox server's name or id to run it on: the team's own or the
   * installation's. Pyo picks one by default.
   */
  server?: string;
  /** 1 by default. */
  cpus?: number;
  /** 512 by default. */
  memoryMib?: number;
  /** The writable disk. It is sparse. 2048 by default. */
  diskMib?: number;
  /** How long it lives, like `"30m"`, `"1h"` or `"7d"`, or `"none"` to run until it's deleted. 5 minutes by default. */
  ttl?: Ttl;
  /** Pause after this many seconds without use. Pyo keeps it, and acts on it in a later release. */
  pauseWhenIdleSecs?: number;
  /** Environment variables for every command. Pyo passes them on and keeps only the names. */
  env?: Record<string, string>;
  /** `internet` by default. */
  network?: NetworkMode;
  /** `auto` by default. */
  isolation?: Isolation;
  labels?: Record<string, string>;
  /** A project of the team, kept as a label. */
  projectId?: string;
}

export interface ConnectOptions extends ClientOptions {
  /**
   * @deprecated The sandbox server now adds the sandbox's env to every
   * command and terminal. Kept so older code still compiles. It does nothing.
   */
  env?: Record<string, string>;
}

/** A sandbox server your team's sandboxes can run on. */
export interface SandboxServerInfo {
  id: string;
  /** Null for the installation's, which every team may use. */
  teamId: string | null;
  name: string;
  /** Its tailnet address, once it joined. */
  address: string | null;
  state: "joining" | "ready" | "unreachable" | "refused";
  enabled: boolean;
  /** What runs its sandboxes: Firecracker where it has KVM, gVisor elsewhere. Null until it reports. */
  runtime: Runtime | null;
  /** One line about what it runs, like "gVisor, because this server has no usable KVM." */
  summary: string | null;
  /** How many sandboxes run on it. */
  sandboxes: number;
  /** The server Pyo made for it at a cloud provider, while it's there. */
  cloud: SandboxServerCloud | null;
  error: string | null;
  createdAt: number;
}

export interface SandboxServerCloud {
  id: string;
  provider: "hetzner";
  location: string;
  serverType: string;
  /** A month, before VAT. */
  monthly: number;
  currency: string;
  state: "creating" | "booting" | "joining" | "ready" | "failed" | "removing";
  error: string | null;
}

export interface ListServersOptions extends ClientOptions {
  /** The team's id. Defaults to `PYO_TEAM`. */
  teamId?: string;
}

export interface ListOptions extends ClientOptions {
  /** The team's id. Defaults to `PYO_TEAM`. */
  teamId?: string;
  /** `live` (the default: not stopped or failed) or `all` (the latest 500). */
  state?: "live" | "all";
}

export interface ExecOptions {
  cwd?: string;
  /** Added to the sandbox's own env. */
  env?: Record<string, string>;
  /** Kill the command after this many milliseconds. 60 seconds by default. */
  timeoutMs?: number;
  /** Sent to the command's stdin, then stdin is closed. */
  stdin?: string | Uint8Array;
  /** Called with each piece of stdout as it arrives. */
  onStdout?: (data: string) => void;
  /** Called with each piece of stderr as it arrives. */
  onStderr?: (data: string) => void;
  /** Kills the command when it aborts. */
  signal?: AbortSignal;
  /**
   * `auto` (the default) waits over plain HTTP and streams over the
   * WebSocket when you pass `onStdout`, `onStderr` or `signal`.
   */
  transport?: "auto" | "http" | "websocket";
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** `null` when a signal ended the command. */
  exitCode: number | null;
  /** The signal that ended it, if one did. */
  signal?: number;
  /** Output past the server's cap (8 MiB per stream) was dropped. */
  truncated: boolean;
  /** The command ran past its timeout and was killed. */
  timedOut: boolean;
  durationMs: number;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  /** Keep stdin open for `write()` and `end()`. Off by default, so stdin is /dev/null. */
  stdin?: boolean;
  /** Kill the command after this many milliseconds. No limit by default. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PtyOptions {
  /** The user's login shell by default. */
  cmd?: Cmd;
  cwd?: string;
  env?: Record<string, string>;
  /** 80 by default. */
  cols?: number;
  /** 24 by default. */
  rows?: number;
  /** Terminal output, as raw bytes. */
  onData?: (data: Uint8Array) => void;
}

export interface WriteFileOptions {
  /** Permission bits, like `0o755`. */
  mode?: number;
}

export interface RemoveOptions {
  recursive?: boolean;
}

export interface ListFilesResult {
  entries: FileEntry[];
}

/** The subset of the WHATWG WebSocket the SDK needs. */
export interface WebSocketLike {
  new (url: string, protocols?: string | string[]): WebSocketInstance;
}

export interface WebSocketInstance {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}
