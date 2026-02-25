# cursor-api-proxy

OpenAI-compatible proxy for Cursor CLI. Expose Cursor models on localhost so any LLM client (OpenAI SDK, LiteLLM, LangChain, etc.) can call them as a standard chat API.

## Prerequisites

- **Node.js** 18+
- **Cursor CLI** (`agent`). Install and log in:

  ```bash
  curl https://cursor.com/install -fsS | bash
  agent login
  agent --list-models
  ```

  For automation, set `CURSOR_API_KEY` instead of using `agent login`.

## Install

```bash
cd ~/personal/cursor-api-proxy
npm install
npm run build
```

## Run

```bash
npm start
# or: node dist/cli.js
# or: npx cursor-api-proxy   (if linked globally)
```

By default the server listens on **http://127.0.0.1:8765**.

To expose it to your Tailscale network:

```bash
npm start -- --tailscale
```

This binds to `0.0.0.0` unless `CURSOR_BRIDGE_HOST` is explicitly set. Optionally set `CURSOR_BRIDGE_API_KEY` to require `Authorization: Bearer <key>` on requests.

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

## Usage from other services

- **Base URL**: `http://127.0.0.1:8765/v1`
- **API key**: Use any value (e.g. `unused`), or set `CURSOR_BRIDGE_API_KEY` and send it as `Authorization: Bearer <key>`.

### Example (OpenAI client)

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8765/v1",
  apiKey: process.env.CURSOR_BRIDGE_API_KEY || "unused",
});

const completion = await client.chat.completions.create({
  model: "gpt-5.2",
  messages: [{ role: "user", content: "Hello" }],
});
console.log(completion.choices[0].message.content);
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Server and config info |
| GET | `/v1/models` | List Cursor models (from `agent --list-models`) |
| POST | `/v1/chat/completions` | Chat completion (OpenAI shape; supports `stream: true`) |

## Environment variables

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
| `CURSOR_BRIDGE_SESSIONS_LOG` | `sessions.log` (cwd) | Path to log file; each request is appended as a line (timestamp, method, path, IP, status). |
| `CURSOR_BRIDGE_CHAT_ONLY_WORKSPACE` | `true` | When `true` (default), the CLI runs in an empty temp dir so it **cannot read or write your project**; pure chat only. Set to `false` to pass the real workspace (e.g. for `X-Cursor-Workspace`). |
| `CURSOR_AGENT_BIN` | `agent` | Path to Cursor CLI binary |

CLI flags:

| Flag | Description |
|------|-------------|
| `--tailscale` | Bind to `0.0.0.0` for access from tailnet/LAN (unless `CURSOR_BRIDGE_HOST` is already set) |
| `-h`, `--help` | Show CLI usage |

Optional per-request override: send header `X-Cursor-Workspace: <path>` to use a different workspace for that request.

## Streaming

The proxy supports `stream: true` on `POST /v1/chat/completions`. It returns Server-Sent Events (SSE) in OpenAI’s streaming format. Cursor CLI returns the full response in one go, so the proxy sends that response as a single content delta (clients still receive a valid SSE stream).

**Test streaming:** from repo root, with the proxy running:

```bash
node examples/test-stream.mjs
```

See [examples/README.md](examples/README.md) for details.

## License

MIT
