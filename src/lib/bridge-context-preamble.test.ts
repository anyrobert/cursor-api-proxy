import { describe, expect, it } from "vitest";

import {
  buildBridgeContextPreamble,
  readHttpHeader,
} from "./bridge-context-preamble.js";

describe("readHttpHeader", () => {
  it("reads the first header value case-insensitively", () => {
    expect(
      readHttpHeader({ "x-foo": "  bar  " } as any, "X-Foo"),
    ).toBe("bar");
  });

  it("returns undefined for missing or empty", () => {
    expect(readHttpHeader({}, "x-missing")).toBeUndefined();
    expect(readHttpHeader({ "x-missing": "   " }, "x-missing")).toBeUndefined();
  });
});

describe("buildBridgeContextPreamble", () => {
  it("names only the sandbox in chat-only mode, never the host workspace", () => {
    const text = buildBridgeContextPreamble({
      headers: {},
      bridgeWorkspaceBase: "/Users/me/Developer",
      agentWorkspaceDir: "/tmp/cursor-proxy-abc/workspace",
      isolatedChatOnly: true,
      cursorMode: "ask",
    });
    expect(text).toBe(
      "Via cursor-api-proxy → Cursor CLI. cwd=/tmp/cursor-proxy-abc/workspace; mode=ask. Chat-only: the cwd is a temp sandbox and nothing outside it is in scope.",
    );
    expect(text).not.toContain("/Users/me/Developer");
    expect(text).not.toContain("workspace=");
  });

  it("leaves a client's X-Cursor-Workspace path out in chat-only mode", () => {
    const text = buildBridgeContextPreamble({
      headers: {
        "x-cursor-workspace": "/Users/me/Developer/my-app",
        "x-cursor-proxy-client": "sdk-helper",
      },
      bridgeWorkspaceBase: "/Users/me/Developer",
      agentWorkspaceDir: "/tmp/sandbox",
      isolatedChatOnly: true,
      cursorMode: "agent",
      contextExtra: "Be brief.",
    });
    expect(text).not.toContain("X-Cursor-Workspace");
    expect(text).not.toContain("/Users/me/Developer");
    expect(text.split("\n")).toEqual([
      "Via cursor-api-proxy → Cursor CLI. cwd=/tmp/sandbox; mode=agent. Chat-only: the cwd is a temp sandbox and nothing outside it is in scope.",
      "client=sdk-helper",
      "Be brief.",
    ]);
  });

  it("names the workspace base and the agent cwd when they differ outside chat-only", () => {
    const text = buildBridgeContextPreamble({
      headers: {},
      bridgeWorkspaceBase: "/Users/me/Developer",
      agentWorkspaceDir: "/Users/me/Developer/my-app",
      isolatedChatOnly: false,
      cursorMode: "ask",
    });
    expect(text).toBe(
      "Via cursor-api-proxy → Cursor CLI. workspace=/Users/me/Developer; agent cwd=/Users/me/Developer/my-app; mode=ask.",
    );
  });

  it("dedupes to cwd= only when workspace matches cwd and not sandboxed", () => {
    const text = buildBridgeContextPreamble({
      headers: {},
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "ask",
    });
    expect(text).toContain("cwd=/w");
    expect(text).not.toContain("workspace=");
    expect(text).not.toContain("temp sandbox");
  });

  it("includes the X-Cursor-Workspace line outside chat-only", () => {
    const text = buildBridgeContextPreamble({
      headers: { "x-cursor-workspace": "/Users/me/Developer/my-app" },
      bridgeWorkspaceBase: "/Users/me/Developer",
      agentWorkspaceDir: "/Users/me/Developer/my-app",
      isolatedChatOnly: false,
      cursorMode: "agent",
    });
    expect(text.split("\n")[1]).toBe(
      "X-Cursor-Workspace=/Users/me/Developer/my-app",
    );
  });

  it("prefers X-Cursor-Invoke-From over X-Cursor-Proxy-Client", () => {
    const text = buildBridgeContextPreamble({
      headers: {
        "x-cursor-proxy-client": "claude-cli-homebrew",
        "x-cursor-invoke-from": "cursor-claude-extension",
      },
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "agent",
    });
    expect(text).toContain("client=cursor-claude-extension");
    expect(text).not.toContain("claude-cli-homebrew");
  });

  it("uses X-Cursor-Proxy-Client when invoke-from absent", () => {
    const text = buildBridgeContextPreamble({
      headers: {
        "x-cursor-proxy-client": "sdk-helper",
      },
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "ask",
    });
    expect(text).toContain("client=sdk-helper");
  });

  it("does not add a client line from User-Agent alone", () => {
    const text = buildBridgeContextPreamble({
      headers: { "user-agent": "curl/8" },
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "ask",
    });
    expect(text).not.toContain("client=");
    expect(text).not.toContain("curl");
  });

  it("appends operator context extra on its own line", () => {
    const text = buildBridgeContextPreamble({
      headers: {},
      bridgeWorkspaceBase: "/w",
      agentWorkspaceDir: "/w",
      isolatedChatOnly: false,
      cursorMode: "ask",
      contextExtra: "Default ValNet apps under ~/Sites.",
    });
    expect(text).toContain("Default ValNet apps under ~/Sites.");
  });
});
