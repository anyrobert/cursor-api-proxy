import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { request } from "node:https";

const execFileAsync = promisify(execFile);
const IMAGE_LIMIT = 10 * 1024 * 1024;
const VIDEO_LIMIT = 40 * 1024 * 1024;
const MAX_IMAGES = 12;
/** Wall-clock budget for one remote media fetch, redirects included. */
const FETCH_DEADLINE_MS = 30_000;
/** Some hosts (e.g. upload.wikimedia.org) answer 403 to requests without a User-Agent. */
const FETCH_USER_AGENT = "cursor-api-proxy-media-fetch/1.0";

export type AcpPromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

export class MediaInputError extends Error {}

/**
 * Special-purpose ranges that must never be fetched: loopback, private,
 * link-local (incl. cloud metadata), CGNAT, documentation, multicast and the
 * IPv6 transition prefixes that embed an IPv4 address (mapped, compatible,
 * NAT64, 6to4, Teredo), which could otherwise smuggle a private IPv4 target.
 *
 * Kept as two lists because a BlockList matches IPv4 addresses against IPv6
 * rules through their mapped form, so `::ffff:0:0/96` would block all IPv4.
 */
const NON_PUBLIC_V4 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) {
  NON_PUBLIC_V4.addSubnet(network, prefix, "ipv4");
}
const NON_PUBLIC_V6 = new BlockList();
for (const [network, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
  ["fc00::", 7], ["fe80::", 10], ["fec0::", 10], ["ff00::", 8],
] as const) {
  NON_PUBLIC_V6.addSubnet(network, prefix, "ipv6");
}

/** True only for a syntactically valid IP outside every non-public range. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !NON_PUBLIC_V4.check(address, "ipv4");
  if (family === 6) return !NON_PUBLIC_V6.check(address, "ipv6");
  return false;
}

async function resolvePublicAddress(hostname: string): Promise<{ address: string; family: number }> {
  // URL keeps IPv6 literals bracketed; validate literals directly instead of
  // handing them to DNS.
  const host = hostname.replace(/^\[(.*)\]$/, "$1");
  const literal = isIP(host);
  let addresses: Array<{ address: string; family: number }>;
  if (literal) {
    addresses = [{ address: host, family: literal }];
  } else {
    try {
      addresses = await lookup(host, { all: true });
    } catch {
      throw new MediaInputError("media URL host could not be resolved");
    }
  }
  // Reject when any record is non-public so a mixed answer cannot be used to
  // slip a private address past the check.
  if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
    throw new MediaInputError("media URL resolves to a non-public address");
  }
  return addresses[0];
}

async function download(
  raw: string,
  limit: number,
  redirects = 0,
  deadline = Date.now() + FETCH_DEADLINE_MS,
): Promise<{ data: Buffer; mime: string }> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new MediaInputError("media URL is invalid"); }
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password) {
    throw new MediaInputError("media URL must be public HTTPS on port 443");
  }
  const selected = await resolvePublicAddress(url.hostname);
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new MediaInputError("media download timed out");
  return new Promise((resolvePromise, rejectPromise) => {
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const resolve = (media: { data: Buffer; mime: string }) => {
      clearTimeout(deadlineTimer);
      resolvePromise(media);
    };
    const reject = (error: unknown) => {
      clearTimeout(deadlineTimer);
      rejectPromise(error);
    };
    const req = request(url, {
      method: "GET",
      // Pin the connection to the address validated above so a second DNS
      // answer cannot rebind it to a private target.
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [selected]);
        else callback(null, selected.address, selected.family);
      },
      timeout: 15_000,
      headers: { Accept: "image/*,video/*", "User-Agent": FETCH_USER_AGENT },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0)) {
        const location = res.headers.location;
        res.resume();
        if (!location || redirects >= 2) { reject(new MediaInputError("media redirect limit exceeded")); return; }
        download(new URL(location, url).href, limit, redirects + 1, deadline).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new MediaInputError(`media fetch returned HTTP ${res.statusCode}`)); return; }
      if (Number(res.headers["content-length"] ?? 0) > limit) {
        req.destroy(new MediaInputError("media exceeds size limit"));
        return;
      }
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
    // The socket `timeout` option only fires on idle sockets, so a server that
    // drips bytes could hold the request open indefinitely; enforce a total
    // deadline (shared across redirects) as well.
    deadlineTimer = setTimeout(
      () => req.destroy(new MediaInputError("media download timed out")),
      remainingMs,
    );
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
