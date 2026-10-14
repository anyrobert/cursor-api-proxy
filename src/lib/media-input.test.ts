import { EventEmitter } from "node:events";
import { existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { execFileMock, lookupMock, requestMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  lookupMock: vi.fn(),
  requestMock: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
vi.mock("node:https", () => ({ request: requestMock }));

import { isPublicAddress, mediaPromptBlocks, MediaInputError } from "./media-input.js";

const redPng = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NMQEAAAjDMMC/ZzDBvlRA01vZJvwHAAAAAAAAAAAAbx2jxAE/i2AjOgAAAABJRU5ErkJggg==";

type FakeResponse = EventEmitter & {
  statusCode: number;
  headers: Record<string, string>;
  resume: () => void;
};

/** Minimal stand-in for https.ClientRequest; `end()` hands control to the test. */
class FakeRequest extends EventEmitter {
  destroyed = false;

  constructor(
    readonly url: URL,
    readonly options: Record<string, any>,
    private readonly onResponse: (res: FakeResponse) => void,
    private readonly onEnd: (req: FakeRequest) => void,
  ) {
    super();
  }

  end(): void {
    this.onEnd(this);
  }

  destroy(error?: Error): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (error) this.emit("error", error);
  }

  /** Sends status + headers and the given chunks; ends the body unless `open`. */
  respond(
    statusCode: number,
    headers: Record<string, string>,
    chunks: Buffer[] = [],
    open = false,
  ): void {
    const res = Object.assign(new EventEmitter(), {
      statusCode,
      headers,
      resume: () => {},
    });
    this.onResponse(res);
    for (const chunk of chunks) {
      if (this.destroyed) return;
      res.emit("data", chunk);
    }
    if (!open && !this.destroyed) res.emit("end");
  }
}

function serve(onEnd: (req: FakeRequest) => void): FakeRequest[] {
  const requests: FakeRequest[] = [];
  requestMock.mockImplementation((url: URL, options: Record<string, any>, cb: (res: FakeResponse) => void) => {
    const req = new FakeRequest(url, options, cb, onEnd);
    requests.push(req);
    return req;
  });
  return requests;
}

const imagePart = (url: string) => [{ content: [{ type: "image_url", image_url: { url } }] }];

beforeEach(() => {
  execFileMock.mockReset();
  lookupMock.mockReset();
  requestMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

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

  it("rejects an oversized data URL before decoding it", async () => {
    const huge = "A".repeat(15 * 1024 * 1024);
    await expect(mediaPromptBlocks(imagePart(`data:image/png;base64,${huge}`)))
      .rejects.toThrow("media exceeds size limit");
  });
});

describe("isPublicAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.0.8", "192.0.2.1",
    "198.18.0.1", "198.51.100.7", "203.0.113.9", "224.0.0.1", "255.255.255.255",
    "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:8.8.8.8",
    "::127.0.0.1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::a00:1", "2002:7f00:1::1",
    "2001:0:4136:e378:8000:63bf:3fff:fdd2", "2001:db8::1", "fc00::1", "fd12:3456::1",
    "fe80::1", "fec0::1", "ff02::1", "100::1", "localhost", "not-an-ip",
  ])("treats %s as non-public", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "8.8.8.8", "1.1.1.1", "172.32.0.1", "192.0.3.1", "100.128.0.1",
    "2606:4700:4700::1111", "2a00:1450:4001:80b::200e",
  ])("treats %s as public", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });
});

