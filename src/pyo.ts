import { PyoSandboxError, clientError, codeForStatus } from "./errors.js";
import type { ClientOptions, Connection, SandboxInfo, SandboxServerInfo, Ttl } from "./types.js";

function env(name: string): string | undefined {
  // `process` is missing in browsers and some edge runtimes.
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  const v = p?.env?.[name];
  return v === undefined || v === "" ? undefined : v;
}

export function envTeam(): string | undefined {
  return env("PYO_TEAM");
}

/** `https://pyo.example.com` or `.../api/v1`, either way, to the API base. */
export function apiBase(url: string): string {
  let u = url.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(u)) u = `https://${u}`;
  if (!u.endsWith("/api/v1")) u += "/api/v1";
  return u;
}

/** The Pyo API calls the SDK makes. Exec, files and ports never go through Pyo. */
export class PyoApi {
  readonly base: string;
  private readonly key: string;
  private readonly fetch: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    const url = opts.baseUrl ?? env("PYO_URL");
    const key = opts.apiKey ?? env("PYO_API_KEY") ?? env("PYO_TOKEN");
    if (!url) throw clientError("Set PYO_URL or pass baseUrl: the address of your Pyo.", "missingBaseUrl");
    if (!key) throw clientError("Set PYO_API_KEY or pass apiKey: a Pyo API key with sandbox access.", "missingApiKey");
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw clientError("This runtime has no fetch. Pass one in the options.", "noFetch");
    this.base = apiBase(url);
    this.key = key;
    this.fetch = f.bind(globalThis);
  }

  async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetch(this.base + path, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`,
          accept: "application/json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new PyoSandboxError(`Couldn't reach Pyo at ${this.base}: ${(e as Error).message}`, {
        source: "pyo",
        code: "unreachable",
        cause: e,
      });
    }
    const text = await res.text();
    if (!res.ok) throw pyoError(res, text);
    if (text === "") return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new PyoSandboxError(`Pyo's answer to ${method} ${path} isn't JSON.`, {
        source: "pyo",
        code: "badResponse",
        status: res.status,
        cause: e,
      });
    }
  }

  create(body: Record<string, unknown>): Promise<{ sandbox: SandboxInfo; connection: Connection }> {
    return this.call("POST", "/sandboxes", body);
  }

  get(id: string): Promise<SandboxInfo> {
    return this.call("GET", `/sandboxes/${encodeURIComponent(id)}`);
  }

  list(teamId: string, state?: "live" | "all"): Promise<{ sandboxes: SandboxInfo[] }> {
    const q = new URLSearchParams({ team: teamId });
    if (state) q.set("state", state);
    return this.call("GET", `/sandboxes?${q}`);
  }

  async servers(teamId: string): Promise<SandboxServerInfo[]> {
    const r = await this.call<{ servers: Array<SandboxServerInfo & { capability?: unknown }> }>(
      "GET",
      `/sandbox-servers?${new URLSearchParams({ team: teamId })}`,
    );
    // The full capability report stays out: `runtime` and `summary` say it.
    return r.servers.map(({ capability: _, ...s }) => s);
  }

  token(id: string): Promise<Connection> {
    return this.call("POST", `/sandboxes/${encodeURIComponent(id)}/token`);
  }

  pause(id: string): Promise<SandboxInfo> {
    return this.call("POST", `/sandboxes/${encodeURIComponent(id)}/pause`);
  }

  resume(id: string): Promise<SandboxInfo> {
    return this.call("POST", `/sandboxes/${encodeURIComponent(id)}/resume`);
  }

  extend(id: string, ttl: Ttl): Promise<SandboxInfo> {
    return this.call("POST", `/sandboxes/${encodeURIComponent(id)}/extend`, { ttl });
  }

  rename(id: string, name: string): Promise<SandboxInfo> {
    return this.call("PATCH", `/sandboxes/${encodeURIComponent(id)}`, { name });
  }

  delete(id: string): Promise<SandboxInfo> {
    return this.call("DELETE", `/sandboxes/${encodeURIComponent(id)}`);
  }

  openPort(id: string, port: number, isPublic = true): Promise<{ url: string; port: number; public: boolean }> {
    return this.call("POST", `/sandboxes/${encodeURIComponent(id)}/ports`, { port, public: isPublic });
  }
}

function pyoError(res: Response, text: string): PyoSandboxError {
  let message = "";
  try {
    const body = JSON.parse(text) as { error?: unknown };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Not JSON: a proxy in between, most likely.
  }
  if (!message) message = `Pyo answered ${res.status}${text ? `: ${text.slice(0, 200)}` : "."}`;
  const ra = Number(res.headers.get("retry-after"));
  return new PyoSandboxError(message, {
    source: "pyo",
    code: codeForStatus(res.status),
    status: res.status,
    retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined,
  });
}

/** Pyo's own answer for a route it doesn't have. */
export function isMissingRoute(e: unknown): boolean {
  return (
    e instanceof PyoSandboxError &&
    e.source === "pyo" &&
    (e.status === 405 || (e.status === 404 && /no such endpoint/i.test(e.message)))
  );
}
