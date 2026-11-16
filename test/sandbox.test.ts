import { createServer, type AddressInfo, type Server } from "node:net";
import { readFileSync, statSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket as WsWebSocket } from "ws";
import { PyoSandboxError, Sandbox, type CreateOptions, type WebSocketLike } from "../src/index.js";
import { API_KEY, TEAM, startMocks, type MockDaemon, type MockPyo } from "./mock.js";

let pyo: MockPyo;
let daemon: MockDaemon;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ pyo, daemon, stop } = await startMocks());
});
afterAll(() => stop());
afterEach(() => {
  pyo.tokenTtlMs = 3_600_000;
  pyo.portsRoute = false;
  pyo.teams = 1;
  daemon.outputCap = 8 << 20;
  daemon.hello = { protocol: 1, minProtocol: 1, envdVersion: "mock-0.0.0" };
});

function base(): Pick<CreateOptions, "apiKey" | "baseUrl" | "teamId"> {
  return { apiKey: API_KEY, baseUrl: pyo.url, teamId: TEAM };
}

async function create(extra: Partial<CreateOptions> = {}): Promise<Sandbox> {
  return Sandbox.create({ ...base(), template: "node-22", ...extra });
}

async function rejection(p: Promise<unknown>): Promise<PyoSandboxError> {
  const e = await p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(PyoSandboxError);
  return e as PyoSandboxError;
}

describe("create and connect", () => {
  it("creates a sandbox with only the fields given", async () => {
    const sbx = await create({ ttl: "1h", memoryMib: 1024, env: { GREETING: "hi" }, labels: { job: "ci" }, network: "none" });
    expect(sbx.id).toMatch(/^sbx_/);
    expect(sbx.info?.state).toBe("running");
    expect(sbx.info?.env).toEqual(["GREETING"]);
    expect(sbx.url).toBe(daemon.url);
    const call = pyo.calls.filter((c) => c.method === "POST" && c.path === "/sandboxes").at(-1);
    expect(call?.body).toEqual({
      teamId: TEAM,
      template: "node-22",
      ttl: "1h",
      memoryMib: 1024,
      env: { GREETING: "hi" },
      labels: { job: "ci" },
      network: "none",
    });
  });

  it("reads PYO_URL, PYO_API_KEY and PYO_TEAM", async () => {
    const saved = { ...process.env };
    process.env.PYO_URL = `${pyo.url}/api/v1/`;
    process.env.PYO_API_KEY = API_KEY;
    process.env.PYO_TEAM = TEAM;
    try {
      const sbx = await Sandbox.create({ template: "node-22" });
      expect(sbx.id).toMatch(/^sbx_/);
    } finally {
      process.env = saved;
    }
  });

  it("explains what's missing", async () => {
    const saved = { ...process.env };
    delete process.env.PYO_URL;
    delete process.env.PYO_API_KEY;
    delete process.env.PYO_TOKEN;
    delete process.env.PYO_TEAM;
    try {
      expect((await rejection(Sandbox.create({ template: "x" }))).code).toBe("missingBaseUrl");
      expect((await rejection(Sandbox.create({ baseUrl: pyo.url, template: "x" }))).code).toBe("missingApiKey");
    } finally {
      process.env = saved;
    }
  });

  it("leaves the team to Pyo when none is given", async () => {
    const saved = { ...process.env };
    delete process.env.PYO_TEAM;
    try {
      const opts = { baseUrl: pyo.url, apiKey: API_KEY, template: "node-22" };
      const sbx = await Sandbox.create(opts);
      expect(sbx.info?.teamId).toBe(TEAM);
      expect(pyo.calls.at(-1)?.body).toEqual({ template: "node-22" });
      pyo.teams = 2;
      const e = await rejection(Sandbox.create(opts));
      expect(e).toMatchObject({ source: "pyo", status: 400, code: "invalidRequest" });
      expect(e.message).toMatch(/^Pass teamId/);
    } finally {
      process.env = saved;
    }
  });

  it("leaves the template to Pyo when none is given", async () => {
    const sbx = await Sandbox.create(base());
    expect(pyo.calls.at(-1)?.body).not.toHaveProperty("template");
    expect(sbx.info?.template).toBe("base");
  });

  it("surfaces Pyo's errors", async () => {
    const e = await rejection(create({ template: "missing" }));
    expect(e.source).toBe("pyo");
    expect(e.status).toBe(404);
    expect(e.code).toBe("notFound");
    expect(e.message).toBe("Sandbox template not found.");
    const bad = await rejection(Sandbox.create({ ...base(), apiKey: "nope", template: "node-22" }));
    expect(bad.status).toBe(401);
  });

  it("reconnects to an existing sandbox with the connection Pyo shows", async () => {
    const a = await create({ env: { GREETING: "hi" } });
    const before = pyo.count("POST", /\/token$/);
    const b = await Sandbox.connect(a.id, { apiKey: API_KEY, baseUrl: pyo.url });
    // getSandbox brings the connection, so no token call.
    expect(pyo.count("POST", /\/token$/)).toBe(before);
    expect(b.info?.id).toBe(a.id);
    expect((await b.exec("echo back")).stdout).toBe("back\n");
    // The server adds the sandbox's env, without the client knowing it.
    expect((await b.exec("echo $GREETING", { transport: "websocket" })).stdout).toBe("hi\n");
  });

  it("lists a team's sandboxes", async () => {
    const sbx = await create();
    const all = await Sandbox.list({ ...base() });
    expect(all.map((s) => s.id)).toContain(sbx.id);
  });
});

