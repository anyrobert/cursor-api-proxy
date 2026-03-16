# Examples

**Prerequisites for all examples:** Cursor CLI installed and authenticated (`agent login`). The SDK examples **start the proxy in the background automatically** if it is not already running.

Optional: set `CURSOR_PROXY_URL` to use a different proxy URL (default `http://127.0.0.1:8765`). Set `startProxy: false` when creating the client if you run the proxy yourself.

---

## SDK examples (using the cursor-api-proxy package)

### sdk-client.mjs

Uses the **minimal client** (`createCursorProxyClient`). Proxy starts automatically on first request. No extra dependencies.

```bash
npm run build   # if running from repo
node examples/sdk-client.mjs
```

### sdk-openai.mjs

Uses **getOpenAIOptionsAsync** with the **OpenAI SDK**. Proxy starts automatically. This is an optional example; `openai` is not part of this package and only needs to be installed in the project where you run the example.

```bash
npm install openai
node examples/sdk-openai.mjs
```

### sdk-stream.mjs

Uses the **minimal client**’s **fetch** for streaming. Proxy starts automatically on first request.

```bash
node examples/sdk-stream.mjs
```

---

## Raw fetch examples (no SDK)

### test.mjs

Non-streaming chat completion via raw `fetch` (no cursor-api-proxy SDK import).

```bash
node examples/test.mjs
```

### test-stream.mjs

Streaming chat completion via raw `fetch`.

```bash
node examples/test-stream.mjs
```

Prints each streamed chunk and the total character count.
