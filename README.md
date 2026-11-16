# @pyodev/sandbox

The TypeScript SDK for Pyo Sandbox. A sandbox is an isolated machine made on demand through an API, for AI agents, code interpreters, previews and CI jobs. Create one, run commands, read and write files, reach its ports and throw it away. Sandboxes run on your own sandbox servers, on Firecracker where the server has KVM and on gVisor elsewhere.

```ts
import { Sandbox } from "@pyodev/sandbox";

const sbx = await Sandbox.create({ ttl: "1h" });
const out = await sbx.exec("node -v");
await sbx.files.write("/app/index.js", "console.log('hi')");
const url = await sbx.ports.open(3000);
await sbx.pause();
```

Without a template, a sandbox starts from `base`, Pyo's built-in template: Debian 13 with git, Python 3 with pip and uv, Node.js LTS with npm and pnpm, and build tools. A sandbox server makes `base` the first time it's used there, so the first `Sandbox.create()` on a server takes longer. Later ones start at once.

## Install

```sh
npm install @pyodev/sandbox
```

It has no runtime dependencies. It works in Node 20 and later and in Bun, with the global `fetch` and `WebSocket`.

Node 20 has no global `WebSocket`. Plain `exec` and files work without one. For streaming output, terminals and port connections, install `ws` and pass it in:

```ts
import WebSocket from "ws";
const sbx = await Sandbox.create({ WebSocket });
```

## Setup

The SDK reads these when you don't pass them:

| Variable | Option | What it is |
|---|---|---|
| `PYO_URL` | `baseUrl` | Your Pyo, like `https://pyo.example.com` |
| `PYO_API_KEY` | `apiKey` | A Pyo API key with sandbox access. `PYO_TOKEN` works too. |
| `PYO_TEAM` | `teamId` | The team the sandboxes belong to. `create` may leave it out when the API key has one team. |

Pyo is the control plane only. It creates sandboxes, signs tokens and handles pause, resume, lifetime and delete. Commands, terminals and files go straight from your code to the sandbox server with a short-lived token, so Pyo is never in the hot path. The sandbox server answers on your tailnet, so the code that uses a sandbox runs on a machine in your tailnet.

## Sandboxes

```ts
const sbx = await Sandbox.create({
  template: "node-22",     // a sandbox template's name or id. "base" by default.
  server: "sandbox-1",     // a sandbox server's name or id. Pyo picks one by default.
  cpus: 2,                 // 1 by default
  memoryMib: 1024,         // 512 by default
  diskMib: 4096,           // 2048 by default, sparse
  ttl: "1h",               // "90s", "30m", "1h30m" or seconds. 5 minutes by default.
  env: { API_URL: "https://example.com" },
  network: "none",         // "internet" by default
  isolation: "vm",         // "auto" by default. "vm" needs Firecracker.
  labels: { job: "ci-1234" },
  projectId: "prj_123",
});

sbx.id;          // "sbx_…"
sbx.info;        // the sandbox as Pyo shows it: state, runtime, sizes, expiresAt…
```

Reconnect to a sandbox that already exists:

```ts
const sbx = await Sandbox.connect("sbx_abc123");
```

List a team's sandboxes:

```ts
const live = await Sandbox.list();                 // not stopped or failed
const all = await Sandbox.list({ state: "all" });  // the latest 500
```

Lifecycle calls go to Pyo:

```ts
await sbx.extend("2h");  // it now ends two hours from now
await sbx.pause();       // keeps memory and files, drops connections
await sbx.resume();
await sbx.delete();
await sbx.getInfo();     // fresh from Pyo
```

## Commands

```ts
const r = await sbx.exec("ls -la /app");
r.stdout; r.stderr; r.exitCode; r.timedOut; r.durationMs;

await sbx.exec(["python3", "-c", "print(1 + 1)"]);   // an argv runs as is
await sbx.exec("npm test", { cwd: "/app", env: { CI: "1" }, timeoutMs: 300_000 });
await sbx.exec("wc -c", { stdin: "some input" });
```

