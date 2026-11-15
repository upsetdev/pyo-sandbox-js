// The same tools with the Vercel AI SDK.
// Needs ANTHROPIC_API_KEY, PYO_URL, PYO_API_KEY and PYO_TEAM.
import { anthropic } from "@ai-sdk/anthropic";
import { Sandbox, pyoSandboxAiTools } from "@pyodev/sandbox";
import { generateText, jsonSchema, stepCountIs } from "ai";

const sbx = await Sandbox.create({ template: "python-3.13", ttl: "15m" });
try {
  const { text } = await generateText({
    model: anthropic("claude-opus-5-5"),
    tools: pyoSandboxAiTools(sbx, { jsonSchema }),
    stopWhen: stepCountIs(20),
    prompt: "How many lines does /etc/passwd have in the sandbox? Use the tools.",
  });
  console.log(text);
} finally {
  await sbx.delete();
}