describe("exec", () => {
  it("runs a shell string over HTTP with the sandbox's env", async () => {
    const sbx = await create({ env: { GREETING: "hi" } });
    const r = await sbx.exec("echo $GREETING $EXTRA; echo oops >&2; exit 3", { env: { EXTRA: "there" } });
    expect(r).toMatchObject({ stdout: "hi there\n", stderr: "oops\n", exitCode: 3, timedOut: false, truncated: false });
    expect(daemon.events.at(-1)).toEqual({ kind: "http", detail: "POST /exec" });
  });

  it("runs an argv as is", async () => {
    const sbx = await create();
    const r = await sbx.exec(["printf", "%s|", "a b", "c"]);
    expect(r.stdout).toBe("a b|c|");
  });

  it("sends stdin", async () => {
    const sbx = await create();
    expect((await sbx.exec("tr a-z A-Z", { stdin: "shout" })).stdout).toBe("SHOUT");
    expect((await sbx.exec("tr a-z A-Z", { stdin: new TextEncoder().encode("bytes") })).stdout).toBe("BYTES");
  });

  it("streams output over the WebSocket", async () => {
    const sbx = await create({ env: { GREETING: "hi" } });
    const out: string[] = [];
    const err: string[] = [];
    const r = await sbx.exec("echo one; sleep 0.1; echo $GREETING; echo bad >&2", {
      onStdout: (d) => out.push(d),
      onStderr: (d) => err.push(d),
    });
    expect(out.join("")).toBe("one\nhi\n");
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(err.join("")).toBe("bad\n");
    expect(r).toMatchObject({ stdout: "one\nhi\n", stderr: "bad\n", exitCode: 0 });
    expect(daemon.events.some((e) => e.kind === "ws")).toBe(true);
  });

  it("decodes UTF-8 split across frames", async () => {
    const sbx = await create();
    // "é" is two bytes; print them in two writes.
    const r = await sbx.exec("printf '\\303'; sleep 0.05; printf '\\251'", { transport: "websocket" });
    expect(r.stdout).toBe("é");
  });

  it("kills a command after its timeout", async () => {
    const sbx = await create();
    const ws = await sbx.exec("sleep 5", { transport: "websocket", timeoutMs: 200 });
    expect(ws).toMatchObject({ timedOut: true, exitCode: null, signal: 9 });
    const http = await sbx.exec("sleep 5", { timeoutMs: 200 });
    expect(http).toMatchObject({ timedOut: true, exitCode: null });
  });

  it("kills a command when the signal aborts", async () => {
    const sbx = await create();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    const r = await sbx.exec("sleep 5", { signal: ac.signal });
    expect(r.signal).toBe(9);
    expect(r.durationMs).toBeLessThan(3000);
  });

  it("refuses an empty command", async () => {
    const sbx = await create();
    expect((await rejection(sbx.exec("  "))).code).toBe("invalidOptions");
  });
});

