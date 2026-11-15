/**
 * The SDK against a real `pyo-sandbox` daemon booting a real Firecracker
 * microVM on this machine. Opt in with `PYO_SANDBOX_E2E=1`. It skips when
 * `/dev/kvm` isn't usable or a binary is missing.
 *
 * The daemon runs in dev mode (no jailer, no network, no root) on
 * 127.0.0.1. A small stand-in for Pyo signs real Ed25519 tokens, so the
 * daemon checks them exactly as it checks Pyo's.
 *
 * Inputs, with defaults from a pyo-sandbox checkout at
 * `PYO_SANDBOX_REPO` (`../pyo-sandbox`):
 *
 * - `PYO_SANDBOX_DAEMON`: `target/debug/pyo-sandbox`
 * - `PYO_SANDBOX_ENVD`: `target/x86_64-unknown-linux-musl/release/pyo-envd`
 * - `PYO_SANDBOX_FIRECRACKER`: `.cache/sandbox-e2e/bin/firecracker`
 * - `PYO_SANDBOX_KERNEL`: `.cache/sandbox-e2e/vmlinux`
 *
 * The pyo-sandbox repo's `crates/pyo-sandbox/scripts/e2e-assets.sh` fetches
 * Firecracker and the kernel. The template is this machine's static
 * busybox plus envd.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as netServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "../src/index.js";

const repo = resolve(process.env.PYO_SANDBOX_REPO ?? fileURLToPath(new URL("../../pyo-sandbox", import.meta.url)));
const input = (name: string, def: string) => process.env[name] ?? join(repo, def);
const paths = {
  daemon: input("PYO_SANDBOX_DAEMON", "target/debug/pyo-sandbox"),
  envd: input("PYO_SANDBOX_ENVD", "target/x86_64-unknown-linux-musl/release/pyo-envd"),
  firecracker: input("PYO_SANDBOX_FIRECRACKER", ".cache/sandbox-e2e/bin/firecracker"),
  kernel: input("PYO_SANDBOX_KERNEL", ".cache/sandbox-e2e/vmlinux"),
};

function why(): string | null {
  if (process.env.PYO_SANDBOX_E2E !== "1") return "set PYO_SANDBOX_E2E=1 to boot a real microVM";
  try {
    accessSync("/dev/kvm", constants.R_OK | constants.W_OK);
  } catch {
    return "/dev/kvm isn't usable by this user";
  }
  for (const [what, p] of Object.entries(paths)) if (!existsSync(p)) return `${what} isn't at ${p}`;
  if (!existsSync("/usr/bin/busybox")) return "busybox isn't at /usr/bin/busybox";
  return null;
}

const skip = why();
if (skip) console.warn(`skipping the e2e: ${skip}`);

const SERVER = "sbs_e2e";
const TEAM = "tm_e2e";
const TEMPLATE = "e2e-busybox";
const KID = "sbk_e2e";
const API_KEY = "pyo_e2e";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

class Signer {
  private readonly priv: KeyObject;
  readonly publicKey: string;
  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    this.priv = createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" }));
    this.publicKey = publicKey.export({ format: "jwk" }).x!;
  }
  /** A token in the format of pyo_proto::sandbox::token. */
  token(sbx: string, scopes: string[], ttlSecs: number): { token: string; expiresAt: number } {
    const iat = Math.floor(Date.now() / 1000);
    const claims = { kid: KID, sbx, team: TEAM, srv: SERVER, iat, exp: iat + ttlSecs, scopes };
    const signed = `pyosbx1.${b64url(JSON.stringify(claims))}`;
    return { token: `${signed}.${b64url(sign(null, Buffer.from(signed), this.priv))}`, expiresAt: claims.exp * 1000 };
  }
}

