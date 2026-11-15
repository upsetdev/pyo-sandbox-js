// An agent loop with the Claude API: Claude works in a sandbox through tools.
// Needs ANTHROPIC_API_KEY (or `ant auth login`), PYO_URL, PYO_API_KEY and PYO_TEAM.
import Anthropic from "@anthropic-ai/sdk";
import { Sandbox, pyoSandboxTools } from "@pyo/sandbox";

const client = new Anthropic();

// The sandbox is made on the first tool call, so a reply without tools costs none.
let sbx: Sandbox | undefined;
const toolkit = pyoSandboxTools(async () => (sbx ??= await Sandbox.create({ template: "node-22", ttl: "30m" })));

const messages: Anthropic.Beta.BetaMessageParam[] = [
  { role: "user", content: "Write a Node script that prints the first 20 primes, run it and tell me the output." },
];

try {
  for (let turn = 0; turn < 20; turn++) {
    const res = await client.beta.messages.create({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      output_config: { effort: "high" },
      // If a safety classifier declines, the API retries on a fallback model in the same call.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      tools: toolkit.tools,
      messages,
    });
    messages.push({ role: "assistant", content: res.content });

    if (res.stop_reason === "pause_turn") continue;
    if (res.stop_reason !== "tool_use") {
      for (const block of res.content) if (block.type === "text") console.log(block.text);
      if (res.stop_reason === "refusal") console.log("Claude declined this request.");
      break;
    }

    // Run every tool call at once, and send all results back in one message.
    const results = await toolkit.handleAll(res.content);
    messages.push({ role: "user", content: results });
  }
} finally {
  await sbx?.delete();
}
