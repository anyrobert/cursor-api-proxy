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
| `CURSOR_BRIDGE_MODE` | `ask` | Cursor mode: `ask` \| `plan` \| `agent` |
| `CURSOR_BRIDGE_DEFAULT_MODEL` | `auto` | Default model when request omits one |
| `CURSOR_BRIDGE_STRICT_MODEL` | `true` | Use last requested model when none specified |
| `CURSOR_BRIDGE_FORCE` | `false` | Pass `--force` to Cursor CLI |
| `CURSOR_BRIDGE_APPROVE_MCPS` | `false` | Pass `--approve-mcps` to Cursor CLI |
| `CURSOR_BRIDGE_TIMEOUT_MS` | `300000` | Timeout per completion (ms) |
| `CURSOR_AGENT_BIN` | `agent` | Path to Cursor CLI binary |

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
