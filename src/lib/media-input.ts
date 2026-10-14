import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { request } from "node:https";

const execFileAsync = promisify(execFile);
const IMAGE_LIMIT = 10 * 1024 * 1024;
const VIDEO_LIMIT = 40 * 1024 * 1024;
const MAX_IMAGES = 12;

export type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export class MediaInputError extends Error {}

function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    return !(p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 192 && p[1] === 0) || (p[0] === 198 && (p[1] === 18 || p[1] === 19)));
  }
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return !(a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") ||
      a.startsWith("fe8") || a.startsWith("fe9") || a.startsWith("fea") || a.startsWith("feb") ||
      a.startsWith("::ffff:") || a.startsWith("2001:db8:"));
  }
  return false;
}

async function download(raw: string, limit: number, redirects = 0): Promise<{ data: Buffer; mime: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new MediaInputError("media URL is invalid"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
    throw new MediaInputError("media URL must be public HTTPS on port 443");
  }
  const addresses = await lookup(url.hostname, { all: true });
  const selected = addresses.find((entry) => publicAddress(entry.address));
  if (!selected || addresses.some((entry) => !publicAddress(entry.address))) {
    throw new MediaInputError("media URL resolves to a non-public address");
  }
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: "GET",
      lookup: (_host, _options, callback) => callback(null, selected.address, selected.family),
      timeout: 15_000,
      headers: { Accept: "image/*,video/*" },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        const location = res.headers.location;
        res.resume();
        if (!location || redirects >= 2) { reject(new MediaInputError("media redirect limit exceeded")); return; }
        download(new URL(location, url).href, limit, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new MediaInputError(`media fetch returned HTTP ${res.statusCode}`)); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > limit) { req.destroy(new MediaInputError("media exceeds size limit")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => resolve({ data: Buffer.concat(chunks), mime: String(res.headers["content-type"] ?? "").split(";")[0].toLowerCase() }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new MediaInputError("media download timed out")));
    req.on("error", reject);
    req.end();
  });
}

async function loadMedia(raw: string, limit: number): Promise<{ data: Buffer; mime: string }> {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/s.exec(raw);
  if (match) {
    if (match[2].length > Math.ceil(limit * 4 / 3) + 8) throw new MediaInputError("media exceeds size limit");
    const data = Buffer.from(match[2], "base64");
    if (data.length > limit) throw new MediaInputError("media exceeds size limit");
    return { data, mime: match[1].toLowerCase() };
  }
  return download(raw, limit);
}

function imageBlock(data: Buffer, mime: string): AcpPromptBlock {
  if (!mime.startsWith("image/") || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime)) {
    throw new MediaInputError("unsupported image MIME type");
  }
  return { type: "image", mimeType: mime, data: data.toString("base64") };
}

async function videoFrames(data: Buffer, mime: string): Promise<AcpPromptBlock[]> {
  if (!["video/mp4", "video/webm", "video/quicktime"].includes(mime)) {
    throw new MediaInputError("unsupported video MIME type");
  }
  const dir = await mkdtemp(join(tmpdir(), "cursor-media-"));
  try {
    const input = join(dir, "input");
    await writeFile(input, data, { mode: 0o600 });
    try {
      await execFileAsync("ffmpeg", ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", input,
        "-vf", "fps=1/5:round=up,scale=768:-2:force_original_aspect_ratio=decrease", "-frames:v", "3",
        join(dir, "frame-%02d.jpg")], { timeout: 20_000, maxBuffer: 64 * 1024 });
    } catch { throw new MediaInputError("video decoding failed"); }
    const files = (await readdir(dir)).filter((name) => name.startsWith("frame-")).sort();
    if (!files.length) throw new MediaInputError("video has no decodable frames");
    const blocks: AcpPromptBlock[] = [{ type: "text", text: `[Video: ${files.length} sampled frames, approximately five seconds apart]` }];
    for (const file of files) blocks.push(imageBlock(await readFile(join(dir, file)), "image/jpeg"));
    return blocks;
  } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Resolve media before invoking Cursor so unsupported media can never return a text-only 200. */
export async function mediaPromptBlocks(items: unknown[]): Promise<AcpPromptBlock[]> {
  const result: AcpPromptBlock[] = [];
  for (const item of items) {
    const parts = (item as any)?.content;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== "object") continue;
      const type = part.type;
      if (type === "image_url" || type === "input_image" || type === "image") {
        const source = part.image_url ?? part.url ?? part.source;
        const raw = typeof source === "string" ? source : source?.url ??
          (source?.type === "base64" && source?.data && source?.media_type
            ? `data:${source.media_type};base64,${source.data}` : undefined);
        if (typeof raw !== "string") throw new MediaInputError("image block has no supported source");
        const media = await loadMedia(raw, IMAGE_LIMIT);
        result.push(imageBlock(media.data, media.mime));
      } else if (type === "video_url" || type === "input_video" || type === "video") {
        const source = part.video_url ?? part.url ?? part.source;
        const raw = typeof source === "string" ? source : source?.url ??
          (source?.data && source?.media_type ? `data:${source.media_type};base64,${source.data}` : undefined);
        if (typeof raw !== "string") throw new MediaInputError("video block has no supported source");
        const media = await loadMedia(raw, VIDEO_LIMIT);
        result.push(...await videoFrames(media.data, media.mime));
      }
      if (result.filter((block) => block.type === "image").length > MAX_IMAGES) {
        throw new MediaInputError("too many media frames (maximum 12 images)");
      }
    }
  }
  return result;
}
