import type { Session, StreamHandler } from "./daemon.js";
import { PyoSandboxError } from "./errors.js";
import type { ExecResult } from "./types.js";
import { CHUNK, Kind, eofFrame, frame, parseJson, requestFrame, type Frame, type Request, type Response } from "./wire.js";

export const SIGKILL = 9;
export const SIGTERM = 15;
const KILL_GRACE_MS = 5_000;

export function sandboxError(r: Extract<Response, { type: "error" }>): PyoSandboxError {
  return new PyoSandboxError(r.message, { source: "sandbox", code: r.kind });
}

export function toBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

/** Sends `data` as Stdin frames of at most one chunk each. */
export function sendChunks(session: Session, stream: number, data: Uint8Array): void {
  for (let at = 0; at < data.length; at += CHUNK) {
    session.send(frame(Kind.Stdin, stream, data.subarray(at, at + CHUNK)));
  }
}

/**
 * A stream that opens with a request and ends with a final response.
 * Subclasses look at the frames in between.
 */
abstract class Stream implements StreamHandler {
  protected id = 0;
  protected ended = false;
  private startResolve!: () => void;
  private startReject!: (e: unknown) => void;
  protected readonly started = new Promise<void>((res, rej) => {
    this.startResolve = res;
    this.startReject = rej;
  });

  constructor(protected readonly session: Session) {
    // Nobody may wait on `started` when the request fails late.
    this.started.catch(() => {});
  }

  /** Sends the request on a new stream. Resolves once envd accepts it. */
  protected begin(req: Request): Promise<void> {
    this.id = this.session.stream(this);
    this.session.send(requestFrame(this.id, req));
    return this.started;
  }

  protected accept(): void {
    this.startResolve();
  }

  protected fail(e: unknown): void {
    this.startReject(e);
    this.finish(e);
  }

  /** Ends the stream with a result or an error. */
  protected abstract finish(outcome: unknown): void;

  protected close(): void {
    if (this.ended) return;
    this.ended = true;
    this.session.release(this.id);
    this.session.close();
  }

  abstract onFrame(f: Frame): void;

  onClose(err: PyoSandboxError): void {
    if (this.ended) return;
    this.fail(err);
  }
}

export interface ProcessOptions {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * A command running in the sandbox over the WebSocket. Each command has a
 * connection of its own, closed when the command ends.
 */
export class CommandHandle extends Stream {
  /** The process ID inside the sandbox. */
  pid = 0;
  private stdout = "";
  private stderr = "";
  private readonly outDec = new TextDecoder();
  private readonly errDec = new TextDecoder();
  private readonly t0 = Date.now();
  private timedOut = false;
  private timer?: ReturnType<typeof setTimeout>;
  private graceTimer?: ReturnType<typeof setTimeout>;
  private resolveDone!: (r: ExecResult) => void;
  private rejectDone!: (e: unknown) => void;
  private readonly done = new Promise<ExecResult>((res, rej) => {
    this.resolveDone = res;
    this.rejectDone = rej;
  });
  private abortListener?: () => void;

  constructor(
    session: Session,
    private readonly opts: ProcessOptions,
  ) {
    super(session);
    this.done.catch(() => {});
  }

  /** @internal */
  async start(req: Extract<Request, { op: "exec" }>, stdin?: Uint8Array): Promise<this> {
    const ok = this.begin(req);
    if (stdin) {
      // envd takes stdin right after the request, without waiting.
      sendChunks(this.session, this.id, stdin);
      this.session.send(eofFrame(this.id));
    }
    if (this.opts.timeoutMs !== undefined && this.opts.timeoutMs > 0) {
      this.timer = setTimeout(() => {
        this.timedOut = true;
        this.kill(SIGKILL);
      }, this.opts.timeoutMs);
    }
    const sig = this.opts.signal;
    if (sig) {
      this.abortListener = () => this.kill(SIGKILL);
      if (sig.aborted) this.abortListener();
      else sig.addEventListener("abort", this.abortListener, { once: true });
    }
    await ok;
    return this;
  }

  onFrame(f: Frame): void {
    if (this.ended) return;
    switch (f.kind) {
      case Kind.Stdout: {
        const s = this.outDec.decode(f.payload, { stream: true });
        this.stdout += s;
        if (s) this.opts.onStdout?.(s);
        return;
      }
      case Kind.Stderr: {
        const s = this.errDec.decode(f.payload, { stream: true });
        this.stderr += s;
        if (s) this.opts.onStderr?.(s);
        return;
      }
      case Kind.Response: {
        const r = parseJson<Response>(f);
        if (r.type === "started") {
          this.pid = r.pid;
          this.accept();
        } else if (r.type === "exit") {
          this.finish({ code: r.code ?? null, signal: r.signal });
        } else if (r.type === "error") {
          this.fail(sandboxError(r));
        }
        return;
      }
      default:
        return;
    }
  }

  protected finish(outcome: unknown): void {
    if (this.ended) return;
    clearTimeout(this.timer);
    clearTimeout(this.graceTimer);
    if (this.abortListener) this.opts.signal?.removeEventListener("abort", this.abortListener);
    this.close();
    if (outcome instanceof Error) {
      this.rejectDone(outcome);
      return;
    }
    const { code, signal } = outcome as { code: number | null; signal?: number };
    const tailOut = this.outDec.decode();
    const tailErr = this.errDec.decode();
    if (tailOut) this.opts.onStdout?.(tailOut);
    if (tailErr) this.opts.onStderr?.(tailErr);
    this.resolveDone({
      stdout: this.stdout + tailOut,
      stderr: this.stderr + tailErr,
      exitCode: code,
      ...(signal === undefined ? {} : { signal }),
      truncated: false,
      timedOut: this.timedOut,
      durationMs: Date.now() - this.t0,
    });
  }

