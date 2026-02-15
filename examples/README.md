# Examples

## test-stream.mjs

Tests **streaming** (`stream: true`) against the proxy.

**Prerequisites**

1. Start the proxy from the repo root: `npm start`
2. Cursor CLI installed and authenticated: `agent login`

**Run**

```bash
# From repo root
node examples/test-stream.mjs
```

Optional: use a different proxy URL:

```bash
CURSOR_PROXY_URL=http://127.0.0.1:8765 node examples/test-stream.mjs
```

The script sends a short prompt and prints each streamed chunk as it arrives, then the total character count.
