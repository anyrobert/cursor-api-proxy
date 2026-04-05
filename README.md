# cursor-api-proxy

OpenAI-compatible proxy for Cursor CLI. Expose Cursor models on localhost so any LLM client (OpenAI SDK, LiteLLM, LangChain, etc.) can call them as a standard chat API.

This package works as **one npm dependency**: use it as an **SDK** in your app to call the proxy API, and/or run the **CLI** to start the proxy server. Core behavior is unchanged.

**OpenAI-compatible mode is not the Cursor IDE:** the HTTP API does not automatically attach your repo, `@codebase`, or host shell the way the desktop app does. See [Local workspace and agent frameworks](#local-workspace-and-agent-frameworks).

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

## Local workspace and agent frameworks

When you point an agent runtime (OpenClaw, LangChain, a custom harness, etc.) at this proxy with a normal `baseUrl` + `apiKey`, you get a **cloud model behind an OpenAI-shaped HTTP API**. That is **not** the same product surface as the **Cursor IDE**, which can index and act on a local workspace.

- **No implicit project context:** The model only sees what you put in the request—`messages`, optional tools schema, and **tool results that your client executes and sends back**. There is no automatic filesystem, repo layout, or `@codebase` injection from the proxy alone.
- **If “local” actions work, they work in the client:** Reads, shell commands, and directory listings happen only when **your agent framework** implements tools and runs them on the host, then returns outputs in follow-up messages. The proxy does not substitute for that.
- **Server-side workspace (optional):** The Cursor CLI may run with a workspace directory (`CURSOR_BRIDGE_WORKSPACE`, per-request `X-Cursor-Workspace`). By default, `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=true` runs the CLI in an **empty temp directory** so it does not read or write your real project; the proxy also overrides `HOME`, `USERPROFILE`, and `CURSOR_CONFIG_DIR` so the agent does not load global or project rules from elsewhere. Set it to `false` if you intentionally want the CLI to see a path on the machine where the proxy runs (still not the same as IDE indexing—see env table below).
- **Recommended patterns for agents:** Use **client-side tools** (e.g. `read_file`, `run_terminal_cmd`) and pass results as tool messages; add **RAG** or retrieval and inject snippets into `user` content; or paste relevant files into the prompt. There is no built-in “sync entire workspace through the proxy” today; if that changes, it will be documented here.

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

const opts = await getOpenAIOptionsAsync(); // starts proxy if needed
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

const proxy = createCursorProxyClient(); // proxy starts on first request if needed
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

| Method | Path                   | Description                                                           |
| ------ | ---------------------- | --------------------------------------------------------------------- |
| GET    | `/health`              | Server and config info                                                |
| GET    | `/v1/models`           | List Cursor models (from `agent --list-models`)                       |
| POST   | `/v1/chat/completions` | Chat completion (OpenAI shape; supports `stream: true`)               |
| POST   | `/v1/messages`         | Anthropic Messages API (used by Claude Code; supports `stream: true`) |

**Usage / token fields:** Responses may include `usage` with `prompt_tokens`, `completion_tokens`, and `total_tokens`. These are **heuristic estimates** (character count ÷ 4), not Cursor billing meters. Do not use them for invoicing.

## Environment variables

Environment handling is centralized in one module. Aliases, defaults, path resolution, platform fallbacks, and `--tailscale` host behavior are resolved consistently before the server starts.

| Variable | Default | Description |
|----------|---------|-------------|
| `CURSOR_BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `CURSOR_BRIDGE_PORT` | `8765` | Port |
| `CURSOR_BRIDGE_API_KEY` | — | If set, require `Authorization: Bearer <key>` on requests |
| `CURSOR_API_KEY` / `CURSOR_AUTH_TOKEN` | — | Cursor access token passed to spawned CLI/ACP children (automation, headless). Same value can be used for both names. |
| `CURSOR_BRIDGE_WORKSPACE` | process cwd | Base workspace directory for Cursor CLI. With `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false`, header `X-Cursor-Workspace` must point to an **existing directory under this path** (after resolving real paths). |
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
| `CURSOR_BRIDGE_WIN_CMDLINE_MAX` | `30000` | **(Windows)** Upper bound (UTF-16 units, pessimistic) for the full `CreateProcess` command line. If the prompt would exceed it, the proxy keeps the **tail** of the prompt and prepends a short omission notice, logs a warning, and sets `X-Cursor-Proxy-Prompt-Truncated: true` on the response. Clamped to `4096`–`32700`. |
| `CURSOR_CONFIG_DIRS` | — | Comma-separated configuration directories for round-robin account rotation (alias: `CURSOR_ACCOUNT_DIRS`). Auto-discovers authenticated accounts under `~/.cursor-api-proxy/accounts/` when unset. |
| `CURSOR_BRIDGE_MULTI_PORT` | `false` | When `true` and multiple config dirs are set, spawns a separate server per directory on incrementing ports starting from `CURSOR_BRIDGE_PORT`. |
| `CURSOR_BRIDGE_PROMPT_VIA_STDIN` | `false` | When `true`, sends the user prompt via **stdin** instead of argv (helps on Windows if argv is truncated). |
| `CURSOR_BRIDGE_USE_ACP` | `false` | When `true`, uses **ACP (Agent Client Protocol)** over stdio (`agent acp`). Avoids Windows argv limits. See [Cursor ACP docs](https://cursor.com/docs/cli/acp). Set `NODE_DEBUG=cursor-api-proxy:acp` to debug. |
| `CURSOR_BRIDGE_ACP_SKIP_AUTHENTICATE` | auto | When `CURSOR_API_KEY` is set, skips the ACP authenticate step. Set to `true` to skip when using `agent login` instead. |
| `CURSOR_BRIDGE_ACP_RAW_DEBUG` | `false` | When `1` or `true`, log raw JSON-RPC from ACP stdout (requires `NODE_DEBUG=cursor-api-proxy:acp`). |
| `CURSOR_AGENT_BIN` | `agent` | Path to Cursor CLI binary. Alias precedence: `CURSOR_AGENT_BIN`, then `CURSOR_CLI_BIN`, then `CURSOR_CLI_PATH`. |
| `CURSOR_AGENT_NODE` | — | **(Windows)** Path to Node.js. With `CURSOR_AGENT_SCRIPT`, spawns Node directly and bypasses cmd.exe’s ~8191 limit (CreateProcess ~32K still applies; see `CURSOR_BRIDGE_WIN_CMDLINE_MAX`). |
| `CURSOR_AGENT_SCRIPT` | — | **(Windows)** Path to the agent script (e.g. `agent.cmd` or `.js`). Use with `CURSOR_AGENT_NODE` for long prompts. |

Notes:

- The `login` subcommand depends on `chrome-launcher`; its dependency tree may pull typings into production installs. Prefer `npm audit` before release; upstream may move types to `devDependencies` over time.
- `--tailscale` changes the default host to `0.0.0.0` only when `CURSOR_BRIDGE_HOST` is not already set.
- ACP `session/request_permission` uses `reject-once` (least-privilege) so the agent cannot grant file/tool access; intentional for chat-only mode.
- Relative paths such as `CURSOR_BRIDGE_WORKSPACE`, `CURSOR_BRIDGE_SESSIONS_LOG`, `CURSOR_BRIDGE_TLS_CERT`, and `CURSOR_BRIDGE_TLS_KEY` are resolved from the current working directory.

#### Windows command line limits

Two different limits matter:

1. **cmd.exe** — about **8191** characters. If the proxy invokes the agent through `cmd.exe`, long prompts can fail before the process starts.
2. **CreateProcess** — about **32,767** characters for the **entire** command line (executable path plus all arguments), even when spawning `node.exe` and the script directly.

When `agent.cmd` is used (e.g. under `%LOCALAPPDATA%\cursor-agent\`), the proxy **auto-detects the versioned layout** (`versions/YYYY.MM.DD-commit/`) and spawns `node.exe` + `index.js` from the latest version directly, bypassing cmd.exe. If that does not apply, set both `CURSOR_AGENT_NODE` and `CURSOR_AGENT_SCRIPT` so the proxy spawns Node with the script and args **without** cmd.exe.

Very large prompts can still hit the **CreateProcess** cap and produce `spawn ENAMETOOLONG`. The proxy mitigates that on Windows by **truncating the start of the prompt** while **keeping the tail** (recent context), prepending a short notice, logging a warning, and optionally exposing `X-Cursor-Proxy-Prompt-Truncated: true`. Tune the budget with `CURSOR_BRIDGE_WIN_CMDLINE_MAX` (default `30000`). **ACP** or **stdin prompt** avoids argv length limits for prompt delivery.

Example (adjust paths to your install):

```bash
set CURSOR_AGENT_NODE=C:\Program Files\nodejs\node.exe
set CURSOR_AGENT_SCRIPT=C:\path\to\Cursor\resources\agent\agent.cmd
# or for cursor-agent versioned layout:
# set CURSOR_AGENT_NODE=%LOCALAPPDATA%\cursor-agent\versions\2026.03.11-6dfa30c\node.exe
# set CURSOR_AGENT_SCRIPT=%LOCALAPPDATA%\cursor-agent\versions\2026.03.11-6dfa30c\index.js
```

CLI flags:

| Flag           | Description                                                                                |
| -------------- | ------------------------------------------------------------------------------------------ |
| `--tailscale`  | Bind to `0.0.0.0` for access from tailnet/LAN (unless `CURSOR_BRIDGE_HOST` is already set) |
| `-h`, `--help` | Show CLI usage                                                                             |

Optional per-request override: send header `X-Cursor-Workspace: <path>` to use a subdirectory of `CURSOR_BRIDGE_WORKSPACE` for that request (requires `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE=false` and an existing path on the proxy host).

**CLI subcommands** (see `cursor-api-proxy --help`): `login <name>`, `accounts` (list), `logout`, `usage`, `reset-hwid` (see `--help` for options). Flags above still apply to the server entrypoint.

## Multi-Account Setup

You can use multiple Cursor accounts to distribute load and avoid hitting usage limits. The proxy now includes a built-in account manager that makes this very easy.

### 1. Adding Accounts (Easy Method)

You can add new accounts using the CLI `login` command. This will launch the Cursor CLI login process in an isolated profile directory: `~/.cursor-api-proxy/accounts/` on macOS/Linux, or `%USERPROFILE%\.cursor-api-proxy\accounts\` on Windows.

```bash
npx cursor-api-proxy login account1
```

_(A clean, incognito browser window will open for you to log into Cursor. Once done, the session is saved)._

Repeat this for as many accounts as you want:

```bash
npx cursor-api-proxy login account2
npx cursor-api-proxy login account3
```

**Auto-Discovery:** When you start the proxy server normally (`npx cursor-api-proxy`), it will automatically find all accounts under that `accounts` directory and include them in the rotation pool.

### 2. Manual Config Directories

If you already have separate configuration folders (or want to specify them explicitly), you can override auto-discovery using the `CURSOR_CONFIG_DIRS` environment variable:

```bash
CURSOR_CONFIG_DIRS=/path/to/cursor-agent-1,/path/to/cursor-agent-2 npm start
```

### 3. Modes of operation

**A. Single Port, Round-Robin Rotation (Default)**  
In this mode, the proxy listens on one port and rotates through the available accounts for each request, selecting the least busy account automatically. This is active by default when multiple accounts are found.

**B. Multi-Port (One Server Per Account)**  
If you want granular control (for example, to explicitly assign specific clients to specific accounts), you can use multi-port mode. The proxy will spawn multiple instances on incrementing ports, starting from `CURSOR_BRIDGE_PORT`.

```bash
CURSOR_BRIDGE_MULTI_PORT=true CURSOR_BRIDGE_PORT=8765 npm start
```

_Result: account1 is on 8765, account2 is on 8766, etc._

## Streaming

The proxy supports `stream: true` on `POST /v1/chat/completions` and `POST /v1/messages`. It returns Server-Sent Events (SSE) in OpenAI’s streaming format. Cursor CLI emits incremental deltas plus a final full message; the proxy deduplicates output so clients receive each chunk only once.

**Test streaming:** from repo root, with the proxy running:

```bash
node examples/test-stream.mjs
```

See [examples/README.md](examples/README.md) for details.

## License

MIT
