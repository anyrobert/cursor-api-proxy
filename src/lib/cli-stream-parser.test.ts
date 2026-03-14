import { describe, it, expect, vi } from "vitest";
import { createStreamParser } from "./cli-stream-parser.js";

describe("createStreamParser", () => {
  it("emits incremental text deltas", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const parse = createStreamParser(onText, onDone);

    parse(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello" }] },
    }));
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("Hello");

    parse(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    }));
    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText).toHaveBeenLastCalledWith(" world");
  });

  it("deduplicates final full message (skip when text === accumulated)", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const parse = createStreamParser(onText, onDone);

    parse(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    }));
    parse(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi there" }] },
    }));
    expect(onText).toHaveBeenCalledTimes(2);
    expect(onText).toHaveBeenNthCalledWith(1, "Hi");
    expect(onText).toHaveBeenNthCalledWith(2, " there");

    // Final duplicate: full accumulated text again
    parse(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi there" }] },
    }));
    expect(onText).toHaveBeenCalledTimes(2); // no new call
  });

  it("calls onDone when result/success received", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const parse = createStreamParser(onText, onDone);

    parse(JSON.stringify({ type: "result", subtype: "success" }));
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onText).not.toHaveBeenCalled();
  });

  it("ignores lines after done", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const parse = createStreamParser(onText, onDone);

    parse(JSON.stringify({ type: "result", subtype: "success" }));
    parse(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "late" }] },
    }));
    expect(onText).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("ignores non-assistant lines", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const parse = createStreamParser(onText, onDone);

    parse(JSON.stringify({ type: "user", message: {} }));
    parse(JSON.stringify({ type: "assistant", message: { content: [] } }));
    parse('{"type":"assistant","message":{"content":[{"type":"code","text":"x"}]}}');
    expect(onText).not.toHaveBeenCalled();
  });

  it("ignores parse errors (non-JSON lines)", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const parse = createStreamParser(onText, onDone);

    parse("not json");
    parse("{");
    parse("");
    expect(onText).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("handles first message as full text (no prefix match)", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const parse = createStreamParser(onText, onDone);

    parse(JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Full response" }] },
    }));
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("Full response");
  });

  it("joins multiple text parts in one message", () => {
    const onText = vi.fn();
    const onDone = vi.fn();
    const parse = createStreamParser(onText, onDone);

    parse(JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Hello" },
          { type: "text", text: " " },
          { type: "text", text: "world" },
        ],
      },
    }));
    expect(onText).toHaveBeenCalledTimes(1);
    expect(onText).toHaveBeenCalledWith("Hello world");
  });
});
