import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox, pyoSandboxAiTools, pyoSandboxTools, type JsonSchemaObject } from "../src/index.js";
import { API_KEY, TEAM, startMocks, type MockPyo } from "./mock.js";

let pyo: MockPyo;
let stop: () => Promise<void>;

beforeAll(async () => {
  ({ pyo, stop } = await startMocks());
});
afterAll(() => stop());

const create = () => Sandbox.create({ apiKey: API_KEY, baseUrl: pyo.url, teamId: TEAM, template: "node-22" });

describe("Claude tools", () => {
  it("define tools in the Messages API shape", () => {
    const { tools } = pyoSandboxTools(() => create());
    expect(tools.map((t) => t.name)).toEqual(["exec", "read_file", "write_file", "list_files", "open_port"]);
    for (const t of tools) {
      expect(Object.keys(t).sort()).toEqual(["description", "input_schema", "name"]);
      expect(t.input_schema.type).toBe("object");
      expect(t.input_schema.additionalProperties).toBe(false);
      expect(t.name).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    }
    expect(pyoSandboxTools(() => create(), { include: ["exec"] }).tools).toHaveLength(1);
  });

  it("run the tool_use blocks of a response and return results in order", async () => {
    let made = 0;
    const toolkit = pyoSandboxTools(() => {
      made++;
      return create();
    });
    const content = [
      { type: "text", text: "Let me write the file." },
      { type: "tool_use", id: "t1", name: "write_file", input: { path: "/w/app/hello.txt", content: "hello" } },
      { type: "tool_use", id: "t2", name: "exec", input: { command: "echo out; echo err >&2; exit 2" } },
      { type: "tool_use", id: "t3", name: "something_else", input: {} },
    ];
    const results = await toolkit.handleAll(content);
    expect(results.map((r) => r.tool_use_id)).toEqual(["t1", "t2"]);
    expect(JSON.parse(results[0]!.content)).toEqual({ path: "/w/app/hello.txt", bytes: 5 });
    expect(JSON.parse(results[1]!.content)).toEqual({ exitCode: 2, stdout: "out\n", stderr: "err\n" });
    expect(made).toBe(1);

    const read = await toolkit.handle({ id: "t4", name: "read_file", input: { path: "/w/app/hello.txt" } });
    expect(JSON.parse(read.content)).toEqual({ content: "hello" });
    const list = await toolkit.handle({ id: "t5", name: "list_files", input: { path: "/w/app" } });
    expect(JSON.parse(list.content)).toEqual({ entries: [{ name: "hello.txt", kind: "file", size: 5 }] });
  });

  it("return failures with is_error instead of throwing", async () => {
    const sbx = await create();
    const toolkit = pyoSandboxTools(sbx, { maxOutputChars: 10 });
    const missing = await toolkit.handle({ id: "a", name: "read_file", input: { path: "/missing" } });
    expect(missing.is_error).toBe(true);
    const port = await toolkit.handle({ id: "b", name: "open_port", input: { port: 3000 } });
    expect(port).toMatchObject({ is_error: true });
    expect(port.content).toMatch(/can't open sandbox ports/);
    const bad = await toolkit.handle({ id: "c", name: "exec", input: { command: 5 } });
    expect(bad).toEqual({ type: "tool_result", tool_use_id: "c", content: '"command" must be a non-empty string.', is_error: true });
    const unknown = await toolkit.handle({ id: "d", name: "nope", input: {} });
    expect(unknown.is_error).toBe(true);
    const long = await toolkit.handle({ id: "e", name: "exec", input: { command: "seq 1 100" } });
    expect(JSON.parse(long.content).stdout).toMatch(/^\[\d+ earlier characters cut\]\n/);
  });
});

describe("AI SDK tools", () => {
  it("wrap the schemas with the given jsonSchema and execute", async () => {
    const seen: JsonSchemaObject[] = [];
    const jsonSchema = (s: JsonSchemaObject) => {
      seen.push(s);
      return { wrapped: s };
    };
    const tools = pyoSandboxAiTools(() => create(), { jsonSchema });
    expect(Object.keys(tools)).toEqual(["exec", "read_file", "write_file", "list_files", "open_port"]);
    expect(seen).toHaveLength(5);
    expect(tools.exec!.inputSchema).toEqual({ wrapped: seen[0] });
    expect(tools.exec!.parameters).toBe(tools.exec!.inputSchema);
    expect(await tools.exec!.execute({ command: "echo ai" })).toEqual({ exitCode: 0, stdout: "ai\n", stderr: "" });
    await expect(tools.open_port!.execute({ port: 3000 })).rejects.toThrow(/can't open sandbox ports/);
  });
});