function rootfs(dir: string, out: string): void {
  const src = join(dir, "template-src");
  for (const d of ["bin", "sbin", "proc", "sys", "dev", "tmp", "run", "root", "mnt", "etc"]) mkdirSync(join(src, d), { recursive: true });
  copyFileSync("/usr/bin/busybox", join(src, "bin/busybox"));
  const applets = spawnSync("/usr/bin/busybox", ["--list"], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  for (const a of applets) if (a !== "busybox" && !existsSync(join(src, "bin", a))) symlinkSync("busybox", join(src, "bin", a));
  copyFileSync(paths.envd, join(src, "sbin/pyo-envd"));
  writeFileSync(join(src, "etc/passwd"), "root:x:0:0:root:/root:/bin/sh\n");
  mkdirSync(resolve(out, ".."), { recursive: true });
  const mkfs = ["/usr/sbin/mkfs.ext4", "/sbin/mkfs.ext4"].find((p) => existsSync(p)) ?? "mkfs.ext4";
  const r = spawnSync(mkfs, ["-q", "-F", "-L", "busybox", "-d", src, out, "64M"], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`mkfs.ext4 failed: ${r.stderr}`);
  rmSync(src, { recursive: true, force: true });
}

function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = netServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

/** Pyo's part, in miniature: it signs tokens and makes the daemon calls Pyo makes. */
function standInPyo(daemonUrl: string, signer: Signer): Server {
  const admin = () => signer.token("*", ["admin"], 300).token;
  const daemon = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(`${daemonUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const connection = (id: string) => ({ url: daemonUrl, sandboxId: id, ...signer.token(id, ["exec", "pty", "files", "ports"], 3600) });
  const view = (s: Record<string, any>) => ({ ...s, teamId: s.team, env: [] });
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const parts: Buffer[] = [];
    for await (const c of req) parts.push(c as Buffer);
    const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { error: "Send a Pyo API key." });
    const path = (req.url ?? "").replace(/^\/api\/v1/, "");
    const m = path.match(/^\/sandboxes\/([^/]+)(\/\w+)?$/);
    const id = m?.[1] ?? "";
    const fail = (r: { status: number; body: Record<string, any> }) => send(r.status, { error: r.body.error?.message ?? "error" });
    if (req.method === "POST" && path === "/sandboxes") {
      const sid = `sbx_${randomBytes(10).toString("hex")}`;
      const spec = { id: sid, team: TEAM, template: body.template, memoryMib: 256, diskMib: 256, network: "none", env: body.env ?? {}, ttlSecs: 600 };
      const r = await daemon("POST", "/v1/sandboxes", signer.token(sid, ["create"], 300).token, spec);
      if (r.status !== 201) return fail(r);
      return send(201, { sandbox: view(r.body.sandbox), connection: connection(sid) });
    }
    if (req.method === "POST" && m?.[2] === "/token") return send(200, connection(id));
    if (req.method === "GET" && m && !m[2]) {
      const r = await daemon("GET", `/v1/sandboxes/${id}`, admin());
      return r.status === 200 ? send(200, view(r.body.sandbox)) : fail(r);
    }
    if (req.method === "POST" && m?.[2] === "/extend") {
      const r = await daemon("POST", `/v1/sandboxes/${id}/ttl`, admin(), { ttlSecs: body.ttl === "1h" ? 3600 : Number(body.ttl) });
      return r.status === 200 ? send(200, view(r.body.sandbox)) : fail(r);
    }
    if (req.method === "DELETE" && m && !m[2]) {
      const r = await daemon("DELETE", `/v1/sandboxes/${id}`, admin());
      return r.status === 200 ? send(200, { id, state: "stopped" }) : fail(r);
    }
    send(404, { error: "No such endpoint." });
  });
}

describe.skipIf(skip !== null)("a real sandbox daemon", () => {
  let dir = "";
  let daemonProc: ChildProcess | undefined;
  let pyo: Server | undefined;
  let pyoUrl = "";
  let sbx: Sandbox;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pyo-sdk-e2e-"));
    rootfs(dir, join(dir, "pool/templates", TEMPLATE, "rootfs.ext4"));
    const signer = new Signer();
    const port = await freePort();
    const daemonUrl = `http://127.0.0.1:${port}`;
    const cfg = {
      serverId: SERVER,
      listen: `127.0.0.1:${port}`,
      root: join(dir, "pool"),
      firecracker: paths.firecracker,
      kernel: paths.kernel,
      envd: paths.envd,
      keys: [{ kid: KID, publicKey: signer.publicKey }],
      hostReserveMib: 1024,
      dev: true,
    };
    writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
    daemonProc = spawn(paths.daemon, ["serve", "--dev", "--config", join(dir, "config.json")], {
      env: { ...process.env, RUST_LOG: "warn" },
      stdio: ["ignore", "ignore", "inherit"],
    });
    for (let i = 0; ; i++) {
      const ok = await fetch(`${daemonUrl}/v1/health`).then((r) => r.ok, () => false);
      if (ok) break;
      if (i > 150) throw new Error(`the daemon didn't come up on ${daemonUrl}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    pyo = standInPyo(daemonUrl, signer);
    await new Promise<void>((r) => pyo!.listen(0, "127.0.0.1", r));
    pyoUrl = `http://127.0.0.1:${(pyo.address() as AddressInfo).port}`;
    sbx = await Sandbox.create({ apiKey: API_KEY, baseUrl: pyoUrl, teamId: TEAM, template: TEMPLATE, env: { GREETING: "hi" } });
  });

  afterAll(async () => {
    await sbx?.delete().catch(() => {});
    pyo?.close();
    daemonProc?.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    // VMs outlive the daemon by design: end this run's.
    for (const pid of readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
      try {
        const cwd = readlinkSync(`/proc/${pid}/cwd`);
        const comm = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
        if (cwd.startsWith(dir) && comm === "firecracker") process.kill(Number(pid), "SIGKILL");
      } catch {
        // Gone, or not ours.
      }
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("runs commands over HTTP and the WebSocket", async () => {
    const http = await sbx.exec("echo $GREETING from $(uname -s); exit 4");
    expect(http).toMatchObject({ stdout: "hi from Linux\n", exitCode: 4 });
    const chunks: string[] = [];
    const ws = await sbx.exec(["sh", "-c", "echo a; sleep 0.2; echo $GREETING >&2"], { onStdout: (d) => chunks.push(d) });
    expect(ws).toMatchObject({ stdout: "a\n", stderr: "hi\n", exitCode: 0 });
    expect(chunks).toEqual(["a\n"]);
    const killed = await sbx.exec("sleep 30", { transport: "websocket", timeoutMs: 300 });
    expect(killed).toMatchObject({ timedOut: true, exitCode: null });
  });

  it("feeds stdin to a running command", async () => {
    const h = await sbx.spawn("cat", { stdin: true });
    h.write("through envd\n");
    h.end();
    expect((await h.wait()).stdout).toBe("through envd\n");
  });

  it("reads and writes files", async () => {
    await sbx.files.mkdir("/app/src");
    await sbx.files.write("/app/src/index.js", "console.log('hi')\n", { mode: 0o755 });
    expect(await sbx.files.read("/app/src/index.js")).toBe("console.log('hi')\n");
    expect(await sbx.files.stat("/app/src/index.js")).toMatchObject({ kind: "file", size: 18, mode: 0o755 });
    expect((await sbx.files.list("/app")).map((e) => e.name)).toEqual(["src"]);
    await sbx.files.remove("/app", { recursive: true });
    expect(await sbx.files.exists("/app")).toBe(false);
    await expect(sbx.files.read("/nope")).rejects.toMatchObject({ code: "notFound" });
  });

  it("opens a terminal", async () => {
    let out = "";
    const p = await sbx.pty({ cols: 90, rows: 20, onData: (d) => (out += new TextDecoder().decode(d)) });
    p.resize(100, 30);
    p.write("stty size; echo marker-$((40+2))\r");
    for (let i = 0; i < 50 && !out.includes("marker-42"); i++) await new Promise((r) => setTimeout(r, 100));
    expect(out).toContain("30 100");
    expect(out).toContain("marker-42");
    p.write("exit\r");
    expect((await p.wait()).exitCode).toBe(0);
  });

  it("reaches a port inside the sandbox", async () => {
    await sbx.files.mkdir("/tmp/www");
    await sbx.files.write("/tmp/www/index.html", "hello from the sandbox");
    const server = await sbx.spawn("httpd -f -p 8080 -h /tmp/www");
    try {
      let reply = "";
      for (let i = 0; i < 30; i++) {
        try {
          const c = await sbx.ports.connect(8080, { onData: (d) => (reply += new TextDecoder().decode(d)) });
          c.write("GET / HTTP/1.0\r\n\r\n");
          c.end();
          await c.closed;
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(reply).toMatch(/^HTTP\/1\.[01] 200/);
      expect(reply).toContain("hello from the sandbox");
    } finally {
      server.kill();
      await server.wait().catch(() => {});
    }
    await expect(sbx.ports.open(8080)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("refreshes its token and extends its life through Pyo", async () => {
    const before = sbx.tokenExpiresAt;
    await new Promise((r) => setTimeout(r, 1100));
    await sbx.refresh();
    expect(sbx.tokenExpiresAt).toBeGreaterThan(before);
    expect((await sbx.exec("echo still")).stdout).toBe("still\n");
    const info = await sbx.extend("1h");
    expect(info.expiresAt).toBeGreaterThan(Date.now() + 3_500_000);
  });
});
