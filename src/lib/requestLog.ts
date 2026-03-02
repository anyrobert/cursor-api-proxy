import * as fs from "node:fs";
import * as path from "node:path";

export function logIncoming(method: string, pathname: string, remoteAddress: string): void {
  console.log(`[${new Date().toISOString()}] Incoming: ${method} ${pathname} (from ${remoteAddress})`);
}

export function appendSessionLine(
  logPath: string,
  method: string,
  pathname: string,
  remoteAddress: string,
  statusCode: number,
): void {
  const line = `${new Date().toISOString()} ${method} ${pathname} ${remoteAddress} ${statusCode}\n`;
  try {
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(logPath, line);
  } catch (err) {
    console.error("Failed to write sessions log:", err);
  }
}