A string runs with `/bin/sh -c`. A non-zero exit code is not an error. Commands get the sandbox's env, with `env` on top. They time out after 60 seconds unless you say otherwise, and keep at most 8 MiB of each output (`truncated` says when more was dropped). The sandbox server enforces both.

Pass `onStdout` or `onStderr` to get output as it arrives, and an `AbortSignal` to stop a command:

```ts
const ac = new AbortController();
await sbx.exec("npm install", {
  onStdout: (d) => process.stdout.write(d),
  onStderr: (d) => process.stderr.write(d),
  signal: ac.signal,
});
```

`spawn` starts a command and returns at once, for servers and interactive input. It has no time limit or output cap unless you pass `timeoutMs`:

```ts
const proc = await sbx.spawn("python3 -i", { stdin: true, onStdout: console.log });
proc.pid;
proc.write("print('hi')\n");
proc.end();                   // closes stdin
proc.kill();                  // SIGKILL, or pass a signal number
const result = await proc.wait();
```

## Terminals

```ts
const pty = await sbx.pty({ cols: 120, rows: 30, onData: (bytes) => term.write(bytes) });
pty.write("ls\r");
pty.resize(160, 40);
await pty.wait();
```

`cmd` picks the program. The user's login shell runs by default.

## Files

```ts
await sbx.files.mkdir("/app/src");
await sbx.files.write("/app/src/index.js", "console.log('hi')", { mode: 0o644 });
await sbx.files.write("/app/logo.png", bytes);      // Uint8Array, ArrayBuffer or Blob
const text = await sbx.files.read("/app/src/index.js");
const data = await sbx.files.readBytes("/app/logo.png");
const entries = await sbx.files.list("/app");        // name, path, kind, size, mode, modified
const st = await sbx.files.stat("/app/src/index.js");
await sbx.files.exists("/app/tmp");
await sbx.files.remove("/app/tmp", { recursive: true });
```

Each call moves at most 64 MiB.

## Ports

`ports.open` opens a port on the sandbox server's edge proxy and returns its URL, like `https://3000-sbx-abc.sbx.example.com`:

```ts
await sbx.spawn("npx serve -l 3000");
const url = await sbx.ports.open(3000);                       // public
const admin = await sbx.ports.open(8080, { public: false });  // needs a sandbox token
```

A private port needs the sandbox token on each request, as `X-Pyo-Token`, or once as `?pyo_token=` in a browser. `sbx.info.ports` lists the open ports with their URLs. A server without an edge proxy refuses with code `conflict`.

`ports.connect` opens a TCP connection to a port inside the sandbox through the sandbox server, without any network in the sandbox:

```ts
const conn = await sbx.ports.connect(3000, { onData: (d) => process.stdout.write(d) });
conn.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
conn.end();
await conn.closed;
```

## Tokens

The token for the sandbox server lasts an hour. The SDK asks Pyo for a new one (`POST /sandboxes/{id}/token`) five minutes before it runs out, and once more if the server refuses one. Set `tokenRefreshMarginMs` to change the margin, or call `sbx.refresh()` yourself.

A client without an API key, like a browser, can use a connection your backend made and passed on:

```ts
// On your backend
const sbx = await Sandbox.create({ template: "node-22" });
const conn = await sbx.connection(); // { url, sandboxId, token, expiresAt }

// In the client
const sbx = Sandbox.fromConnection(conn, {
  refreshToken: () => fetch(`/api/sandboxes/${conn.sandboxId}/token`).then((r) => r.json()),
});
```

## Errors

Every error is a `PyoSandboxError` with a plain message:

```ts
try {
  await sbx.files.read("/missing");
} catch (e) {
  if (e instanceof PyoSandboxError) {
    e.source;  // "pyo", "server", "sandbox" or "client"
    e.code;    // "notFound", "forbidden", "permissionDenied", "conflict", "unsupported", "noCapacity"…
    e.status;  // the HTTP status, when there was one
  }
}
```

`forbidden` from the sandbox server means the token doesn't allow the call. `permissionDenied` means the sandbox itself refused, like a file its user can't read, so a new token won't help.

## Tools for AI agents

