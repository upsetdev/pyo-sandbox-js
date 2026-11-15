// The short example from the plan. Needs PYO_URL, PYO_API_KEY and PYO_TEAM.
import { PyoSandboxError, Sandbox } from "@pyo/sandbox";

const sbx = await Sandbox.create({ template: "node-22", ttl: "1h" });
const out = await sbx.exec("node -v");
console.log(out.stdout);

await sbx.files.write("/app/index.js", "console.log('hi')");
console.log((await sbx.exec("node /app/index.js")).stdout);

try {
  const url = await sbx.ports.open(3000);
  console.log(url);
} catch (e) {
  // Pyo can't open ports to the outside until the sandbox servers' HTTPS proxy ships.
  if (e instanceof PyoSandboxError && e.code === "unsupported") console.log(e.message);
  else throw e;
}

await sbx.pause();
await sbx.delete();
