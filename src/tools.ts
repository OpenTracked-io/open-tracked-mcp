import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { createErrorResponse, getTagManagerClient, log, GtmToolContext } from "google-tag-manager-mcp-core";
import { OpenTrackedClient } from "./openTracked.js";
import { installPack, workspaceApi } from "./install.js";

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/** Keys that must not travel into an AI conversation: the container's own API key and billing ids. */
const SECRET = new Set(["api_key", "paddle_subscription_id", "paddle_customer_id", "settings"]);
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([k]) => !SECRET.has(k)).map(([k, v]) => [k, redact(v)]));
  return value;
}

const ContainerId = z.number().int().positive().describe("The Open Tracked container id (the number in its address).");

export const PackOptions = z.object({
  platform: z.enum(["wordpress", "shopify", "other"]).describe("The shop's platform."),
  site_type: z.enum(["woocommerce", "lead"]).optional().describe("WordPress only. 'woocommerce' builds shopping tags, 'lead' builds form, chat and booking tags."),
  destinations: z.array(z.enum(["ga4", "google_ads", "meta", "tiktok", "open_tracked"])).describe("Where to send data. GA4 is always included."),
  ga4_id: z.string().optional().describe("GA4 Measurement ID, e.g. G-ABCD1234."),
  meta_pixel_id: z.string().optional(),
  meta_token: z.string().optional().describe("Meta Conversions API access token."),
  meta_test_code: z.string().optional(),
  tiktok_pixel_id: z.string().optional(),
  tiktok_token: z.string().optional().describe("TikTok Events API access token."),
  tiktok_test_code: z.string().optional(),
  gads_id: z.string().optional().describe("Google Ads Conversion ID (digits)."),
  gads_labels: z.object({ purchase: z.string().optional(), begin_checkout: z.string().optional(), add_to_cart: z.string().optional(), lead: z.string().optional() }).optional(),
  server_host: z.string().optional().describe("The tagging server address (one of the container's domains). Defaults to its first verified domain, else its default address."),
  consent: z.boolean().optional().describe("Does the site use a consent banner?"),
  enrich: z.boolean().optional().describe("Add country, city, device, browser and ad blocker to every event on the server (default true)."),
});

/** Tools that talk to the Open Tracked app. They need only OPEN_TRACKED_TOKEN. */
export function platformTools(ot: OpenTrackedClient) {
  return (server: McpServer): void => {
    const run = async (name: string, fn: () => Promise<unknown>) => {
      log(`Running tool: ${name}`);
      try {
        return text(await fn());
      } catch (e) {
        return createErrorResponse(`Error in ${name}`, e);
      }
    };

    server.registerTool(
      "open_tracked_containers",
      {
        description: "Your Open Tracked containers: 'list' them all, or 'get' one with its domains.",
        inputSchema: z.object({ action: z.enum(["list", "get"]), containerId: ContainerId.optional() }),
      },
      ({ action, containerId }) =>
        run("open_tracked_containers", () => {
          if (action === "get") {
            if (!containerId) throw new Error("containerId is required for 'get'.");
            return ot.get(`/containers/${containerId}`).then(redact);
          }
          return ot.get("/containers").then(redact);
        }),
    );

    server.registerTool(
      "open_tracked_domains",
      {
        description:
          "Subdomains of a container: 'list', 'add' (the response says which CNAME records to create), or 'remove'. A domain can belong to one container only.",
        inputSchema: z.object({
          action: z.enum(["list", "add", "remove"]),
          containerId: ContainerId,
          domain: z.string().optional().describe("For 'add', e.g. open.myshop.com."),
          domainId: z.number().int().optional().describe("For 'remove'."),
        }),
      },
      ({ action, containerId, domain, domainId }) =>
        run("open_tracked_domains", () => {
          if (action === "add") {
            if (!domain) throw new Error("domain is required for 'add'.");
            return ot.post(`/containers/${containerId}/domains`, { domain });
          }
          if (action === "remove") {
            if (!domainId) throw new Error("domainId is required for 'remove'.");
            return ot.delete(`/containers/${containerId}/domains/${domainId}`);
          }
          return ot.get(`/containers/${containerId}/domains`);
        }),
    );

    server.registerTool(
      "open_tracked_tracking_score",
      {
        description: "The container's tracking score (0 to 100) and the checks behind it: server running, own subdomain, CDN, Custom Loader, Cookie Keeper, events arriving.",
        inputSchema: z.object({ containerId: ContainerId }),
      },
      ({ containerId }) => run("open_tracked_tracking_score", () => ot.get(`/containers/${containerId}/tracking-score`)),
    );

    server.registerTool(
      "open_tracked_power_ups",
      {
        description: "Power-Ups of a container: 'list' which are on, or 'toggle' one (key such as geo_headers, user_agent_info, ad_blocker_info, user_id, custom_loader, cookie_keeper).",
        inputSchema: z.object({ action: z.enum(["list", "toggle"]), containerId: ContainerId, key: z.string().regex(/^[a-z_]+$/).optional() }),
      },
      ({ action, containerId, key }) =>
        run("open_tracked_power_ups", () => {
          if (action === "toggle") {
            if (!key) throw new Error("key is required for 'toggle'.");
            return ot.post(`/containers/${containerId}/power-ups/${key}/toggle`);
          }
          return ot.get(`/containers/${containerId}/power-ups`);
        }),
    );

    server.registerTool(
      "open_tracked_gtm_pack",
      {
        description:
          "Build the two Google Tag Manager containers (web and server) for a shop, the same ones the Setup wizard gives. Returns a summary. With outputDir (an absolute folder) the two JSON files are written there, ready for Admin > Import Container.",
        inputSchema: z.object({ containerId: ContainerId, options: PackOptions, outputDir: z.string().optional().describe("Absolute path of a folder to write the two files into.") }),
      },
      ({ containerId, options, outputDir }) =>
        run("open_tracked_gtm_pack", async () => {
          const pack = await ot.post(`/containers/${containerId}/gtm-pack`, options);
          const summary = describe(pack);
          if (outputDir) {
            if (!isAbsolute(outputDir)) throw new Error("outputDir must be an absolute path.");
            await mkdir(outputDir, { recursive: true });
            await writeFile(join(outputDir, "Open Tracked - Web (GTM).json"), JSON.stringify(pack.web, null, 2));
            await writeFile(join(outputDir, "Open Tracked - Server (GTM).json"), JSON.stringify(pack.server, null, 2));
            return { ...summary, written_to: outputDir };
          }
          return summary;
        }),
    );
  };
}

