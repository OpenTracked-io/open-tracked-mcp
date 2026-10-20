/** Talks to a running Open Tracked app through the built MCP server. Usage: node test/e2e.mjs <url> <containerId> (token in OPEN_TRACKED_TOKEN) */
import { spawn } from "node:child_process";
const [url, id] = process.argv.slice(2);
const child = spawn("node", ["dist/index.js"], { env: { ...process.env, OPEN_TRACKED_URL: url, GOOGLE_ACCESS_TOKEN: "fake" }, stdio: ["pipe", "pipe", "ignore"] });
let buf = ""; const waiting = new Map();
child.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) { const m = JSON.parse(l); waiting.get(m.id)?.(m); } } });
let n = 0; const call = (method, params) => new Promise((res) => { const k = ++n; waiting.set(k, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: k, method, params }) + "\n"); });
await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const tool = async (name, args) => { const r = await call("tools/call", { name, arguments: args }); const t = r.result?.content?.[0]?.text ?? JSON.stringify(r.error); return r.result?.isError ? "ERROR " + t : t; };
const show = (label, t) => console.log("\n## " + label + "\n" + t.slice(0, 700));
const cid = Number(id);
show("containers/get", await tool("open_tracked_containers", { action: "get", containerId: cid }));
show("tracking score", await tool("open_tracked_tracking_score", { containerId: cid }));
show("power-ups toggle", await tool("open_tracked_power_ups", { action: "toggle", containerId: cid, key: "geo_headers" }));
show("pack (written to disk)", await tool("open_tracked_gtm_pack", { containerId: cid, outputDir: "/private/tmp/claude-501/-Users-shibbirahmed/0ad85935-77fb-4b43-8528-7887b76922db/scratchpad/mcp-out", options: { platform: "wordpress", site_type: "woocommerce", destinations: ["ga4", "meta", "tiktok"], ga4_id: "G-ABCD1234", meta_pixel_id: "123456789012345", meta_token: "x".repeat(30) } }));
show("install dry run", await tool("open_tracked_install_gtm_pack", { containerId: cid, dryRun: true, gtm: { accountId: "1", webContainerId: "2", serverContainerId: "3" }, options: { platform: "shopify", destinations: ["ga4"] } }));
show("someone else's container", await tool("open_tracked_tracking_score", { containerId: 1 }));
child.kill();
