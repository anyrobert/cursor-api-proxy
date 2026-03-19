# cursor-api-proxy

OpenAI-compatible proxy for Cursor CLI. Expose Cursor models on localhost so any LLM client (OpenAI SDK, LiteLLM, LangChain, etc.) can call them as a standard chat API.

This package works as **one npm dependency**: use it as an **SDK** in your app to call the proxy API, and/or run the **CLI** to start the proxy server. Core behavior is unchanged.

## Prerequisites (required for the proxy to work)

- **Node.js** 18+
- **Cursor agent CLI** (`agent`). This package does **not** install or bundle the CLI. You must install and set it up separately. This project is developed and tested with `agent` version **2026.02.27-e7d2ef6**.

  ```bash
  curl https://cursor.com/install -fsS | bash
  agent login
  agent --list-models
  ```

  For automation, set `CURSOR_API_KEY` instead of using `agent login`.

## Install

**From npm (use as SDK in another project):**

```bash
npm install cursor-api-proxy
```

**From source (develop or run CLI locally):**

```bash
git clone <this-repo>
cd cursor-api-proxy
npm install
npm run build
```

## Run the proxy (CLI)

Start the server so the API is available (e.g. for the SDK or any HTTP client):

```bash
npx cursor-api-proxy
# or from repo: npm start / node dist/cli.js
```

To expose on your network (e.g. Tailscale):

```bash
npx cursor-api-proxy --tailscale
```

By default the server listens on **http://127.0.0.1:8765**. Optionally set `CURSOR_BRIDGE_API_KEY` to require `Authorization: Bearer <key>` on requests.

### HTTPS with Tailscale (MagicDNS)

To serve over HTTPS so browsers and clients trust the connection (e.g. `https://macbook.tail4048eb.ts.net:8765`):

1. **Generate Tailscale certificates** on this machine (run from the project directory or where you want the cert files):

   ```bash
   sudo tailscale cert macbook.tail4048eb.ts.net
   ```

   This creates `macbook.tail4048eb.ts.net.crt` and `macbook.tail4048eb.ts.net.key` in the current directory.

2. **Run the proxy with TLS** and optional Tailscale bind:

   ```bash
   export CURSOR_BRIDGE_API_KEY=your-secret
   export CURSOR_BRIDGE_TLS_CERT=/path/to/macbook.tail4048eb.ts.net.crt
   export CURSOR_BRIDGE_TLS_KEY=/path/to/macbook.tail4048eb.ts.net.key
   # Bind to Tailscale IP so the service is only on the tailnet (optional):
   export CURSOR_BRIDGE_HOST=100.123.47.103
   npm start
   ```

   Or bind to all interfaces and use HTTPS:

   ```bash
   CURSOR_BRIDGE_TLS_CERT=./macbook.tail4048eb.ts.net.crt \
   CURSOR_BRIDGE_TLS_KEY=./macbook.tail4048eb.ts.net.key \
   CURSOR_BRIDGE_API_KEY=your-secret \
   npm start -- --tailscale
   ```

3. **Access the API** from any device on your tailnet:

   - Base URL: `https://macbook.tail4048eb.ts.net:8765/v1` (use your MagicDNS name and port)
   - Browsers will show a padlock; no certificate warnings when using Tailscale-issued certs.

## Use as SDK in another project

Install the package and ensure the **Cursor agent CLI is installed and set up** (see Prerequisites). When you use the SDK with the default URL, **the proxy starts in the background automatically** if it is not already running. You can still start it yourself with `npx cursor-api-proxy` or set `CURSOR_PROXY_URL` to point at an existing proxy (then the SDK will not start another).

- **Base URL**: `http://127.0.0.1:8765/v1` (override with `CURSOR_PROXY_URL` or options).
- **API key**: Use any value (e.g. `unused`), or set `CURSOR_BRIDGE_API_KEY` and pass it in options or env.
- **Disable auto-start**: Pass `startProxy: false` (or use a custom `baseUrl`) if you run the proxy yourself and don’t want the SDK to start it.
- **Shutdown behavior**: When the SDK starts the proxy, it also stops it automatically when the Node.js process exits or receives normal termination signals. `stopManagedProxy()` is still available if you want to shut it down earlier. `SIGKILL` cannot be intercepted.

### Option A: OpenAI SDK + helper (recommended)

This is an optional consumer-side example. `openai` is not a dependency of `cursor-api-proxy`; install it only in the app where you want to use this example.