function describe(pack: any) {
  const count = (c: any) => {
    const v = c.containerVersion;
    return { tags: v.tag.length, triggers: v.trigger.length, variables: v.variable.length, templates: v.customTemplate.length, clients: v.client?.length ?? 0, transformations: v.transformation?.length ?? 0 };
  };
  return { tagging_server_url: pack.tagging_server_url, options: pack.options, web: count(pack.web), server: count(pack.server) };
}

/** Builds the pack and installs it into Tag Manager. Needs the Open Tracked token and Google credentials. */
export function installTool(ot: OpenTrackedClient) {
  return (server: McpServer, { auth }: GtmToolContext): void => {
    server.registerTool(
      "open_tracked_install_gtm_pack",
      {
        description:
          "Build the Open Tracked containers for a shop and put them straight into Google Tag Manager: a NEW workspace in your web container and one in your server container, so nothing existing is touched. Nothing is published: review the workspaces in Tag Manager, then publish. Names that already exist in the workspace are skipped, so it is safe to run twice. It can take a few minutes: Tag Manager limits how fast it accepts changes. Use dryRun to see what it would do.",
        inputSchema: z.object({
          containerId: ContainerId,
          gtm: z.object({
            accountId: z.string().describe("The Tag Manager account id."),
            webContainerId: z.string().describe("The numeric id of the WEB container (not GTM-XXXX)."),
            serverContainerId: z.string().describe("The numeric id of the SERVER container (not GTM-XXXX)."),
          }),
          options: PackOptions,
          workspaceName: z.string().max(60).optional().describe("Defaults to 'Open Tracked setup' and the date."),
          dryRun: z.boolean().optional().describe("Only build and describe, change nothing."),
        }),
      },
      async ({ containerId, gtm, options, workspaceName, dryRun }) => {
        log("Running tool: open_tracked_install_gtm_pack");
        try {
          const pack = await ot.post(`/containers/${containerId}/gtm-pack`, options);
          if (dryRun) return text({ dry_run: true, ...describe(pack) });

          const tagmanager: any = await getTagManagerClient(auth);
          const name = workspaceName ?? `Open Tracked setup ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
          const out: Record<string, unknown> = { tagging_server_url: pack.tagging_server_url };

          for (const [label, containerNumericId, file] of [["web", gtm.webContainerId, pack.web], ["server", gtm.serverContainerId, pack.server]] as const) {
            const containerPath = `accounts/${gtm.accountId}/containers/${containerNumericId}`;
            const container = (await tagmanager.accounts.containers.get({ path: containerPath })).data;
            const want = label === "web" ? "web" : "server";
            if (!(container.usageContext ?? []).includes(want)) {
              throw new Error(`Container ${containerNumericId} is a ${(container.usageContext ?? []).join(", ") || "unknown"} container, but the ${label} file needs a ${want.toUpperCase()} one.`);
            }
            const ws = (await tagmanager.accounts.containers.workspaces.create({ parent: containerPath, requestBody: { name, description: "Created by the Open Tracked MCP server" } })).data;
            const steps: string[] = [];
            const report = await installPack(workspaceApi(tagmanager, ws.path), file, { containerId: containerNumericId, onProgress: (m) => steps.push(m) });
            out[label] = {
              container: container.name,
              workspace: ws.name,
              open: `https://tagmanager.google.com/#/container/${containerPath}/workspaces/${ws.workspaceId}`,
              created: report.created,
              skipped: report.skipped.length,
              failed: report.failed,
            };
          }
          return text(out);
        } catch (e) {
          return createErrorResponse("Error installing the Open Tracked pack", e);
        }
      },
    );
  };
}
