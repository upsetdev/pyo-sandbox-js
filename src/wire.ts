/**
 * The envd wire protocol, as the sandbox daemon speaks it over its
 * WebSocket. Every binary WebSocket message is exactly one frame:
 *
 * ```text
 * [len u32 BE][kind u8][stream u32 BE][payload: len - 5 bytes]
 * ```
 *
 * `len` counts everything after itself, so a frame is `4 + len` bytes.
 * `Hello`, `Request` and `Response` carry JSON. `Stdin`, `Stdout` and
 * `Stderr` carry raw bytes. `Eof` has no payload.
 *
 * Mirrors `pyo_proto::sandbox::wire` in the Pyo repo.
 */

/** The newest protocol version this SDK speaks. */
export const WIRE_PROTOCOL = 1;
/** The oldest protocol version this SDK speaks. */
export const MIN_WIRE_PROTOCOL = 1;
/** The largest payload of one frame. */
export const MAX_PAYLOAD = 1 << 20;
/** What a sender puts in one data frame. */
export const CHUNK = 64 * 1024;
/** `len` plus `kind` plus `stream`. */
export const HEADER_LEN = 9;

export const Kind = {
  Hello: 1,
  Request: 2,
  Response: 3,
  Stdin: 4,
  Stdout: 5,
  Stderr: 6,
  Eof: 7,
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

const KINDS = new Set<number>(Object.values(Kind));

export interface Frame {
  kind: Kind;
  stream: number;
  payload: Uint8Array;
}

export class WireError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WireError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function frame(kind: Kind, stream: number, payload: Uint8Array = new Uint8Array(0)): Frame {
  return { kind, stream, payload };
}

export function jsonFrame(kind: Kind, stream: number, value: unknown): Frame {
  return frame(kind, stream, encoder.encode(JSON.stringify(value)));
}

export function requestFrame(stream: number, req: Request): Frame {
  return jsonFrame(Kind.Request, stream, req);
}

export function eofFrame(stream: number): Frame {
  return frame(Kind.Eof, stream);
}

export function parseJson<T>(f: Frame): T {
  try {
    return JSON.parse(decoder.decode(f.payload)) as T;
  } catch (e) {
    throw new WireError(`bad frame JSON: ${(e as Error).message}`);
  }
}

export function encodeFrame(f: Frame): Uint8Array {
  if (f.payload.length > MAX_PAYLOAD) {
    throw new WireError(`frame payload of ${f.payload.length} bytes is over the limit`);
  }
  if (!Number.isInteger(f.stream) || f.stream < 0 || f.stream > 0xffffffff) {
    throw new WireError(`stream ${f.stream} isn't a u32`);
  }
  const out = new Uint8Array(HEADER_LEN + f.payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, f.payload.length + 5, false);
  view.setUint8(4, f.kind);
  view.setUint32(5, f.stream, false);
  out.set(f.payload, HEADER_LEN);
  return out;
}

function parseHeader(buf: Uint8Array, at: number): { len: number; kind: Kind; stream: number } {
  const view = new DataView(buf.buffer, buf.byteOffset + at, HEADER_LEN);
  const len = view.getUint32(0, false);
  if (len < 5) throw new WireError("the frame is cut short");
  const payload = len - 5;
  if (payload > MAX_PAYLOAD) throw new WireError(`frame payload of ${payload} bytes is over the limit`);
  const kind = view.getUint8(4);
  if (!KINDS.has(kind)) throw new WireError(`unknown frame kind ${kind}`);
  return { len: payload, kind: kind as Kind, stream: view.getUint32(5, false) };
}

/** Exactly one frame, like one WebSocket message. */
export function decodeFrame(bytes: Uint8Array): Frame {
  if (bytes.length < HEADER_LEN) throw new WireError("the frame is cut short");
  const { len, kind, stream } = parseHeader(bytes, 0);
  if (bytes.length < HEADER_LEN + len) throw new WireError("the frame is cut short");
  if (bytes.length > HEADER_LEN + len) throw new WireError("bytes after the frame");
  return { kind, stream, payload: bytes.slice(HEADER_LEN, HEADER_LEN + len) };
}

/** Turns a byte stream into frames. */
export class Decoder {
  private buf = new Uint8Array(0);

  push(bytes: Uint8Array): void {
    if (this.buf.length === 0) {
      this.buf = bytes.slice();
      return;
    }
    const next = new Uint8Array(this.buf.length + bytes.length);
    next.set(this.buf, 0);
    next.set(bytes, this.buf.length);
    this.buf = next;
  }

  isEmpty(): boolean {
    return this.buf.length === 0;
  }

  /** The next whole frame, or `null` until more bytes arrive. */
  next(): Frame | null {
    if (this.buf.length < HEADER_LEN) return null;
    const { len, kind, stream } = parseHeader(this.buf, 0);
    if (this.buf.length < HEADER_LEN + len) return null;
    const payload = this.buf.slice(HEADER_LEN, HEADER_LEN + len);
    this.buf = this.buf.slice(HEADER_LEN + len);
    return { kind, stream, payload };
  }
}

// ── Messages ───────────────────────────────────────────────────────────────

/** envd's first frame on every connection, on stream 0. */
export interface Hello {
  protocol: number;
  minProtocol: number;
  envdVersion: string;
}

/** The version both sides speak: the newest one in both ranges. Throws when there is none. */
export function negotiate(theirs: Hello): number {
  const v = Math.min(theirs.protocol, WIRE_PROTOCOL);
  if (v < theirs.minProtocol || v < MIN_WIRE_PROTOCOL) {
    throw new WireError(
      `envd ${theirs.envdVersion} speaks protocol ${theirs.minProtocol} to ${theirs.protocol}, ` +
        `and this SDK speaks ${MIN_WIRE_PROTOCOL} to ${WIRE_PROTOCOL}`,
    );
  }
  return v;
}

/** A shell string run with `/bin/sh -c`, or an argv run as is. */
export type Cmd = string | string[];

export type Request =
  | { op: "ping" }
  | { op: "exec"; cmd: Cmd; cwd?: string; env: Record<string, string>; stdin: boolean }
  | { op: "pty"; cmd?: Cmd; cwd?: string; env: Record<string, string>; cols: number; rows: number }
  | { op: "resize"; cols: number; rows: number }
  | { op: "signal"; signal: number }
  | { op: "writeFile"; path: string; mode?: number; append: boolean }
  | { op: "readFile"; path: string }
  | { op: "list"; path: string }
  | { op: "stat"; path: string }
  | { op: "mkdir"; path: string }
  | { op: "remove"; path: string; recursive: boolean }
  | { op: "portConnect"; port: number };

export type FileKind = "file" | "dir" | "symlink" | "other";

export interface FileEntry {
  name: string;
  path: string;
  kind: FileKind;
  size: number;
  /** Permission bits, like 0o644. */
  mode: number;
  /** Epoch milliseconds. */
  modified: number;
  /** Where a symlink points. */
  target?: string;
}

export type EnvdErrorKind =
  | "notFound"
  | "permissionDenied"
  | "alreadyExists"
  | "invalidInput"
  | "busy"
  | "unsupported"
  | "io";

export type Response =
  | { type: "pong" }
  | { type: "ok" }
  | { type: "started"; pid: number }
  | { type: "exit"; code?: number; signal?: number }
  | { type: "written"; bytes: number }
  | { type: "entry"; entry: FileEntry }
  | { type: "entries"; entries: FileEntry[] }
  | { type: "error"; kind: EnvdErrorKind; message: string };
