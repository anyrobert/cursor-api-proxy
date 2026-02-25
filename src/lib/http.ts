import * as http from "node:http";

export function extractBearerToken(req: http.IncomingMessage): string | undefined {
  const h = req.headers["authorization"];
  if (!h) return undefined;
  const val = Array.isArray(h) ? h[0] : h;
  const match = val.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : undefined;
}

export function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
