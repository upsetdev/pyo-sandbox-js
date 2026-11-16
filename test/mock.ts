/**
 * A mock Pyo and a mock sandbox daemon for the tests. The daemon speaks
 * the real envd frame format over its WebSocket and runs commands as real
 * processes on this machine, rooted in a temp directory for files.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect as tcpConnect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  Kind,
  decodeFrame,
  encodeFrame,
  eofFrame,
  frame,
  jsonFrame,
  parseJson,
  type Frame,
  type Hello,
  type Request,
  type Response,
} from "../src/wire.js";

type Scope = "exec" | "pty" | "files" | "ports" | "lifecycle";

interface TokenInfo {
  sandboxId: string;
  exp: number;
  scopes: Scope[];
}

interface MockSandbox {
  id: string;
  teamId: string;
  template: string;
  env: Record<string, string>;
  state: string;
  expiresAt: number;
  spec: Record<string, unknown>;
  ports: Array<{ port: number; public: boolean }>;
}

/** The daemon's output cap for an exec, per output. */
const EXEC_OUTPUT_CAP = 8 << 20;

export interface DaemonEvent {
  kind: "http" | "ws" | "request";
  detail: string;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

// ── The daemon ─────────────────────────────────────────────────────────────

export class MockDaemon {
  readonly tokens = new Map<string, TokenInfo>();
  readonly sandboxes = new Map<string, MockSandbox>();
  readonly events: DaemonEvent[] = [];
  readonly root = mkdtempSync(join(tmpdir(), "pyo-sbx-mock-"));
  hello: Hello = { protocol: 1, minProtocol: 1, envdVersion: "mock-0.0.0" };
  /** Resize requests seen, per pty. */
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  /** The output cap of a WebSocket exec, like the daemon's 8 MiB. */
  outputCap = EXEC_OUTPUT_CAP;
  /** The subprotocol the last WebSocket got, and whether its URL had a token. */
  lastProtocol = "";
  lastUrlHadToken = false;
  url = "";
  private server = createServer((req, res) => {
    this.http(req, res).catch((e: Error) => json(res, 500, { type: "error", error: { code: "internal", message: e.message } }));
  });
  // Like the daemon: "pyo" when offered, else the token's own.
  private wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has("pyo") ? "pyo" : ([...protocols][0] ?? false)),
  });
  private sockets = new Set<WebSocket>();

  async start(): Promise<void> {
    this.server.on("upgrade", (req, socket, head) => this.upgrade(req, socket as Socket, head));
    const port = await listen(this.server);
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.terminate();
    this.wss.close();
    await new Promise((r) => this.server.close(r));
    rmSync(this.root, { recursive: true, force: true });
  }

  /** A path inside the sandbox, on this machine. */
  local(path: string): string {
    return join(this.root, normalize(`/${path}`));
  }

  private auth(req: IncomingMessage, url: URL, id: string, scope: Scope | null): TokenInfo | { status: number; error: string; code: string } {
    const h = req.headers.authorization;
    const proto = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",")
      .map((p) => p.trim())
      .find((p) => p.startsWith("pyo.token."));
    const token = proto ? proto.slice("pyo.token.".length) : h?.startsWith("Bearer ") ? h.slice(7) : url.searchParams.get("token");
    if (!token) return { status: 401, code: "unauthorized", error: "A sandbox token is needed." };
    const t = this.tokens.get(token);
    if (!t) return { status: 401, code: "unauthorized", error: "The sandbox token isn't valid." };
    if (Date.now() > t.exp) return { status: 401, code: "unauthorized", error: "The sandbox token has expired." };
    if (t.sandboxId !== id) return { status: 403, code: "forbidden", error: "The sandbox token is for another sandbox." };
    if (scope && !t.scopes.includes(scope)) return { status: 403, code: "forbidden", error: `The sandbox token doesn't allow ${scope}.` };
    return t;
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const m = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)(\/.*)?$/);
    if (!m) return json(res, 404, { type: "error", error: { code: "notFound", message: "No such route." } });
    const id = decodeURIComponent(m[1]!);
    const sub = m[2] ?? "";
    this.events.push({ kind: "http", detail: `${req.method} ${sub || "/"}` });
    const scope: Scope | null = sub === "/exec" ? "exec" : sub.startsWith("/files") ? "files" : null;
    const a = this.auth(req, url, id, scope);
    if ("status" in a) return json(res, a.status, { type: "error", error: { code: a.code, message: a.error } });
    const sbx = this.sandboxes.get(id);
    if (!sbx) return json(res, 404, { type: "error", error: { code: "notFound", message: "No such sandbox." } });
    const path = url.searchParams.get("path") ?? "";
    const fileFail = (e: NodeJS.ErrnoException) => {
      const code = e.code === "ENOENT" ? "notFound" : e.code === "EEXIST" ? "conflict" : "runtime";
      json(res, code === "notFound" ? 404 : code === "conflict" ? 409 : 502, { type: "error", error: { code, message: e.message } });
    };
    switch (`${req.method} ${sub}`) {
      case "GET ":
        return json(res, 200, { type: "sandbox", sandbox: { id, state: sbx.state } });
      case "POST /exec": {
        const body = JSON.parse((await readBody(req)).toString()) as {
          cmd: string | string[];
          cwd?: string;
          env?: Record<string, string>;
          stdin?: string;
          timeoutMs?: number;
        };
        const t0 = Date.now();
        const r = await runBuffered(body.cmd, { ...sbx.env, ...body.env }, body.cwd ? this.local(body.cwd) : this.root, body.stdin, body.timeoutMs ?? 60_000);
        return json(res, 200, { ...r, truncated: false, durationMs: Date.now() - t0 });
      }
      case "GET /files":
        try {
          const data = await fs.readFile(this.local(path));
          res.writeHead(200, { "content-type": "application/octet-stream" });
          return void res.end(data);
        } catch (e) {
          return fileFail(e as NodeJS.ErrnoException);
        }
      case "PUT /files":
        try {
          const data = await readBody(req);
          const mode = url.searchParams.get("mode");
          await fs.writeFile(this.local(path), data, mode ? { mode: parseInt(mode, 8) } : {});
          return json(res, 200, { bytes: data.length });
        } catch (e) {
          return fileFail(e as NodeJS.ErrnoException);
        }
      case "DELETE /files":
        try {
          await fs.rm(this.local(path), { recursive: url.searchParams.get("recursive") === "true" });
          return json(res, 200, { type: "ok" });
        } catch (e) {
          return fileFail(e as NodeJS.ErrnoException);
        }
      case "GET /files/list":
        try {
          const names = await fs.readdir(this.local(path));
          const entries = await Promise.all(names.sort().map((n) => this.entry(`${path.replace(/\/$/, "")}/${n}`)));
          return json(res, 200, { type: "entries", entries });
        } catch (e) {
          return fileFail(e as NodeJS.ErrnoException);
        }
      case "GET /files/stat":
        try {
          return json(res, 200, { type: "entry", entry: await this.entry(path) });
        } catch (e) {
          return fileFail(e as NodeJS.ErrnoException);
        }
      case "POST /files/mkdir":
        await fs.mkdir(this.local(path), { recursive: true });
        return json(res, 200, { type: "ok" });
      default:
        return json(res, 404, { type: "error", error: { code: "notFound", message: "No such route." } });
    }
  }

  private async entry(path: string) {
    const st = await fs.lstat(this.local(path));
    return {
      name: path.split("/").pop() ?? "",
      path,
      kind: st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : st.isFile() ? "file" : "other",
      size: st.size,
      mode: st.mode & 0o7777,
      modified: Math.floor(st.mtimeMs),
    };
  }

  private upgrade(req: IncomingMessage, socket: Socket, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://x");
    const m = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/connect$/);
    const id = m ? decodeURIComponent(m[1]!) : "";
    const a = m ? this.auth(req, url, id, null) : { status: 404, error: "no", code: "notFound" };
    this.lastUrlHadToken = url.searchParams.has("token");
    // Like the daemon: a refused connection is upgraded and closed at once
    // with 4000 + the HTTP status and the reason.
    if ("status" in a) {
      this.wss.handleUpgrade(req, socket, head, (ws) => ws.close(4000 + a.status, a.error));
      return;
    }
    this.events.push({ kind: "ws", detail: id });
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.lastProtocol = ws.protocol;
      this.session(ws, a, this.sandboxes.get(id)!);
    });
  }

  private session(ws: WebSocket, token: TokenInfo, sbx: MockSandbox): void {
    this.sockets.add(ws);
    const send = (f: Frame) => {
      if (ws.readyState === ws.OPEN) ws.send(encodeFrame(f));
    };
    const respond = (stream: number, r: Response) => send(jsonFrame(Kind.Response, stream, r));
    const procs = new Map<number, { child?: ChildProcess; pty?: { input(d: Buffer): void }; sock?: Socket }>();
    send(jsonFrame(Kind.Hello, 0, this.hello));
    ws.on("close", () => {
      this.sockets.delete(ws);
      for (const p of procs.values()) {
        p.child?.kill("SIGHUP");
        p.sock?.destroy();
      }
    });
    ws.on("message", (data: Buffer) => {
      const f = decodeFrame(new Uint8Array(data));
      if (f.kind === Kind.Request) {
        const req = parseJson<Request>(f);
        this.events.push({ kind: "request", detail: req.op });
        // Like the daemon: every request is checked against the token, but a
        // resize or signal on an open stream passes after it runs out.
        const onOpen = (req.op === "resize" || req.op === "signal") && procs.has(f.stream);
        if (!onOpen && Date.now() > token.exp) {
          return respond(f.stream, { type: "error", kind: "unauthorized", message: "The sandbox token has expired." });
        }
        const need: Partial<Record<Request["op"], Scope>> = { exec: "exec", pty: "pty", portConnect: "ports" };
        const scope = need[req.op];
        if (scope && !token.scopes.includes(scope)) {
          return respond(f.stream, { type: "error", kind: "forbidden", message: `The sandbox token doesn't allow ${scope}.` });
        }
        this.request(f.stream, req, sbx, procs, send, respond);
      } else if (f.kind === Kind.Stdin) {
        const p = procs.get(f.stream);
        p?.child?.stdin?.write(Buffer.from(f.payload));
        p?.pty?.input(Buffer.from(f.payload));
        p?.sock?.write(Buffer.from(f.payload));
      } else if (f.kind === Kind.Eof) {
        const p = procs.get(f.stream);
        p?.child?.stdin?.end();
        p?.sock?.end();
      }
    });
  }

  private request(
    id: number,
    req: Request,
    sbx: MockSandbox,
    procs: Map<number, { child?: ChildProcess; pty?: { input(d: Buffer): void }; sock?: Socket }>,
    send: (f: Frame) => void,
    respond: (stream: number, r: Response) => void,
  ): void {
    if (req.op === "ping") return respond(id, { type: "pong" });
    if (req.op === "signal") {
      const child = procs.get(id)?.child;
      if (child?.pid) {
        try {
          process.kill(-child.pid, req.signal);
        } catch {
          // Gone already.
        }
      }
      return;
    }
    if (req.op === "resize") {
      this.resizes.push({ cols: req.cols, rows: req.rows });
      return;
    }
    if (procs.has(id)) return respond(id, { type: "error", kind: "busy", message: `stream ${id} is in use` });
    if (req.op === "exec") {
      const argv = typeof req.cmd === "string" ? ["/bin/sh", "-c", req.cmd] : req.cmd;
      const child = spawn(argv[0]!, argv.slice(1), {
        cwd: req.cwd ? this.local(req.cwd) : this.root,
        // The daemon adds the sandbox's env under the request's.
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...sbx.env, ...req.env },
        stdio: [req.stdin ? "pipe" : "ignore", "pipe", "pipe"],
        detached: true,
      });
      procs.set(id, { child });
      // Like the daemon: a timeout (60 s when left out, none for 0) and an
      // output cap per output, then the exit says which applied.
      const limit = req.timeoutMs ?? 60_000;
      let timedOut = false;
      let truncated = false;
      const used = { out: 0, err: 0 };
      const timer =
        limit > 0
          ? setTimeout(() => {
              timedOut = true;
              if (child.pid) process.kill(-child.pid, "SIGKILL");
            }, limit)
          : undefined;
      const capped = (which: "out" | "err", d: Buffer): Uint8Array | null => {
        if (limit === 0) return new Uint8Array(d);
        const room = Math.max(0, this.outputCap - used[which]);
        if (d.length > room) truncated = true;
        const keep = d.subarray(0, room);
        used[which] += keep.length;
        return keep.length ? new Uint8Array(keep) : null;
      };
      child.on("spawn", () => respond(id, { type: "started", pid: child.pid ?? 0 }));
      child.on("error", (e) => {
        clearTimeout(timer);
        procs.delete(id);
        respond(id, { type: "error", kind: "notFound", message: e.message });
      });
      child.stdout?.on("data", (d: Buffer) => {
        const b = capped("out", d);
        if (b) send(frame(Kind.Stdout, id, b));
      });
      child.stderr?.on("data", (d: Buffer) => {
        const b = capped("err", d);
        if (b) send(frame(Kind.Stderr, id, b));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        procs.delete(id);
        const exit: Response = signal ? { type: "exit", signal: signalNumber(signal) } : { type: "exit", code: code ?? 0 };
        respond(id, timedOut || truncated ? { ...exit, timedOut, truncated } : exit);
      });
      return;
    }
    if (req.op === "pty") {
      // A fake terminal: echoes what's typed, and "exit" ends it.
      let line = "";
      procs.set(id, {
        pty: {
          input: (d) => {
            send(frame(Kind.Stdout, id, new Uint8Array(d)));
            line += d.toString();
            if (line.includes("exit\r") || line.includes("exit\n")) {
              procs.delete(id);
              respond(id, { type: "exit", code: 0 });
            }
          },
        },
      });
      respond(id, { type: "started", pid: 4242 });
      const env = { ...sbx.env, ...req.env };
      send(frame(Kind.Stdout, id, new TextEncoder().encode(`$ env FOO=${env.FOO ?? ""} ${req.cols}x${req.rows}\r\n`)));
      return;
    }
    if (req.op === "portConnect") {
      const sock = tcpConnect(req.port, "127.0.0.1");
      sock.once("connect", () => {
        procs.set(id, { sock });
        respond(id, { type: "ok" });
      });
      sock.once("error", (e) => {
        if (!procs.has(id)) respond(id, { type: "error", kind: "io", message: `nothing answers on port ${req.port} in the sandbox: ${e.message}` });
      });
      sock.on("data", (d: Buffer) => send(frame(Kind.Stdout, id, new Uint8Array(d))));
      sock.on("end", () => send(eofFrame(id)));
      sock.on("close", () => procs.delete(id));
      return;
    }
    respond(id, { type: "error", kind: "unsupported", message: `The mock doesn't do ${req.op}.` });
  }
}