describe("spawn", () => {
  it("takes stdin and returns the pid", async () => {
    const sbx = await create();
    const h = await sbx.spawn("cat", { stdin: true });
    expect(h.pid).toBeGreaterThan(0);
    h.write("line one\n");
    h.write(new TextEncoder().encode("line two\n"));
    h.end();
    const r = await h.wait();
    expect(r.stdout).toBe("line one\nline two\n");
    expect(r.exitCode).toBe(0);
  });

  it("can be killed", async () => {
    const sbx = await create();
    const h = await sbx.spawn("sleep 10");
    h.kill(15);
    expect((await h.wait()).signal).toBe(15);
  });

  it("reports a command that can't start", async () => {
    const sbx = await create();
    const e = await rejection(sbx.spawn(["/no/such/binary"]));
    expect(e.source).toBe("sandbox");
  });
});

describe("pty", () => {
  it("opens a terminal, types, resizes and exits", async () => {
    const sbx = await create({ env: { FOO: "bar" } });
    const chunks: Uint8Array[] = [];
    const p = await sbx.pty({ cols: 100, rows: 30, onData: (d) => chunks.push(d) });
    expect(p.pid).toBe(4242);
    p.resize(120, 40);
    p.write("ls\r");
    p.write("exit\r");
    expect(await p.wait()).toEqual({ exitCode: 0 });
    const text = Buffer.concat(chunks).toString();
    expect(text).toContain("FOO=bar 100x30");
    expect(text).toContain("ls\r");
    expect(daemon.resizes).toContainEqual({ cols: 120, rows: 40 });
  });
});

describe("files", () => {
  it("write, read, stat, list, mkdir, remove", async () => {
    const sbx = await create();
    await sbx.files.mkdir("/app/src");
    expect(await sbx.files.write("/app/index.js", "console.log('hi')", { mode: 0o755 })).toEqual({ bytes: 17 });
    expect(statSync(daemon.local("/app/index.js")).mode & 0o777).toBe(0o755);
    expect(await sbx.files.read("/app/index.js")).toBe("console.log('hi')");
    const bin = new Uint8Array([0, 1, 2, 255]);
    await sbx.files.write("/app/blob.bin", bin);
    expect([...(await sbx.files.readBytes("/app/blob.bin"))]).toEqual([0, 1, 2, 255]);
    await sbx.files.write("/app/b.txt", new Blob(["from a blob"]));
    expect(readFileSync(daemon.local("/app/b.txt"), "utf8")).toBe("from a blob");
    const st = await sbx.files.stat("/app/index.js");
    expect(st).toMatchObject({ name: "index.js", path: "/app/index.js", kind: "file", size: 17, mode: 0o755 });
    const names = (await sbx.files.list("/app")).map((e) => `${e.name}:${e.kind}`);
    expect(names).toEqual(["b.txt:file", "blob.bin:file", "index.js:file", "src:dir"]);
    expect(await sbx.files.exists("/app/src")).toBe(true);
    await sbx.files.remove("/app/src", { recursive: true });
    expect(await sbx.files.exists("/app/src")).toBe(false);
  });

  it("maps a missing file to notFound", async () => {
    const sbx = await create();
    const e = await rejection(sbx.files.read("/nope.txt"));
    expect(e).toMatchObject({ source: "server", code: "notFound", status: 404 });
  });
});