Ready-made tools let a model use a sandbox: `exec`, `read_file`, `write_file`, `list_files` and `open_port`. Neither the Anthropic SDK nor the AI SDK is a dependency.

### Claude API

`pyoSandboxTools` gives tool definitions in the Messages API shape and runs the `tool_use` blocks Claude sends back. Pass a sandbox, or a function that makes one on the first tool call.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox, pyoSandboxTools } from "@pyodev/sandbox";

const client = new Anthropic();
let sbx: Sandbox | undefined;
const toolkit = pyoSandboxTools(async () => (sbx ??= await Sandbox.create({ template: "node-22", ttl: "30m" })));

const messages: Anthropic.MessageParam[] = [
  { role: "user", content: "Write a Node script that prints the first 20 primes, run it and tell me the output." },
];

try {
  while (true) {
    const res = await client.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      tools: toolkit.tools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });
    if (res.stop_reason === "pause_turn") continue;
    if (res.stop_reason !== "tool_use") {
      for (const b of res.content) if (b.type === "text") console.log(b.text);
      break;
    }
    // Every tool call at once, and all results back in one message.
    messages.push({ role: "user", content: await toolkit.handleAll(res.content) });
  }
} finally {
  await sbx?.delete();
}
```

`toolkit.handle(block)` runs one call. A failed tool comes back as a `tool_result` with `is_error: true`, so the model can see what went wrong and try again. Options: `include` picks the tools, `maxOutputChars`, `maxFileChars` and `maxTimeoutMs` keep results small. [examples/claude-agent.ts](examples/claude-agent.ts) adds refusal fallbacks and a turn limit.

### Vercel AI SDK

```ts
import { anthropic } from "@ai-sdk/anthropic";
import { generateText, jsonSchema, stepCountIs } from "ai";
import { Sandbox, pyoSandboxAiTools } from "@pyodev/sandbox";

const sbx = await Sandbox.create({ template: "python-3.13" });
const { text } = await generateText({
  model: anthropic("claude-opus-5-5"),
  tools: pyoSandboxAiTools(sbx, { jsonSchema }),
  stopWhen: stepCountIs(20),
  prompt: "How many lines does /etc/passwd have in the sandbox?",
});
```

Pass the AI SDK's own `jsonSchema` helper, since this package doesn't import `ai`. For other frameworks, `sandboxToolSpecs` has the plain names, descriptions and JSON schemas.

## How it talks

- **Pyo** (`/api/v1/sandboxes…`, `Authorization: Bearer pyo_…`): create, connect, list, pause, resume, extend, delete, tokens and ports.
- **The sandbox server** (`connection.url`, `Authorization: Bearer <sandbox token>`): plain `exec` and files over HTTP under `/v1/sandboxes/{id}`.
- **The sandbox's WebSocket** (`/v1/sandboxes/{id}/connect`): streaming commands, `spawn`, terminals and port connections. The token goes as the subprotocol `pyo.token.<token>`, next to `pyo`, so it stays out of URLs. A refused connection closes with code 4000 plus the HTTP status (4401, 4403…) and the reason. A terminal keeps working after its token runs out. It speaks envd's frame format, one frame per binary message: `[len u32 BE][kind u8][stream u32 BE][payload]`. envd sends `Hello` on stream 0 first, and the SDK picks the newest protocol version both sides speak. Each command gets its own WebSocket, closed when it ends. The codec is exported as `wire` for other tools.

## Development

```sh
bun install
npm run typecheck
npm test            # vitest, against a mock Pyo and a mock sandbox server
npm run test:bun    # the same tests under Bun
npm run build       # ESM, CJS and types in dist/
```

The mock sandbox server speaks the real frame format and runs commands as real processes.

`npm run test:e2e` runs the SDK against a real `pyo-sandbox` daemon that boots a Firecracker microVM on this machine, without root. It needs a `/dev/kvm` you can open and the daemon, `pyo-envd`, Firecracker and a guest kernel from a pyo-sandbox checkout (see the top of [test/e2e.test.ts](test/e2e.test.ts)). It skips when any of them is missing.

## License

Apache-2.0, like Pyo.
