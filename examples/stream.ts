// Streaming output, a background process, a terminal and a port connection.
import { Sandbox } from "@pyo/sandbox";

const sbx = await Sandbox.create({ template: "node-22" });

// Output arrives as the command writes it.
await sbx.exec("npm install --no-audit", {
  cwd: "/app",
  onStdout: (d) => process.stdout.write(d),
  onStderr: (d) => process.stderr.write(d),
  timeoutMs: 300_000,
});

// A server that keeps running, and a connection to its port through the sandbox server.
const server = await sbx.spawn("node /app/server.js", { onStdout: (d) => console.log("[server]", d.trim()) });
const conn = await sbx.ports.connect(3000, { onData: (d) => process.stdout.write(d) });
conn.write("GET / HTTP/1.0\r\nHost: localhost\r\n\r\n");
conn.end();
await conn.closed;
server.kill();

// A terminal.
const pty = await sbx.pty({ cols: 120, rows: 30, onData: (d) => process.stdout.write(d) });
pty.write("uname -a\r");
pty.write("exit\r");
await pty.wait();

await sbx.delete();