```js
import OpenAI from "openai";
import { getOpenAIOptionsAsync } from "cursor-api-proxy";

const opts = await getOpenAIOptionsAsync();  // starts proxy if needed
const client = new OpenAI(opts);

const completion = await client.chat.completions.create({
  model: "gpt-5.2",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(completion.choices[0].message.content);
```

For a sync config without auto-start, use `getOpenAIOptions()` and ensure the proxy is already running.

### Option B: Minimal client (no OpenAI SDK)

```js
import { createCursorProxyClient } from "cursor-api-proxy";

const proxy = createCursorProxyClient();  // proxy starts on first request if needed
const data = await proxy.chatCompletionsCreate({
  model: "auto",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(data.choices?.[0]?.message?.content);
```

### Option C: Raw OpenAI client (no SDK import from this package)

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8765/v1",
  apiKey: process.env.CURSOR_BRIDGE_API_KEY || "unused",
});
// Start the proxy yourself (npx cursor-api-proxy) or use Option A/B for auto-start.
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server and config info |
| GET | `/v1/models` | List Cursor models (from `agent --list-models`) |
| POST | `/v1/chat/completions` | Chat completion (OpenAI shape; supports `stream: true`) |
| POST | `/v1/messages` | Anthropic Messages API (used by Claude Code; supports `stream: true`) |

## Environment variables

Environment handling is centralized in one module. Aliases, defaults, path resolution, platform fallbacks, and `--tailscale` host behavior are resolved consistently before the server starts.

