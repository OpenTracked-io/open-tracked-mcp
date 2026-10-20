#!/usr/bin/env node
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { AUTH_ENV_HELP, createAuthFromEnv, createGtmMcpServer, resolveAuthMode, setLogSink } from "google-tag-manager-mcp-core";
import { OpenTrackedClient } from "./openTracked.js";
import { installTool, platformTools } from "./tools.js";

const NAME = "open-tracked-mcp";
const VERSION = "0.1.0";

// stdout carries the JSON-RPC stream, so every log line has to go to stderr.
setLogSink((message, ...rest) => console.error(message, ...rest));

function main(): void {
  const env = process.env;
  const ot = new OpenTrackedClient(env.OPEN_TRACKED_URL || "https://app.opentracked.io", env.OPEN_TRACKED_TOKEN);
  const googleConfigured = resolveAuthMode(env) !== "unconfigured";

  // Without Google credentials the Tag Manager tools are left out and only the Open Tracked tools run.
  const auth = googleConfigured
    ? createAuthFromEnv(env)
    : {
        getAccessToken: async (): Promise<string> => {
          throw new Error(AUTH_ENV_HELP);
        },
      };

  serveStdio(
    () =>
      createGtmMcpServer({
        auth,
        serverInfo: { name: NAME, version: VERSION },
        tools: googleConfigured ? undefined : [],
        extraTools: [platformTools(ot), ...(googleConfigured ? [installTool(ot)] : [])],
      }),
    { onerror: (error) => console.error(`[${NAME}] stdio transport error:\n${error.message}`) },
  );

  console.error(
    `[${NAME}] v${VERSION} ready on stdio (Open Tracked: ${ot.configured ? "token set" : "NO TOKEN"}, Google Tag Manager: ${googleConfigured ? resolveAuthMode(env) : "not configured"})`,
  );
}

try {
  main();
} catch (error: unknown) {
  console.error(`[${NAME}] failed to start:\n${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