  /** Writes to the command's stdin. Needs `stdin: true` when it started. */
  write(data: string | Uint8Array): void {
    if (this.ended) return;
    sendChunks(this.session, this.id, toBytes(data));
  }

  /** Closes the command's stdin. */
  end(): void {
    if (this.ended) return;
    this.session.send(eofFrame(this.id));
  }

  /** Sends a signal to the command's process group. SIGKILL by default. */
  kill(signal: number = SIGKILL): void {
    if (this.ended) return;
    this.session.send(requestFrame(this.id, { op: "signal", signal }));
    if (signal === SIGKILL && !this.graceTimer) {
      // Don't hang if the exit never comes.
      this.graceTimer = setTimeout(() => this.finish({ code: null, signal: SIGKILL }), KILL_GRACE_MS);
    }
  }

  /** Waits for the command to end. */
  wait(): Promise<ExecResult> {
    return this.done;
  }
}

/** A terminal in the sandbox. */
export class Pty extends Stream {
  pid = 0;
  private resolveDone!: (r: { exitCode: number | null; signal?: number }) => void;
  private rejectDone!: (e: unknown) => void;
  private readonly done = new Promise<{ exitCode: number | null; signal?: number }>((res, rej) => {
    this.resolveDone = res;
    this.rejectDone = rej;
  });

  constructor(
    session: Session,
    private readonly onData?: (data: Uint8Array) => void,
  ) {
    super(session);
    this.done.catch(() => {});
  }

  /** @internal */
  async start(req: Extract<Request, { op: "pty" }>): Promise<this> {
    await this.begin(req);
    return this;
  }

  onFrame(f: Frame): void {
    if (this.ended) return;
    if (f.kind === Kind.Stdout) {
      this.onData?.(f.payload);
      return;
    }
    if (f.kind !== Kind.Response) return;
    const r = parseJson<Response>(f);
    if (r.type === "started") {
      this.pid = r.pid;
      this.accept();
    } else if (r.type === "exit") this.finish({ exitCode: r.code ?? null, signal: r.signal });
    else if (r.type === "error") this.fail(sandboxError(r));
  }

  protected finish(outcome: unknown): void {
    if (this.ended) return;
    this.close();
    if (outcome instanceof Error) this.rejectDone(outcome);
    else {
      const o = outcome as { exitCode: number | null; signal?: number };
      this.resolveDone(o.signal === undefined ? { exitCode: o.exitCode } : o);
    }
  }

  /** Types into the terminal. */
  write(data: string | Uint8Array): void {
    if (this.ended) return;
    sendChunks(this.session, this.id, toBytes(data));
  }

  resize(cols: number, rows: number): void {
    if (this.ended) return;
    this.session.send(requestFrame(this.id, { op: "resize", cols, rows }));
  }

  kill(signal: number = SIGKILL): void {
    if (this.ended) return;
    this.session.send(requestFrame(this.id, { op: "signal", signal }));
  }

  /** Waits for the terminal's process to end. */
  wait(): Promise<{ exitCode: number | null; signal?: number }> {
    return this.done;
  }

  /** Hangs up: the shell gets SIGHUP when the connection closes. */
  disconnect(): void {
    this.finish({ exitCode: null });
  }
}

/** A TCP connection to a port inside the sandbox, through the daemon. */
export class PortConnection extends Stream {
  private remoteDone = false;
  private localDone = false;
  private resolveClosed!: () => void;
  private rejectClosed!: (e: unknown) => void;
  /** Resolves when both directions are closed. */
  readonly closed = new Promise<void>((res, rej) => {
    this.resolveClosed = res;
    this.rejectClosed = rej;
  });

  constructor(
    session: Session,
    private readonly onData?: (data: Uint8Array) => void,
    private readonly onEnd?: () => void,
  ) {
    super(session);
    this.closed.catch(() => {});
  }

  /** @internal */
  async start(port: number): Promise<this> {
    await this.begin({ op: "portConnect", port });
    return this;
  }

  onFrame(f: Frame): void {
    if (this.ended) return;
    if (f.kind === Kind.Stdout) this.onData?.(f.payload);
    else if (f.kind === Kind.Eof) {
      this.remoteDone = true;
      this.onEnd?.();
      if (this.localDone) this.finish(null);
    } else if (f.kind === Kind.Response) {
      const r = parseJson<Response>(f);
      if (r.type === "ok") this.accept();
      else if (r.type === "error") this.fail(sandboxError(r));
    }
  }

  protected finish(outcome: unknown): void {
    if (this.ended) return;
    this.close();
    if (outcome instanceof Error) this.rejectClosed(outcome);
    else this.resolveClosed();
  }

  write(data: string | Uint8Array): void {
    if (this.ended || this.localDone) return;
    sendChunks(this.session, this.id, toBytes(data));
  }

  /** Closes the sending direction. The guest sees EOF. */
  end(): void {
    if (this.ended || this.localDone) return;
    this.localDone = true;
    this.session.send(eofFrame(this.id));
    if (this.remoteDone) this.finish(null);
  }

  /** Drops the connection in both directions. */
  destroy(): void {
    this.finish(null);
  }
}