| Variable | Default | Description |
|----------|---------|-------------|
| `CURSOR_BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `CURSOR_BRIDGE_PORT` | `8765` | Port |
| `CURSOR_BRIDGE_API_KEY` | — | If set, require `Authorization: Bearer <key>` on requests |
| `CURSOR_BRIDGE_WORKSPACE` | process cwd | Workspace directory for Cursor CLI |
| `CURSOR_BRIDGE_MODE` | — | Ignored; proxy always runs in **ask** (chat-only) mode so the CLI never creates or edits files. |
| `CURSOR_BRIDGE_DEFAULT_MODEL` | `auto` | Default model when request omits one |
| `CURSOR_BRIDGE_STRICT_MODEL` | `true` | Use last requested model when none specified |
| `CURSOR_BRIDGE_FORCE` | `false` | Pass `--force` to Cursor CLI |
| `CURSOR_BRIDGE_APPROVE_MCPS` | `false` | Pass `--approve-mcps` to Cursor CLI |
| `CURSOR_BRIDGE_TIMEOUT_MS` | `300000` | Timeout per completion (ms) |
| `CURSOR_BRIDGE_TLS_CERT` | — | Path to TLS certificate file (e.g. Tailscale cert). Use with `CURSOR_BRIDGE_TLS_KEY` for HTTPS. |
| `CURSOR_BRIDGE_TLS_KEY` | — | Path to TLS private key file. Use with `CURSOR_BRIDGE_TLS_CERT` for HTTPS. |
| `CURSOR_BRIDGE_SESSIONS_LOG` | `~/.cursor-api-proxy/sessions.log` | Path to log file; each request is appended as a line (timestamp, method, path, IP, status). |
| `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE` | `true` | When `true` (default), the CLI runs in an empty temp dir so it **cannot read or write your project**; pure chat only. The proxy also overrides `HOME`, `USERPROFILE`, and `CURSOR_CONFIG_DIR` so the agent cannot load rules from `~/.cursor` or project rules from elsewhere. Set to `false` to pass the real workspace (e.g. for `X-Cursor-Workspace`). |
| `CURSOR_BRIDGE_VERBOSE` | `false` | When `true`, print full request messages and response content to stdout for every completion (both stream and sync). |
| `CURSOR_BRIDGE_MAX_MODE` | `false` | When `true`, enable Cursor **Max Mode** for all requests (larger context window, higher tool-call limits). The proxy writes `maxMode: true` to `cli-config.json` before each run. Works when using `CURSOR_AGENT_NODE`/`CURSOR_AGENT_SCRIPT`, the versioned layout (`versions/YYYY.MM.DD-commit/`), or node.exe + index.js next to agent.cmd. |
| `CURSOR_BRIDGE_PROMPT_VIA_STDIN` | `false` | When `true`, the proxy sends the user prompt to the agent via **stdin** instead of as a command-line argument. Use this on Windows if the agent does not receive the full prompt when it is passed in argv (e.g. “no headlines” / truncated). The Cursor agent must support reading the prompt from stdin when no positional prompt is given; if it does not, this option has no effect or may cause errors. |
| `CURSOR_BRIDGE_USE_ACP` | `false` | When `true`, the proxy uses **ACP (Agent Client Protocol)** to talk to the Cursor CLI: it spawns `agent acp` and sends the prompt via JSON-RPC over stdio. This avoids Windows argv limits and quoting issues entirely. On Windows with `agent.cmd`, the proxy auto-detects the versioned layout and spawns Node directly. See [Cursor ACP docs](https://cursor.com/docs/cli/acp). To debug ACP hangs, set `NODE_DEBUG=cursor-api-proxy:acp` to log each ACP step. |
| `CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE` | auto | When `CURSOR_API_KEY` is set, the proxy skips the ACP authenticate step (avoids hangs). Set to `true` to skip authenticate when using `agent login` instead. |
| `CURSOR_BRIDGE_ACP_RAW_DEBUG` | `false` | When `1` or `true`, log every raw JSON-RPC line from ACP stdout (very verbose). Requires `NODE_DEBUG=cursor-api-proxy:acp` to see output. |
| `CURSOR_AGENT_BIN` | `agent` | Path to Cursor CLI binary. Alias precedence: `CURSOR_AGENT_BIN`, then `CURSOR_CLI_BIN`, then `CURSOR_CLI_PATH`. |
| `CURSOR_AGENT_NODE` | — | **(Windows)** Path to Node.js executable. When set together with `CURSOR_AGENT_SCRIPT`, spawns Node directly instead of going through cmd.exe, bypassing the ~8191 character command line limit. |
| `CURSOR_AGENT_SCRIPT` | — | **(Windows)** Path to the agent script (e.g. `agent.cmd` or the underlying `.js`). Use with `CURSOR_AGENT_NODE` to bypass cmd.exe for long prompts. |

Notes:
- `--tailscale` changes the default host to `0.0.0.0` only when `CURSOR_BRIDGE_HOST` is not already set.
- ACP `session/request_permission` uses `reject-once` (least-privilege) so the agent cannot grant file/tool access; intentional for chat-only mode.
- Relative paths such as `CURSOR_BRIDGE_WORKSPACE`, `CURSOR_BRIDGE_SESSIONS_LOG`, `CURSOR_BRIDGE_TLS_CERT`, and `CURSOR_BRIDGE_TLS_KEY` are resolved from the current working directory.

#### Windows command line limit bypass

On Windows, cmd.exe has a ~8191 character limit on the command line. Long prompts passed as arguments can exceed this and cause the agent to fail. When `agent.cmd` is used (e.g. from `%LOCALAPPDATA%\cursor-agent\`), the proxy **auto-detects the versioned layout** (`versions/YYYY.MM.DD-commit/`) and spawns `node.exe` + `index.js` from the latest version directly, bypassing cmd.exe and PowerShell. If auto-detection does not apply, set both `CURSOR_AGENT_NODE` (path to `node.exe`) and `CURSOR_AGENT_SCRIPT` (path to the agent script). The proxy will then spawn Node directly with the script and args instead of using cmd.exe, avoiding the limit.

Example (adjust paths to your install):

```bash
set CURSOR_AGENT_NODE=C:\Program Files\nodejs\node.exe
set CURSOR_AGENT_SCRIPT=C:\path\to\Cursor\resources\agent\agent.cmd
# or for cursor-agent versioned layout:
# set CURSOR_AGENT_NODE=%LOCALAPPDATA%\cursor-agent\versions\2026.03.11-6dfa30c\node.exe
# set CURSOR_AGENT_SCRIPT=%LOCALAPPDATA%\cursor-agent\versions\2026.03.11-6dfa30c\index.js
```

CLI flags:

| Flag | Description |
|------|-------------|
| `--tailscale` | Bind to `0.0.0.0` for access from tailnet/LAN (unless `CURSOR_BRIDGE_HOST` is already set) |
| `-h`, `--help` | Show CLI usage |

Optional per-request override: send header `X-Cursor-Workspace: <path>` to use a different workspace for that request.

## Streaming

The proxy supports `stream: true` on `POST /v1/chat/completions` and `POST /v1/messages`. It returns Server-Sent Events (SSE) in OpenAI’s streaming format. Cursor CLI emits incremental deltas plus a final full message; the proxy deduplicates output so clients receive each chunk only once.

**Test streaming:** from repo root, with the proxy running:

```bash
node examples/test-stream.mjs
```

See [examples/README.md](examples/README.md) for details.

## License

MIT