describe("remote media fetch", () => {
  it.each([
    "https://[::1]/x.png",
    "https://[::ffff:127.0.0.1]/x.png",
    "https://[64:ff9b::a9fe:a9fe]/x.png",
    "https://169.254.169.254/latest/meta-data/",
    "https://0x7f000001/x.png",
  ])("rejects IP literal %s without DNS or a connection", async (url) => {
    await expect(mediaPromptBlocks(imagePart(url)))
      .rejects.toThrow("media URL resolves to a non-public address");
    expect(lookupMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("rejects a hostname when any DNS answer is non-public", async () => {
    lookupMock.mockResolvedValue([
      { address: "93.184.215.14", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    await expect(mediaPromptBlocks(imagePart("https://mixed.example/x.png")))
      .rejects.toThrow("media URL resolves to a non-public address");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("reports unresolvable hosts as a media error", async () => {
    lookupMock.mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    await expect(mediaPromptBlocks(imagePart("https://nope.example/x.png")))
      .rejects.toThrow(new MediaInputError("media URL host could not be resolved"));
  });

  it("pins the validated address and identifies itself with a User-Agent", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const requests = serve((req) =>
      req.respond(200, { "content-type": "image/png; charset=binary" }, [Buffer.from(redPng, "base64")]),
    );
    const blocks = await mediaPromptBlocks(imagePart("https://img.example/red.png"));
    expect(blocks).toEqual([{ type: "image", mimeType: "image/png", data: redPng }]);
    const { options } = requests[0];
    expect(options.headers["User-Agent"]).toMatch(/cursor-api-proxy/);
    const pinned = vi.fn();
    options.lookup("img.example", {}, pinned);
    expect(pinned).toHaveBeenCalledWith(null, "93.184.215.14", 4);
  });

  it("re-validates every redirect hop", async () => {
    lookupMock
      .mockResolvedValueOnce([{ address: "93.184.215.14", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    serve((req) => req.respond(302, { location: "https://internal.example/x.png" }));
    await expect(mediaPromptBlocks(imagePart("https://img.example/red.png")))
      .rejects.toThrow("media URL resolves to a non-public address");
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a declared Content-Length over the limit without reading the body", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    serve((req) =>
      req.respond(200, { "content-type": "image/png", "content-length": String(11 * 1024 * 1024) }, [Buffer.alloc(1)]),
    );
    await expect(mediaPromptBlocks(imagePart("https://img.example/big.png")))
      .rejects.toThrow("media exceeds size limit");
  });

  it("stops streaming once the body exceeds the limit", async () => {
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    const chunk = Buffer.alloc(6 * 1024 * 1024);
    const requests = serve((req) => req.respond(200, { "content-type": "image/png" }, [chunk, chunk, chunk]));
    await expect(mediaPromptBlocks(imagePart("https://img.example/big.png")))
      .rejects.toThrow("media exceeds size limit");
    expect(requests[0].destroyed).toBe(true);
  });

  it("enforces a total deadline even while the server keeps dripping bytes", async () => {
    vi.useFakeTimers();
    lookupMock.mockResolvedValue([{ address: "93.184.215.14", family: 4 }]);
    serve((req) => req.respond(200, { "content-type": "image/png" }, [Buffer.alloc(1)], true));
    const pending = mediaPromptBlocks(imagePart("https://slow.example/drip.png"));
    const assertion = expect(pending).rejects.toThrow("media download timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;
  });
});

describe("video frame sampling", () => {
  const videoPart = (mime: string) => [{ content: [
    { type: "video_url", video_url: { url: `data:${mime};base64,${Buffer.from("not really a video").toString("base64")}` } },
  ] }];

  /** Fakes a successful ffmpeg run that writes one JPEG frame. */
  const ffmpegWritesOneFrame = () =>
    execFileMock.mockImplementation((_cmd: string, args: string[], _opts: unknown, cb: (error: Error | null, out?: unknown) => void) => {
      writeFileSync(args[args.length - 1].replace("%02d", "01"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      cb(null, { stdout: "", stderr: "" });
    });

  it.each([
    ["video/mp4", "mov"],
    ["video/quicktime", "mov"],
    ["video/webm", "matroska"],
  ])("pins the %s demuxer to %s and keeps ffmpeg off the network", async (mime, demuxer) => {
    ffmpegWritesOneFrame();
    const blocks = await mediaPromptBlocks(videoPart(mime));
    expect(blocks).toEqual([
      { type: "text", text: "[Video: 1 sampled frames, approximately five seconds apart]" },
      { type: "image", mimeType: "image/jpeg", data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString("base64") },
    ]);
    const [cmd, args] = execFileMock.mock.calls[0] as [string, string[]];
    expect(cmd).toBe("ffmpeg");
    const inputAt = args.indexOf("-i");
    expect(args.slice(inputAt - 4, inputAt)).toEqual(["-protocol_whitelist", "file", "-f", demuxer]);
    expect(existsSync(dirname(args[inputAt + 1]))).toBe(false);
  });

  it("rejects video MIME types without a pinned demuxer before running ffmpeg", async () => {
    await expect(mediaPromptBlocks(videoPart("video/x-msvideo")))
      .rejects.toThrow("unsupported video MIME type");
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("explains a missing ffmpeg binary instead of a generic decode failure", async () => {
    execFileMock.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (error: Error) => void) => {
      cb(Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" }));
    });
    await expect(mediaPromptBlocks(videoPart("video/mp4")))
      .rejects.toThrow("video input requires ffmpeg on the proxy host");
  });
});