function signalNumber(s: NodeJS.Signals): number {
  const table: Partial<Record<NodeJS.Signals, number>> = { SIGHUP: 1, SIGINT: 2, SIGKILL: 9, SIGTERM: 15 };
  return table[s] ?? 0;
}

function runBuffered(
  cmd: string | string[],
  env: Record<string, string>,
  cwd: string,
  stdin: string | undefined,
  timeoutMs: number,
): Promise<{ exitCode: number | null; signal?: number; stdout: string; stderr: string; timedOut: boolean }> {
  const argv = typeof cmd === "string" ? ["/bin/sh", "-c", cmd] : cmd;
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
      stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (err += d.toString()));
    if (stdin !== undefined) child.stdin?.end(stdin);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve(
        signal
          ? { exitCode: null, signal: signalNumber(signal), stdout: out, stderr: err, timedOut }
          : { exitCode: code, stdout: out, stderr: err, timedOut },
      );
    });
  });
}

// ── Pyo ────────────────────────────────────────────────────────────────────

export const API_KEY = "pyo_test_key";
export const TEAM = "tm_test";

export class MockPyo {
  url = "";
  /** How long the tokens Pyo signs last. An hour, like Pyo. */
  tokenTtlMs = 3_600_000;
  /** Whether Pyo has the ports route yet. */
  portsRoute = false;
  /** How many teams the API key can use. */
  teams = 1;
  readonly calls: Array<{ method: string; path: string; body: unknown }> = [];
  private n = 0;
  private server = createServer((req, res) => {
    this.http(req, res).catch((e: Error) => json(res, 500, { error: e.message }));
  });

