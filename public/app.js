(() => {
  const $ = (id) => document.getElementById(id);

  const state = {
    paused: false,
    autoscroll: true,
    statusTimer: null,
    logTimer: null,
    logIntervalMs: 3000,
    logIntervalApplyTimer: null,
    statsTimer: null,
    lastStatusOk: true,
  };

  function fmtDuration(seconds) {
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    }
    for (const c of children) {
      if (c == null) continue;
      node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }
    return node;
  }

  function toast(message, kind = "ok", ttl = 3500) {
    const t = el("div", { class: `toast ${kind}` }, message);
    $("toasts").appendChild(t);
    setTimeout(() => {
      t.style.transition = "opacity 0.2s";
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 200);
    }, ttl);
  }

  function popup({
    title,
    message,
    okText = "OK",
    cancelText = null,
    danger = false,
  }) {
    return new Promise((resolve) => {
      const overlay = el("div", { class: "popup-overlay" });
      const card = el("div", { class: "popup-card" });
      const head = el("div", { class: "popup-head" }, title);
      const body = el("div", { class: "popup-body" }, message);
      const actions = el("div", { class: "popup-actions" });
      const okBtn = el(
        "button",
        { class: `btn small ${danger ? "danger" : "primary"}` },
        okText,
      );
      let cancelBtn = null;

      function finish(value) {
        document.removeEventListener("keydown", onKeyDown);
        overlay.remove();
        resolve(value);
      }

      function onKeyDown(e) {
        if (e.key === "Escape") finish(false);
      }

      if (cancelText) {
        cancelBtn = el("button", { class: "btn small" }, cancelText);
        cancelBtn.addEventListener("click", () => finish(false));
        actions.appendChild(cancelBtn);
      }
      okBtn.addEventListener("click", () => finish(true));
      actions.appendChild(okBtn);

      overlay.addEventListener("click", (e) => {
        if (e.target === overlay && cancelText) finish(false);
      });
      document.addEventListener("keydown", onKeyDown);

      card.appendChild(head);
      card.appendChild(body);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      setTimeout(() => {
        if (cancelBtn) cancelBtn.focus();
        else okBtn.focus();
      }, 0);
    });
  }

  function confirmPopup(message, danger = false) {
    return popup({
      title: "Please confirm",
      message,
      okText: "Confirm",
      cancelText: "Cancel",
      danger,
    });
  }

  function alertPopup(message) {
    return popup({
      title: "Notice",
      message,
      okText: "OK",
      cancelText: null,
      danger: false,
    });
  }

  async function fetchJSON(url, opts = {}) {
    const r = await fetch(url, opts);
    if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    return r.json();
  }

  function renderStatus(s) {
    const dot = $("status-dot");
    const summary = $("status-summary");
    if (s.running) {
      dot.classList.remove("down");
      summary.textContent = `v${s.version} · PID ${s.pid} · :${s.port} · up ${fmtDuration(s.uptimeSeconds)}`;
    } else {
      dot.classList.add("down");
      summary.textContent = "not running";
    }

    const launchdBadge = s.launchdLoaded
      ? el("span", { class: "badge green" }, "enabled")
      : el("span", { class: "badge muted" }, "disabled");

    const runBadge = s.running
      ? el("span", { class: "badge green" }, "running")
      : el("span", { class: "badge red" }, "down");

    const cursorKey = s.apiKeyConfigured
      ? el("span", { class: "badge green" }, "CURSOR_API_KEY set")
      : el("span", { class: "badge yellow" }, "no CURSOR_API_KEY");

    const bridgeKey = s.bridgeApiKeyRequired
      ? el("span", { class: "badge yellow" }, "CURSOR_BRIDGE_API_KEY required")
      : el("span", { class: "badge muted" }, "no bridge API key gate");

    const kv = el(
      "div",
      { class: "kv" },
      el("div", { class: "k" }, "Process"),
      el("div", { class: "v" }, runBadge, " ", `PID ${s.pid ?? "—"}`),
      el("div", { class: "k" }, "Listening"),
      el("div", { class: "v" }, `http://${s.host}:${s.port}`),
      el("div", { class: "k" }, "Uptime"),
      el(
        "div",
        { class: "v" },
        fmtDuration(s.uptimeSeconds),
        el(
          "span",
          { class: "dim-text" },
          `  (since ${new Date(s.startedAt).toLocaleString()})`,
        ),
      ),
      el("div", { class: "k" }, "Autostart"),
      el(
        "div",
        { class: "v" },
        launchdBadge,
        " ",
        el(
          "span",
          { class: "dim-text mono" },
          (s.plistPath || "").replace(/^.*\//, ""),
        ),
      ),
      el("div", { class: "k" }, "Cursor auth"),
      el("div", { class: "v" }, cursorKey),
      el("div", { class: "k" }, "Inbound API key"),
      el("div", { class: "v" }, bridgeKey),
      el("div", { class: "k" }, "Node"),
      el("div", { class: "v" }, `${s.node} (${s.platform})`),
      el("div", { class: "k" }, "Package"),
      el(
        "div",
        { class: "v mono", style: "font-size: 11px; word-break: break-all;" },
        s.packageRoot,
      ),
      el("div", { class: "k" }, "Sessions log"),
      el(
        "div",
        { class: "v mono", style: "font-size: 11px; word-break: break-all;" },
        s.sessionsLogPath,
      ),
      el("div", { class: "k" }, "Service log"),
      el(
        "div",
        { class: "v mono", style: "font-size: 11px; word-break: break-all;" },
        s.serviceLog,
      ),
    );

    const copy = el(
      "div",
      { class: "copy-row" },
      el("span", { class: "label" }, "health"),
      el("code", {}, `curl -s http://${s.host}:${s.port}/healthz`),
    );

    $("status-body").replaceChildren(kv, copy);
  }

  function renderConfig(cfg) {
    const skip = new Set(["requiredKey"]);
    const rows = Object.entries(cfg)
      .filter(([k]) => !skip.has(k))
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) =>
        el(
          "tr",
          {},
          el(
            "td",
            { class: "mono", style: "font-size: 12px; color: var(--muted);" },
            k,
          ),
          el(
            "td",
            {
              class: "model",
              style: "font-size: 12px; word-break: break-word;",
            },
            typeof v === "object" ? JSON.stringify(v) : String(v),
          ),
        ),
      );
    const tbl = el(
      "table",
      { class: "mapping" },
      el(
        "thead",
        {},
        el("tr", {}, el("th", {}, "Setting"), el("th", {}, "Value")),
      ),
      el("tbody", {}, ...rows),
    );
    $("config-body").replaceChildren(tbl);
  }

  function renderStats(stats) {
    $("stats-total").textContent =
      stats.total > 0
        ? `${stats.total} requests · ${stats.errors} errors (${stats.windowHours}h window)`
        : "no requests in window";

    if (stats.total === 0) {
      $("stats-body").replaceChildren(
        el(
          "div",
          { class: "empty" },
          "No lines matched in the sessions log for this window.",
        ),
      );
      $("recent-body").replaceChildren(
        el("div", { class: "empty" }, "No requests yet."),
      );
      return;
    }

    const paths = Object.entries(stats.byPath)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    const max = Math.max(...paths.map(([, n]) => n));
    const rows = paths.map(([p, n]) =>
      el(
        "div",
        { class: "stat-row" },
        el(
          "div",
          {
            class: "mono",
            style:
              "font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
          },
          p,
        ),
        el(
          "div",
          { class: "bar bar-OTHER" },
          el("div", {
            style: `width: ${max ? Math.round((n / max) * 100) : 0}%`,
          }),
        ),
        el("div", { class: "count" }, String(n)),
      ),
    );
    $("stats-body").replaceChildren(...rows);

    const recentTbl = el(
      "table",
      { class: "mapping" },
      el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", {}, "When"),
          el("th", {}, "Method"),
          el("th", {}, "Path"),
          el("th", {}, "Status"),
        ),
      ),
      el(
        "tbody",
        {},
        ...stats.recent
          .slice(0, 14)
          .map((r) =>
            el(
              "tr",
              {},
              el(
                "td",
                { class: "mono", style: "font-size: 11px;" },
                new Date(r.ts).toLocaleTimeString(),
              ),
              el("td", { class: "mono", style: "font-size: 12px;" }, r.method),
              el(
                "td",
                { class: "mono", style: "font-size: 11px;" },
                r.pathname,
              ),
              el(
                "td",
                {},
                el(
                  "span",
                  { class: r.status >= 400 ? "badge yellow" : "badge green" },
                  String(r.status),
                ),
              ),
            ),
          ),
      ),
    );
    $("recent-body").replaceChildren(recentTbl);
  }

  function formatLogLine(line) {
    const m = line.match(/^(\S+Z)\s+(.+)$/);
    let tsPart = "";
    let rest = line;
    if (m) {
      tsPart = m[1];
      rest = m[2];
    }
    const wrap = el("div", { class: "log-line" });
    if (tsPart) {
      const d = new Date(tsPart);
      wrap.appendChild(
        el("span", { class: "ts" }, `${d.toLocaleTimeString()} `),
      );
    }
    if (rest.includes(" ERROR ")) {
      wrap.appendChild(el("span", { class: "err" }, rest));
    } else if (/\s(5\d\d)\s*$/.test(rest) || /\s(4\d\d)\s*$/.test(rest)) {
      wrap.appendChild(el("span", { class: "req" }, rest));
    } else if (/listening on/.test(rest)) {
      wrap.appendChild(el("span", { class: "ok" }, rest));
    } else {
      wrap.appendChild(document.createTextNode(rest));
    }
    return wrap;
  }

  function renderLog(lines) {
    const viewer = $("log-viewer");
    if (!lines.length) {
      viewer.replaceChildren(el("div", { class: "empty" }, "Log is empty."));
      return;
    }
    viewer.replaceChildren(...lines.map(formatLogLine));
    if (state.autoscroll) viewer.scrollTop = viewer.scrollHeight;
  }

  function restartLogPolling() {
    if (state.logTimer) clearInterval(state.logTimer);
    state.logTimer = setInterval(refreshLog, state.logIntervalMs);
  }

  function applyLogIntervalFromInput() {
    const raw = $("log-interval-input").value.trim();
    const seconds = Number(raw);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      $("log-interval-input").value = String(state.logIntervalMs / 1000);
      toast("Invalid interval. Use a number in seconds.", "err");
      return;
    }
    const nextMs = Math.max(500, Math.round(seconds * 1000));
    if (nextMs === state.logIntervalMs) return;
    state.logIntervalMs = nextMs;
    restartLogPolling();
  }

  async function refreshStatus() {
    try {
      const s = await fetchJSON("/api/status");
      renderStatus(s);
      state.lastStatusOk = true;
    } catch (e) {
      $("status-dot").classList.add("down");
      $("status-summary").textContent = "unreachable";
      if (state.lastStatusOk)
        toast(`Status request failed: ${e.message}`, "err");
      state.lastStatusOk = false;
    }
  }

  async function refreshConfig() {
    try {
      const cfg = await fetchJSON("/api/config");
      renderConfig(cfg);
    } catch (e) {
      $("config-body").replaceChildren(
        el("div", { class: "empty" }, `Error: ${e.message}`),
      );
    }
  }

  async function refreshStats() {
    try {
      const stats = await fetchJSON("/api/stats?hours=24");
      renderStats(stats);
    } catch (e) {
      $("stats-body").replaceChildren(
        el("div", { class: "empty" }, `Error: ${e.message}`),
      );
    }
  }

  async function refreshLog() {
    if (state.paused) return;
    try {
      const data = await fetchJSON("/api/log?lines=80");
      renderLog(data.lines);
    } catch (e) {
      $("log-viewer").replaceChildren(
        el("div", { class: "empty" }, `Error: ${e.message}`),
      );
    }
  }

  async function doControl(action) {
    const confirmMsg = {
      stop: "Stop the proxy? Clients will fail until you restart.",
      restart: "Restart the proxy? The dashboard will briefly disconnect.",
      enable: null,
      disable: null,
    };
    const msg = confirmMsg[action];
    if (msg && !(await confirmPopup(msg, action === "stop"))) return;

    try {
      const r = await fetchJSON("/api/control", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action }),
      });
      toast(`Scheduled: cursor-api-proxy ${r.action}`, "ok");
      if (action === "restart" || action === "stop") {
        toast("Reconnecting…", "warn", 6000);
        setTimeout(() => refreshAll(), 1500);
        setTimeout(() => refreshAll(), 3500);
        setTimeout(() => refreshAll(), 5500);
      } else {
        setTimeout(() => refreshAll(), 800);
      }
    } catch (e) {
      toast(`Action failed: ${e.message}`, "err");
      await alertPopup(`Action failed: ${e.message}`);
    }
  }

  function refreshAll() {
    refreshStatus();
    refreshConfig();
    refreshStats();
    refreshLog();
  }

  function bind() {
    $("refresh-btn").addEventListener("click", refreshAll);
    $("pause-btn").addEventListener("click", () => {
      state.paused = !state.paused;
      $("pause-btn").textContent = state.paused ? "Resume" : "Pause";
    });
    $("clear-btn").addEventListener("click", async () => {
      if (
        !(await confirmPopup("Clear and archive current sessions log?", true))
      )
        return;
      try {
        const r = await fetchJSON("/api/log/clear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        toast(`Archived log to ${r.archivePath}`, "ok", 5000);
        refreshAll();
      } catch (e) {
        toast(`Clear failed: ${e.message}`, "err");
        await alertPopup(`Clear failed: ${e.message}`);
      }
    });
    $("log-interval-input").addEventListener("input", () => {
      if (state.logIntervalApplyTimer)
        clearTimeout(state.logIntervalApplyTimer);
      state.logIntervalApplyTimer = setTimeout(() => {
        applyLogIntervalFromInput();
        state.logIntervalApplyTimer = null;
      }, 1000);
    });
    $("autoscroll").addEventListener("change", (e) => {
      state.autoscroll = e.target.checked;
    });
    for (const btn of document.querySelectorAll("[data-action]")) {
      btn.addEventListener("click", () => doControl(btn.dataset.action));
    }
  }

  function start() {
    bind();
    refreshAll();
    state.statusTimer = setInterval(refreshStatus, 5000);
    restartLogPolling();
    state.statsTimer = setInterval(refreshStats, 15000);
  }

  document.addEventListener("DOMContentLoaded", start);
})();
