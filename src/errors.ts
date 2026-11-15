/**
 * Where an error came from:
 *
 * - `pyo`: the Pyo API (create, lifecycle, tokens, ports).
 * - `server`: the sandbox server's daemon (exec, files, the WebSocket).
 * - `sandbox`: envd inside the sandbox (a missing file, a busy stream).
 * - `client`: this SDK (bad options, no WebSocket, a timeout).
 */
export type ErrorSource = "pyo" | "server" | "sandbox" | "client";

export interface PyoSandboxErrorInit {
  source: ErrorSource;
  /** A short machine-readable code, like `notFound`, `forbidden` or `unsupported`. */
  code: string;
  /** The HTTP status, when the error came from an HTTP answer. */
  status?: number;
  /** Seconds to wait before trying again, when Pyo says so. */
  retryAfter?: number;
  cause?: unknown;
}

/** Every error the SDK throws. The message is fit to show a user. */
export class PyoSandboxError extends Error {
  readonly source: ErrorSource;
  readonly code: string;
  readonly status?: number;
  readonly retryAfter?: number;

  constructor(message: string, init: PyoSandboxErrorInit) {
    super(message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "PyoSandboxError";
    this.source = init.source;
    this.code = init.code;
    this.status = init.status;
    this.retryAfter = init.retryAfter;
  }
}

/** A code for a Pyo API status, since Pyo's errors carry only a message. */
export function codeForStatus(status: number): string {
  switch (status) {
    case 400:
      return "invalidRequest";
    case 401:
      return "unauthorized";
    case 403:
      return "forbidden";
    case 404:
      return "notFound";
    case 405:
      return "unsupported";
    case 409:
      return "conflict";
    case 422:
      return "invalidSpec";
    case 429:
      return "rateLimited";
    case 501:
      return "unsupported";
    case 503:
      return "noCapacity";
    default:
      return status >= 500 ? "internal" : "error";
  }
}

export function clientError(message: string, code = "client", cause?: unknown): PyoSandboxError {
  return new PyoSandboxError(message, { source: "client", code, cause });
}
