/**
 * Ready-made tools that let a model use a sandbox: run commands, read and
 * write files, list directories and open ports. One set of definitions,
 * two shapes: the Claude Messages API (`tool_use`) and the Vercel AI SDK.
 * Neither SDK is a dependency.
 */
import { PyoSandboxError } from "./errors.js";
import type { Sandbox } from "./sandbox.js";

export type ToolName = "exec" | "read_file" | "write_file" | "list_files" | "open_port";

/** A JSON Schema object, as both SDKs take it. */
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
  [key: string]: unknown;
}

interface Spec {
  name: ToolName;
  description: string;
  schema: JsonSchemaObject;
  run(sbx: Sandbox, input: Record<string, unknown>, o: Required<ToolOptions>): Promise<unknown>;
}

export interface ToolOptions {
  /** Only these tools. All of them by default. */
  include?: ToolName[];
  /** Command output kept per stream for the model, from the end. 20,000 characters by default. */
  maxOutputChars?: number;
  /** File text kept for the model. 50,000 characters by default. */
  maxFileChars?: number;
  /** The longest a command may run. 120 seconds by default. */
  maxTimeoutMs?: number;
}

function str(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || v === "") throw new ToolInputError(`"${key}" must be a non-empty string.`);
  return v;
}

function optNum(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ToolInputError(`"${key}" must be a number.`);
  return v;
}

class ToolInputError extends Error {}

/** Keeps the end of long output, where errors usually are. */
function tail(s: string, max: number): string {
  if (s.length <= max) return s;
  return `[${s.length - max} earlier characters cut]\n${s.slice(-max)}`;
}

const specs: Spec[] = [
  {
    name: "exec",
    description:
      "Run a shell command in the sandbox, an isolated Linux machine, and wait for it. " +
      "Runs with /bin/sh -c. Returns the exit code, stdout and stderr. Files and background processes stay between calls.",
    schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command, like \"ls -la\" or \"npm test\"." },
        cwd: { type: "string", description: "The directory to run it in. The home directory when left out." },
        timeout_ms: { type: "integer", description: "Kill the command after this many milliseconds. 60000 when left out." },
      },
      required: ["command"],
      additionalProperties: false,
    },
    async run(sbx, input, o) {
      const timeout = Math.min(optNum(input, "timeout_ms") ?? 60_000, o.maxTimeoutMs);
      const cwd = input.cwd;
      const r = await sbx.exec(str(input, "command"), {
        ...(typeof cwd === "string" && cwd ? { cwd } : {}),
        timeoutMs: timeout,
      });
      return {
        exitCode: r.exitCode,
        ...(r.signal === undefined ? {} : { signal: r.signal }),
        ...(r.timedOut ? { timedOut: true } : {}),
        stdout: tail(r.stdout, o.maxOutputChars),
        stderr: tail(r.stderr, o.maxOutputChars),
      };
    },
  },
  {
    name: "read_file",
    description: "Read a text file from the sandbox.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "The file's path, like /app/index.js." } },
      required: ["path"],
      additionalProperties: false,
    },
    async run(sbx, input, o) {
      const text = await sbx.files.read(str(input, "path"));
      if (text.length <= o.maxFileChars) return { content: text };
      return { content: text.slice(0, o.maxFileChars), truncated: true, totalChars: text.length };
    },
  },
  {
    name: "write_file",
    description: "Write a text file in the sandbox, replacing it if it exists. Makes missing parent directories.",
    schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file's path, like /app/index.js." },
        content: { type: "string", description: "The whole new content of the file." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    async run(sbx, input) {
      const path = str(input, "path");
      const content = input.content;
      if (typeof content !== "string") throw new ToolInputError('"content" must be a string.');
      const dir = path.replace(/\/[^/]*$/, "");
      if (dir && dir !== path) await sbx.files.mkdir(dir);
      const r = await sbx.files.write(path, content);
      return { path, bytes: r.bytes };
    },
  },
  {
    name: "list_files",
    description: "List a directory in the sandbox: names, kinds and sizes.",
    schema: {
      type: "object",
      properties: { path: { type: "string", description: "The directory, like /app." } },
      required: ["path"],
      additionalProperties: false,
    },
    async run(sbx, input) {
      const entries = await sbx.files.list(str(input, "path"));
      return { entries: entries.map((e) => ({ name: e.name, kind: e.kind, size: e.size })) };
    },
  },
  {
    name: "open_port",
    description: "Get a public URL for a port a server in the sandbox listens on, to share a preview.",
    schema: {
      type: "object",
      properties: { port: { type: "integer", minimum: 1, maximum: 65535, description: "The port, like 3000." } },
      required: ["port"],
      additionalProperties: false,
    },
    async run(sbx, input) {
      const port = optNum(input, "port");
      if (port === undefined) throw new ToolInputError('"port" is needed.');
      return { url: await sbx.ports.open(port) };
    },
  },
];

/** A sandbox, or a function that makes one on the first tool call. */
export type SandboxSource = Sandbox | (() => Promise<Sandbox>);

function resolver(source: SandboxSource): () => Promise<Sandbox> {
  if (typeof source !== "function") return () => Promise.resolve(source);
  let p: Promise<Sandbox> | undefined;
  return () => {
    p ??= source().catch((e: unknown) => {
      p = undefined;
      throw e;
    });
    return p;
  };
}