  constructor(readonly daemon: MockDaemon) {}

  async start(): Promise<void> {
    this.url = `http://127.0.0.1:${await listen(this.server)}`;
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.server.close(r));
  }

  count(method: string, path: RegExp): number {
    return this.calls.filter((c) => c.method === method && path.test(c.path)).length;
  }

  connection(id: string) {
    const token = `pyosbx1.mock${++this.n}.sig`;
    const expiresAt = Date.now() + this.tokenTtlMs;
    this.daemon.tokens.set(token, { sandboxId: id, exp: expiresAt, scopes: ["exec", "pty", "files", "ports"] });
    return { url: this.daemon.url, sandboxId: id, token, expiresAt };
  }

  view(s: MockSandbox) {
    return {
      id: s.id,
      teamId: s.teamId,
      projectId: (s.spec.projectId as string) ?? null,
      serverId: "sbs_mock",
      server: "mock",
      template: s.template,
      templateId: "stp_mock",
      state: s.state,
      runtime: "firecracker",
      cpus: (s.spec.cpus as number) ?? 1,
      memoryMib: (s.spec.memoryMib as number) ?? 512,
      diskMib: (s.spec.diskMib as number) ?? 2048,
      network: (s.spec.network as string) ?? "internet",
      isolation: (s.spec.isolation as string) ?? "auto",
      labels: (s.spec.labels as Record<string, string>) ?? {},
      pauseWhenIdleSecs: null,
      env: Object.keys(s.env).sort(),
      url: this.daemon.url,
      edgeUrl: this.portsRoute ? "https://sandbox.example.com" : null,
      ports: s.ports.map((p) => ({ ...p, url: `https://${p.port}-${s.id.replace("_", "-")}.sandbox.example.com` })),
      error: null,
      createdBy: "Test",
      createdAt: Date.now(),
      startedAt: Date.now(),
      expiresAt: s.expiresAt,
      pausedAt: null,
      endedAt: null,
    };
  }

  private async http(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    const raw = (await readBody(req)).toString();
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    const path = url.pathname.replace(/^\/api\/v1/, "");
    this.calls.push({ method: req.method ?? "", path: path + url.search, body });
    if (!url.pathname.startsWith("/api/v1/")) return json(res, 404, { error: "Not found" });
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      return json(res, 401, { error: "Send a Pyo API key: Authorization: Bearer pyo_…" });
    }
    const m = path.match(/^\/sandboxes\/([^/]+)(\/[a-z]+)?$/);
    const sbx = m ? this.daemon.sandboxes.get(decodeURIComponent(m[1]!)) : undefined;
    const key = `${req.method} ${m ? `/sandboxes/{id}${m[2] ?? ""}` : path}`;
    const needSbx = () => {
      if (!sbx) json(res, 404, { error: "Sandbox not found." });
      return sbx;
    };
    switch (key) {
      case "POST /sandboxes": {
        const allowed = new Set(["teamId", "template", "server", "cpus", "memoryMib", "diskMib", "ttl", "pauseWhenIdleSecs", "env", "network", "isolation", "labels", "projectId"]);
        const unknown = Object.keys(body ?? {}).find((k) => !allowed.has(k));
        if (unknown) return json(res, 422, { error: `unknown field \`${unknown}\`` });
        // Like Pyo: the key's only team when teamId is left out.
        if (body?.teamId === undefined && this.teams > 1) {
          return json(res, 400, { error: `Pass teamId: the team the sandbox belongs to. You can use ${this.teams} teams.` });
        }
        if (body?.teamId !== undefined && body.teamId !== TEAM) return json(res, 404, { error: "Team not found." });
        // Like Pyo: base when no template is given.
        const template = (body?.template as string | undefined) ?? "base";
        if (template === "missing") return json(res, 404, { error: "Sandbox template not found." });
        const id = `sbx_mock${String(++this.n).padStart(12, "0")}`;
        const s: MockSandbox = {
          id,
          teamId: TEAM,
          template,
          env: (body?.env as Record<string, string>) ?? {},
          state: "running",
          expiresAt: Date.now() + 300_000,
          spec: body ?? {},
          ports: [],
        };
        this.daemon.sandboxes.set(id, s);
        return json(res, 201, { sandbox: this.view(s), connection: this.connection(id) });
      }
      case "GET /sandboxes": {
        const all = [...this.daemon.sandboxes.values()].filter((s) => s.teamId === url.searchParams.get("team"));
        return json(res, 200, { sandboxes: all.map((s) => this.view(s)), limits: {}, inUse: {} });
      }
      case "GET /sandboxes/{id}": {
        const s = needSbx();
        if (!s) return;
        // Like Pyo: a fresh connection while it lives.
        const live = s.state !== "stopped";
        return json(res, 200, {
          ...this.view(s),
          connection: live ? this.connection(s.id) : null,
          ...(live ? {} : { connectionNote: "The sandbox has ended." }),
        });
      }
      case "POST /sandboxes/{id}/token": {
        const s = needSbx();
        if (!s) return;
        if (s.state === "stopped") return json(res, 409, { error: `The sandbox ${s.id} has ended.` });
        return json(res, 200, this.connection(s.id));
      }
      case "POST /sandboxes/{id}/pause":
      case "POST /sandboxes/{id}/resume": {
        const s = needSbx();
        if (!s) return;
        const pausing = key.endsWith("pause");
        if (pausing !== (s.state === "running")) return json(res, 409, { error: pausing ? "It isn't running." : "It isn't paused." });
        s.state = pausing ? "paused" : "running";
        return json(res, 200, this.view(s));
      }
      case "POST /sandboxes/{id}/extend": {
        const s = needSbx();
        if (!s) return;
        const ttl = body?.ttl;
        const secs = typeof ttl === "number" ? ttl : ttl === "1h" ? 3600 : ttl === "30m" ? 1800 : NaN;
        if (!Number.isFinite(secs)) return json(res, 400, { error: 'The lifetime is like "30m", "1h" or a number of seconds.' });
        s.expiresAt = Date.now() + secs * 1000;
        return json(res, 200, this.view(s));
      }
      case "DELETE /sandboxes/{id}": {
        const s = needSbx();
        if (!s) return;
        s.state = "stopped";
        return json(res, 200, this.view(s));
      }
      case "POST /sandboxes/{id}/ports": {
        if (!this.portsRoute) return json(res, 404, { error: "No such endpoint." });
        const s = needSbx();
        if (!s) return;
        const port = body?.port as number;
        const isPublic = body?.public !== false;
        s.ports = [...s.ports.filter((p) => p.port !== port), { port, public: isPublic }];
        return json(res, 200, { url: `https://${port}-${s.id.replace("_", "-")}.sandbox.example.com`, port, public: isPublic });
      }
      default:
        return json(res, 404, { error: "No such endpoint." });
    }
  }
}

export async function startMocks(): Promise<{ pyo: MockPyo; daemon: MockDaemon; stop: () => Promise<void> }> {
  const daemon = new MockDaemon();
  await daemon.start();
  const pyo = new MockPyo(daemon);
  await pyo.start();
  return {
    pyo,
    daemon,
    stop: async () => {
      await pyo.stop();
      await daemon.stop();
    },
  };
}
