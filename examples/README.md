# Examples

Prerequisites for all examples: Cursor CLI installed and authenticated (`agent login`). SDK examples start the proxy in the background automatically if it is not already running.

Optional: set `CURSOR_PROXY_URL` to use a different proxy URL (default `http://127.0.0.1:8765`). Set `startProxy: false` when creating the client if you run the proxy yourself.

---

## SDK examples (using the cursor-api-proxy package)

### sdk-client.mjs

Minimal client (`createCursorProxyClient`). Proxy starts on first request. No extra dependencies.

```bash
bun run build   # if running from repo
bun examples/sdk-client.mjs
```

### sdk-openai.mjs

`getOpenAIOptionsAsync` with the OpenAI SDK. Proxy starts automatically. `openai` is not part of this package; install it in the project where you run the example.

```bash
bun add openai
bun examples/sdk-openai.mjs
```

### sdk-stream.mjs

Minimal client's `fetch` for streaming. Proxy starts on first request.

```bash
bun examples/sdk-stream.mjs
```

---

## Raw fetch examples (no SDK)

### test.mjs

Non-streaming chat completion via raw `fetch` (no cursor-api-proxy SDK import).

```bash
bun examples/test.mjs
```

### test-stream.mjs

Streaming chat completion via raw `fetch`.

```bash
bun examples/test-stream.mjs
```

Prints each streamed chunk and the total character count.

### benchmark-latency.mjs

Full latency breakdown for debugging slow requests: CLI spawn, direct CLI/ACP, proxy sync/stream, ephemeral ACP proxy, and client-tool round-trip.

```bash
bun run build
bun examples/benchmark-latency.mjs
```

Phases 5–7 spawn short-lived proxies on free ports (`CURSOR_BRIDGE_USE_ACP=true`).

Useful env: `BENCH_SKIP_EPHEMERAL=1`, `BENCH_COMPARE_AGENT=1`, `BENCH_MAX_MODE=1`, `BENCH_MODEL`, `CURSOR_PROXY_URL`.
