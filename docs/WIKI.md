# cursor-api-proxy — Wiki

**cursor-api-proxy** is a small **Bun / TypeScript** service: an **OpenAI-compatible HTTP API** (plus Anthropic-style `POST /v1/messages`) that forwards chat to **Cursor’s CLI agent** (`cursor-agent` / ACP). It is the evolution of the older single-file **claude-cursor-bridge** pattern, packaged for Bun and richer options (TLS, account pool, strict models, etc.).

This page documents the **local dashboard**, **markdown wiki in the browser**, and the **`cursor-api-proxy` shell launcher** — the same trio as **claude-cursor-bridge**.

---

## Table of contents

1. [What you get in the browser](#what-you-get-in-the-browser)
2. [Quick start](#quick-start)
3. [The `cursor-api-proxy` CLI launcher](#the-cursor-api-proxy-cli-launcher)
4. [Install the launcher script](#install-the-launcher-script)
5. [Auto-start at login (macOS launchd)](#auto-start-at-login-macos-launchd)
6. [HTTP routes](#http-routes)
7. [Files & directories](#files--directories)
8. [Troubleshooting](#troubleshooting)

---

## What you get in the browser

With the proxy **running**, open:

| URL | Purpose |
| ----- | --------- |
| `http://127.0.0.1:8765/` | **Dashboard** — status, effective config, request stats from `sessions.log`, log tail, action buttons |
| `http://127.0.0.1:8765/wiki` | **Wiki** — this document rendered from `docs/WIKI.md` |
| `http://127.0.0.1:8765/healthz` | Plain **`ok`** (for scripts and load checks) |
| `http://127.0.0.1:8765/health` | JSON health payload (version, workspace, default model, …) |

Port **`8765`** is the default (`CURSOR_BRIDGE_PORT`). Host defaults to **`127.0.0.1`** (`CURSOR_BRIDGE_HOST`).

The dashboard and wiki are served **without** requiring `CURSOR_BRIDGE_API_KEY` (that gate applies only to LLM API traffic). Keep the service on loopback in production.

---

## Quick start

```bash
cd /path/to/cursor-api-proxy
bun install
bun run build

# Foreground (see stdout):
bun start

# Or use the launcher (after [install](#install-the-launcher-script)):
cursor-api-proxy start
cursor-api-proxy health
```

Then open the dashboard at `http://127.0.0.1:8765/` (or your configured host/port).

---

## The `cursor-api-proxy` CLI launcher

Same idea as **claude-cursor-bridge**’s `claude-bridge`: a **bash** script in `~/.local/bin/cursor-api-proxy` that can start/stop the Bun process, probe **`/healthz`**, and optionally install a **launchd** plist.

| Command | Behavior |
| --------- | ---------- |
| `cursor-api-proxy` | No args: print **health**, then a tiny interactive menu |
| `cursor-api-proxy start` | Background start, append stdout/stderr to `~/.cursor-api-proxy/proxy.log`, wait for `/healthz` |
| `cursor-api-proxy stop` | `SIGTERM`, then `SIGKILL` if needed |
| `cursor-api-proxy restart` | `stop` then `start` |
| `cursor-api-proxy health` | PID, port, launchd state, HTTP probe, last log lines |
| `cursor-api-proxy requests` | Formatted latest completed requests from `sessions.log` |
| `cursor-api-proxy enable` | Write `~/Library/LaunchAgents/com.cursor-api-proxy.plist` and `launchctl load` |
| `cursor-api-proxy disable` | `launchctl unload` and remove the plist |
| `cursor-api-proxy run` | Foreground `bun …/dist/cli.js` (what launchd invokes) |

Request viewer options:

```bash
cursor-api-proxy requests --limit 50
cursor-api-proxy requests --watch --interval 1
```

The viewer reads `CURSOR_BRIDGE_SESSIONS_LOG` directly (default
`~/.cursor-api-proxy/sessions.log`), including while the proxy is stopped.
`NO_COLOR=1` disables ANSI colors.

Environment the script honors:

| Variable | Meaning |
| ---------- | --------- |
| `CURSOR_API_PROXY_ROOT` | Path to the **git checkout** (must contain `dist/cli.js` after `bun run build`) |
| `CURSOR_BRIDGE_PORT` | HTTP port (default **8765**) |
| `CURSOR_BRIDGE_HOST` | Bind address (default **127.0.0.1**) |

---

## Install the launcher script

From your clone:

```bash
chmod +x scripts/cursor-api-proxy
mkdir -p ~/.local/bin
ln -sf "$(pwd)/scripts/cursor-api-proxy" ~/.local/bin/cursor-api-proxy
export CURSOR_API_PROXY_ROOT="$(pwd)"   # add to ~/.zshrc if you want it permanent
cursor-api-proxy health
```

If you installed the package with Bun instead of a clone, point `CURSOR_API_PROXY_ROOT` at the package directory that contains `dist/cli.js` (for example in Bun's install/cache location).

---

## Auto-start at login (macOS launchd)

```bash
cursor-api-proxy enable
launchctl list | grep cursor-api-proxy
```

The plist label is **`com.cursor-api-proxy`**. Use **`cursor-api-proxy disable`** before **`stop`** if you want the process to stay stopped (otherwise **KeepAlive** may respawn it).

---

## HTTP routes

**LLM / health**

- `GET /health`, `GET /healthz`, `GET /v1/models`
- `POST /v1/chat/completions`, `POST /v1/messages`

**Dashboard (no API key)**

- `GET /`, `GET /wiki`, `GET /static/*`
- `GET /api/status`, `GET /api/config`, `GET /api/log`, `GET /api/stats`, `GET /api/wiki`
- `POST /api/control` with body `{ "action": "start" | "stop" | "restart" | "enable" | "disable" }` — spawns the **`~/.local/bin/cursor-api-proxy`** script in the background (same pattern as the bridge).

---

## Files & directories

| Path | Role |
| ------ | ------ |
| `dist/cli.js` | Compiled server entry |
| `public/` | Dashboard + wiki static assets |
| `docs/WIKI.md` | Wiki source |
| `scripts/cursor-api-proxy` | Launcher script (symlink target) |
| `~/.cursor-api-proxy/sessions.log` | Default request log (one line per finished response) |
| `~/.cursor-api-proxy/proxy.log` | Launcher / background stdout+stderr |
| `~/.cursor-api-proxy/proxy.pid` | Written by the running Bun process for the dashboard |

---

## Troubleshooting

**`CLI not found` when using action buttons**

Install the launcher to `~/.local/bin/cursor-api-proxy` (see [install](#install-the-launcher-script)).

**`Started, but no health response`**

- Confirm `bun run build` was run so `dist/cli.js` exists.
- Check `CURSOR_API_PROXY_ROOT`.
- If port is in use, set `CURSOR_BRIDGE_PORT` to a free port in both the environment **and** the plist (re-run `enable` after editing the script or env).

**Dashboard shows “no requests”**

Stats are parsed from **`sessions.log`** lines in the form logged by the proxy (`ISO8601 METHOD PATH REMOTE STATUS`). If the log path was overridden (`CURSOR_BRIDGE_SESSIONS_LOG`), the dashboard reads that file instead.

---

## Relation to claude-cursor-bridge

| Feature | claude-cursor-bridge | cursor-api-proxy |
| --------- | --------------------- | ------------------ |
| Anthropic → Cursor | yes | yes (+ OpenAI chat schema) |
| Local dashboard + wiki | yes | yes |
| Bash launcher + launchd | `claude-bridge` | `cursor-api-proxy` |
| Bun package / TypeScript | no | yes |
