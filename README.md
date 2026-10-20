# Open Tracked MCP

An MCP server that lets an AI assistant (Claude Desktop, Claude Code, Cursor ...) work on your **Open Tracked** containers and your **Google Tag Manager**, with your own credentials. It runs on your computer.

## What it can do

| Tool | What it does |
| --- | --- |
| `open_tracked_containers` | List your containers, or get one with its domains. |
| `open_tracked_domains` | List, add or remove subdomains. |
| `open_tracked_tracking_score` | The container's 0 to 100 score and the checks behind it. |
| `open_tracked_power_ups` | See which Power-Ups are on, switch one. |
| `open_tracked_gtm_pack` | Build the web and server GTM containers for a shop (the same as the Setup wizard). Optionally write the two JSON files to a folder. |
| `open_tracked_install_gtm_pack` | Build them **and put them into Tag Manager**: a new workspace in your web container and one in your server container. Nothing is published. |
| `gtm_*` (20 tools) | Everything in the Tag Manager API: accounts, containers, workspaces, tags, triggers, variables, templates, clients, transformations, versions, publishing ... |

The Tag Manager tools and the install tool appear only when Google credentials are set. Without them the five Open Tracked tools still work.

## Set up

1. In Open Tracked open **Settings, MCP** and create a token. It is shown once.
2. Build this server once:

   ```bash
   npm install && npm run build
   ```

3. Add it to your client. Claude Desktop (Settings, Developer, Edit Config):

   ```json
   {
     "mcpServers": {
       "open-tracked": {
         "command": "node",
         "args": ["/path/to/open-tracked-mcp/dist/index.js"],
         "env": {
           "OPEN_TRACKED_URL": "https://app.opentracked.io",
           "OPEN_TRACKED_TOKEN": "your token",
           "GOOGLE_SERVICE_ACCOUNT_KEY": "{ ...service account key JSON... }"
         }
       }
     }
   }
   ```

   Claude Code: `claude mcp add open-tracked -e OPEN_TRACKED_TOKEN=... -e GOOGLE_SERVICE_ACCOUNT_KEY=... -- node /path/to/open-tracked-mcp/dist/index.js`

### Google credentials (for the Tag Manager tools)

Set one of these (the same options as the Tag Manager core package):

- `GOOGLE_SERVICE_ACCOUNT_KEY` (service account key JSON), or `GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`
- `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` + `GOOGLE_REFRESH_TOKEN`
- `GOOGLE_ACCESS_TOKEN` (short lived, for trying it out)

A service account has to be added as a user (Edit containers or more) in your Tag Manager account, web and server container both, and the Tag Manager API must be enabled in its Google Cloud project.

## How the install works

Tag Manager's API has no "import container" call, so the install tool does what Admin, Import Container does: it creates the templates, the variables (in dependency order), triggers, clients, tags and transformations in a **new workspace**, and swaps the ids that change on the way (custom template types and trigger ids).

- Nothing existing is touched and nothing is published. Open the workspace link it returns, look, then publish.
- A name that is already in the workspace is skipped, so running it twice is safe.
- Tag Manager allows only a few changes per minute. The tool slows down and retries, so a full pack takes a few minutes.
- `dryRun: true` builds and describes without changing anything.

## Safety

- The token only reaches your own containers. Another user's container answers "not found".
- The container's own API key and billing ids are never passed to the assistant.
- Meta and TikTok tokens you give to the pack tools are used to build the files and are not stored by Open Tracked.

## Development

```bash
npm test          # unit tests (installer, API client)
npm run build
node test/smoke.mjs            # starts the built server over stdio and lists its tools
OPEN_TRACKED_TOKEN=... node test/e2e.mjs http://127.0.0.1:8012 <containerId>
```

## Licence

Apache 2.0. The Tag Manager tools come from [`google-tag-manager-mcp-core`](https://github.com/stape-io/google-tag-manager-mcp-server) (Apache 2.0), used unchanged. See `NOTICE`.