function options(o: ToolOptions = {}): Required<ToolOptions> {
  return {
    include: o.include ?? specs.map((s) => s.name),
    maxOutputChars: o.maxOutputChars ?? 20_000,
    maxFileChars: o.maxFileChars ?? 50_000,
    maxTimeoutMs: o.maxTimeoutMs ?? 120_000,
  };
}

function errorText(e: unknown): string {
  if (e instanceof PyoSandboxError || e instanceof ToolInputError) return e.message;
  return e instanceof Error ? e.message : String(e);
}

// ── Claude Messages API ────────────────────────────────────────────────────

/** A tool definition in the Messages API shape. Assignable to `Anthropic.Tool`. */
export interface ClaudeTool {
  name: string;
  description: string;
  input_schema: JsonSchemaObject;
}

/** The parts of a `tool_use` block the toolkit reads. `Anthropic.ToolUseBlock` fits. */
export interface ToolUseLike {
  type?: string;
  id: string;
  name: string;
  input: unknown;
}

/** A `tool_result` block. Assignable to `Anthropic.ToolResultBlockParam`. */
export interface ClaudeToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface ClaudeToolkit {
  /** Pass these as `tools` to `messages.create`. */
  tools: ClaudeTool[];
  /** Whether a tool name is one of these. */
  has(name: string): boolean;
  /** Runs one tool and returns its result for the model. Never throws: failures come back with `is_error`. */
  handle(block: ToolUseLike): Promise<ClaudeToolResult>;
  /**
   * Runs every one of these tools in an assistant message's content, at
   * once, and returns their results in order. Send them back together in
   * one user message.
   */
  handleAll(content: readonly unknown[]): Promise<ClaudeToolResult[]>;
}

/**
 * Sandbox tools for the Claude Messages API.
 *
 * ```ts
 * const toolkit = pyoSandboxTools(sbx);
 * const res = await client.messages.create({ model: "claude-opus-5-5", tools: toolkit.tools, ... });
 * const results = await toolkit.handleAll(res.content);
 * ```
 */
export function pyoSandboxTools(sandbox: SandboxSource, opts?: ToolOptions): ClaudeToolkit {
  const o = options(opts);
  const get = resolver(sandbox);
  const chosen = specs.filter((s) => o.include.includes(s.name));
  const byName = new Map(chosen.map((s) => [s.name as string, s]));
  const handle = async (block: ToolUseLike): Promise<ClaudeToolResult> => {
    const spec = byName.get(block.name);
    const base = { type: "tool_result" as const, tool_use_id: block.id };
    if (!spec) return { ...base, content: `There is no tool ${block.name}.`, is_error: true };
    try {
      const input = (block.input ?? {}) as Record<string, unknown>;
      if (typeof input !== "object" || Array.isArray(input)) throw new ToolInputError("The input must be an object.");
      const out = await spec.run(await get(), input, o);
      return { ...base, content: JSON.stringify(out) };
    } catch (e) {
      return { ...base, content: errorText(e), is_error: true };
    }
  };
  return {
    tools: chosen.map((s) => ({ name: s.name, description: s.description, input_schema: s.schema })),
    has: (name) => byName.has(name),
    handle,
    handleAll: (content) =>
      Promise.all(
        content
          .filter((b): b is ToolUseLike => {
            const x = b as Partial<ToolUseLike> | null;
            return !!x && x.type === "tool_use" && typeof x.name === "string" && byName.has(x.name);
          })
          .map(handle),
      ),
  };
}

// ── Vercel AI SDK ──────────────────────────────────────────────────────────

/** A tool in the AI SDK shape. Fits the `tools` record of `generateText` and `streamText`. */
export interface AiSdkTool<S = unknown> {
  description: string;
  /** AI SDK 5 and later. */
  inputSchema: S;
  /** AI SDK 4. */
  parameters: S;
  execute(input: Record<string, unknown>): Promise<unknown>;
}

export interface AiToolOptions<S> extends ToolOptions {
  /**
   * The AI SDK's `jsonSchema` helper: `import { jsonSchema } from "ai"`.
   * The SDK doesn't import `ai` itself, so pass it in.
   */
  jsonSchema: (schema: JsonSchemaObject) => S;
}

/**
 * Sandbox tools for the Vercel AI SDK.
 *
 * ```ts
 * import { generateText, jsonSchema, stepCountIs } from "ai";
 * const tools = pyoSandboxAiTools(sbx, { jsonSchema });
 * await generateText({ model, tools, stopWhen: stepCountIs(20), prompt });
 * ```
 *
 * A failed tool throws, and the AI SDK reports it to the model.
 */
export function pyoSandboxAiTools<S>(sandbox: SandboxSource, opts: AiToolOptions<S>): Record<string, AiSdkTool<S>> {
  const o = options(opts);
  const get = resolver(sandbox);
  const out: Record<string, AiSdkTool<S>> = {};
  for (const s of specs) {
    if (!o.include.includes(s.name)) continue;
    const schema = opts.jsonSchema(s.schema);
    out[s.name] = {
      description: s.description,
      inputSchema: schema,
      parameters: schema,
      execute: async (input) => s.run(await get(), input ?? {}, o),
    };
  }
  return out;
}

/** The raw definitions, for other agent frameworks. */
export const sandboxToolSpecs: ReadonlyArray<{ name: ToolName; description: string; schema: JsonSchemaObject }> = specs.map(
  ({ name, description, schema }) => ({ name, description, schema }),
);
