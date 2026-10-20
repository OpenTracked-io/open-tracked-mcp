/** Starts the built server over stdio and lists its tools. Run after `npm run build`. */
import { spawn } from "node:child_process";

const env = { ...process.env, OPEN_TRACKED_TOKEN: "x", ...(process.argv[2] === "google" ? { GOOGLE_ACCESS_TOKEN: "fake" } : { GOOGLE_ACCESS_TOKEN: "", GOOGLE_SERVICE_ACCOUNT_KEY: "", GOOGLE_REFRESH_TOKEN: "", GOOGLE_CLIENT_EMAIL: "" }) };
const child = spawn("node", ["dist/index.js"], { env, stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
const waiting = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.id && waiting.has(m.id)) waiting.get(m.id)(m);
  }
});
const call = (id, method, params) => new Promise((res) => { waiting.set(id, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });

const init = await call(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const list = await call(2, "tools/list", {});
console.log(init.result?.serverInfo, "\n" + list.result.tools.length + " tools");
console.log(list.result.tools.map((t) => t.name).join(", "));
const bad = await call(3, "tools/call", { name: "open_tracked_tracking_score", arguments: { containerId: 1 } });
console.log("call without server ->", JSON.stringify(bad.result?.content?.[0]?.text ?? bad.error).slice(0, 160));
child.kill();