describe("ports", () => {
  it("explains that Pyo can't open ports yet", async () => {
    const sbx = await create();
    const e = await rejection(sbx.ports.open(3000));
    expect(e).toMatchObject({ source: "pyo", code: "unsupported", status: 404 });
    expect(e.message).toMatch(/can't open sandbox ports/);
  });

  it("returns the URL once Pyo can", async () => {
    pyo.portsRoute = true;
    const sbx = await create();
    const host = sbx.id.replace("_", "-");
    expect(await sbx.ports.open(3000)).toBe(`https://3000-${host}.sandbox.example.com`);
    expect(pyo.calls.at(-1)?.body).toEqual({ port: 3000, public: true });
    expect(await sbx.ports.open(3001, { public: false })).toBe(`https://3001-${host}.sandbox.example.com`);
    expect(pyo.calls.at(-1)?.body).toEqual({ port: 3001, public: false });
    const info = await sbx.getInfo();
    expect(info.ports).toEqual([
      { port: 3000, public: true, url: `https://3000-${host}.sandbox.example.com` },
      { port: 3001, public: false, url: `https://3001-${host}.sandbox.example.com` },
    ]);
    expect(info.edgeUrl).toBe("https://sandbox.example.com");
    expect((await rejection(sbx.ports.open(70000))).code).toBe("invalidOptions");
  });

  it("connects to a port through the server", async () => {
    const echo: Server = createServer((s) => s.on("data", (d) => s.write(`echo:${d}`)).on("end", () => s.end()));
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const port = (echo.address() as AddressInfo).port;
    try {
      const sbx = await create();
      let got = "";
      const c = await sbx.ports.connect(port, { onData: (d) => (got += new TextDecoder().decode(d)) });
      c.write("ping");
      await new Promise((r) => setTimeout(r, 100));
      c.end();
      await c.closed;
      expect(got).toBe("echo:ping");
    } finally {
      echo.close();
    }
  });

  it("reports a closed port", async () => {
    const sbx = await create();
    const e = await rejection(sbx.ports.connect(1));
    expect(e.source).toBe("sandbox");
    expect(e.message).toMatch(/nothing answers on port 1/);
  });
});

describe("lifecycle", () => {
  it("pause, resume, extend and delete go to Pyo", async () => {
    const sbx = await create();
    expect((await sbx.pause()).state).toBe("paused");
    const e = await rejection(sbx.pause());
    expect(e).toMatchObject({ status: 409, code: "conflict", message: "It isn't running." });
    expect((await sbx.resume()).state).toBe("running");
    const before = sbx.info!.expiresAt;
    const after = await sbx.extend("1h");
    expect(after.expiresAt).toBeGreaterThan(before);
    expect((await rejection(sbx.extend("soon"))).status).toBe(400);
    expect((await sbx.delete()).state).toBe("stopped");
    expect(pyo.calls.some((c) => c.path === `/sandboxes/${sbx.id}/extend` && JSON.stringify(c.body) === '{"ttl":"1h"}')).toBe(true);
  });

  it("needs an API key without Pyo", async () => {
    const saved = { ...process.env };
    delete process.env.PYO_URL;
    delete process.env.PYO_API_KEY;
    try {
      const a = await create();
      const conn = await a.connection();
      const b = Sandbox.fromConnection(conn);
      expect((await b.exec("echo ok")).stdout).toBe("ok\n");
      expect((await rejection(b.pause())).code).toBe("missingApiKey");
    } finally {
      process.env = saved;
    }
  });
});

describe("tokens", () => {
  it("renews a token that's about to run out, once for parallel calls", async () => {
    pyo.tokenTtlMs = 60_000; // inside the 5 minute margin
    const sbx = await create();
    const first = sbx.tokenExpiresAt;
    const before = pyo.count("POST", /\/token$/);
    pyo.tokenTtlMs = 3_600_000;
    await Promise.all([sbx.exec("true"), sbx.files.exists("/"), sbx.exec("true")]);
    expect(pyo.count("POST", /\/token$/)).toBe(before + 1);
    expect(sbx.tokenExpiresAt).toBeGreaterThan(first);
    await sbx.exec("true");
    expect(pyo.count("POST", /\/token$/)).toBe(before + 1);
  });

  it("gets a new token and tries again when the server refuses one", async () => {
    const sbx = await create();
    daemon.tokens.clear();
    expect((await sbx.exec("echo again")).stdout).toBe("again\n");
    daemon.tokens.clear();
    expect((await sbx.exec("echo ws", { transport: "websocket" })).stdout).toBe("ws\n");
  });

  it("uses refreshToken without an API key", async () => {
    const a = await create();
    let asked = 0;
    const b = Sandbox.fromConnection({ ...(await a.connection()), expiresAt: Date.now() + 1000 }, {
      apiKey: "",
      baseUrl: "",
      refreshToken: async () => {
        asked++;
        return a.refresh();
      },
    });
    expect((await b.exec("echo fresh")).stdout).toBe("fresh\n");
    expect(asked).toBe(1);
  });
});

describe("the WebSocket", () => {
  it("works with the ws package, for Node 20", async () => {
    const sbx = await create({ WebSocket: WsWebSocket as unknown as WebSocketLike });
    const out: string[] = [];
    const r = await sbx.exec("echo via ws", { onStdout: (d) => out.push(d) });
    expect(r.stdout).toBe("via ws\n");
    expect(out.join("")).toBe("via ws\n");
  });

  it("explains a missing WebSocket", async () => {
    const saved = globalThis.WebSocket;
    // @ts-expect-error simulating Node 20
    delete globalThis.WebSocket;
    try {
      const sbx = await create();
      expect((await rejection(sbx.exec("true", { onStdout: () => {} }))).code).toBe("noWebSocket");
      // Plain exec still works over HTTP.
      expect((await sbx.exec("echo http")).stdout).toBe("http\n");
    } finally {
      globalThis.WebSocket = saved;
    }
  });

  it("sends the token as a subprotocol, not in the URL", async () => {
    const sbx = await create();
    await sbx.exec("true", { transport: "websocket" });
    expect(daemon.lastProtocol).toBe("pyo");
    expect(daemon.lastUrlHadToken).toBe(false);
    const ws = await create({ WebSocket: WsWebSocket as unknown as WebSocketLike });
    await ws.exec("true", { transport: "websocket" });
    expect(daemon.lastProtocol).toBe("pyo");
  });

  it("says why the server refused the WebSocket", async () => {
    const a = await create();
    const b = await create();
    const crossed = Sandbox.fromConnection({ ...(await a.connection()), sandboxId: b.id }, { apiKey: "", baseUrl: "" });
    const e = await rejection(crossed.exec("true", { transport: "websocket" }));
    expect(e).toMatchObject({ source: "server", status: 403, code: "forbidden" });
    expect(e.message).toBe("The sandbox token is for another sandbox.");
  });

  it("caps a command's output like HTTP exec", async () => {
    daemon.outputCap = 10;
    const sbx = await create();
    const r = await sbx.exec("printf 0123456789abcdef", { transport: "websocket" });
    expect(r).toMatchObject({ stdout: "0123456789", truncated: true, timedOut: false, exitCode: 0 });
    // A spawned process has no limits unless it asks for a timeout.
    const h = await sbx.spawn("printf 0123456789abcdef");
    expect(await h.wait()).toMatchObject({ stdout: "0123456789abcdef", truncated: false });
  });

  it("closes when envd speaks no common protocol", async () => {
    daemon.hello = { protocol: 7, minProtocol: 5, envdVersion: "9.0.0" };
    const sbx = await create();
    const e = await rejection(sbx.exec("true", { transport: "websocket" }));
    expect(e.message).toMatch(/envd 9.0.0 speaks protocol 5 to 7/);
  });

  it("gives the server's reason when it refuses the WebSocket", async () => {
    const sbx = await create();
    await sbx.delete();
    daemon.sandboxes.get(sbx.id)!.state = "stopped";
    // Pyo won't renew a token for an ended sandbox, and the old one is gone.
    daemon.tokens.clear();
    const e = await rejection(sbx.exec("true", { transport: "websocket" }));
    expect(e).toMatchObject({ source: "pyo", status: 409 });
    expect(e.message).toMatch(/has ended/);
  });
});
