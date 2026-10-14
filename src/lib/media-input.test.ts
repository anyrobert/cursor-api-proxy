import { describe, expect, it } from "vitest";
import { mediaPromptBlocks, MediaInputError } from "./media-input.js";

const redPng = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NMQEAAAjDMMC/ZzDBvlRA01vZJvwHAAAAAAAAAAAAbx2jxAE/i2AjOgAAAABJRU5ErkJggg==";

describe("mediaPromptBlocks", () => {
  it("preserves OpenAI image bytes for ACP instead of reducing them to text", async () => {
    const blocks = await mediaPromptBlocks([{ role: "user", content: [
      { type: "text", text: "What color?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${redPng}` } },
    ] }]);
    expect(blocks).toEqual([{ type: "image", mimeType: "image/png", data: redPng }]);
  });

  it("accepts Anthropic base64 image blocks", async () => {
    const blocks = await mediaPromptBlocks([{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: "image/png", data: redPng } },
    ] }]);
    expect(blocks[0]).toMatchObject({ type: "image", mimeType: "image/png", data: redPng });
  });

  it("rejects private media URLs before Cursor is invoked", async () => {
    await expect(mediaPromptBlocks([{ content: [
      { type: "image_url", image_url: { url: "http://127.0.0.1/secret" } },
    ] }])).rejects.toBeInstanceOf(MediaInputError);
  });

  it("does not silently accept missing video media", async () => {
    await expect(mediaPromptBlocks([{ content: [
      { type: "video_url", video_url: {} },
    ] }])).rejects.toThrow("video block has no supported source");
  });
});
