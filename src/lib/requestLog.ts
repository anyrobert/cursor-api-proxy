import * as fs from "node:fs";

export function logIncoming(method: string, path: string, remoteAddress: string): void {
  console.log(`[${new Date().toISOString()}] Incoming: ${method} ${path} (from ${remoteAddress})`);
}

export function appendSessionLine(
  logPath: string,
  method: string,
  path: string,
  remoteAddress: string,
  statusCode: number,
): void {
  const line = `${new Date().toISOString()} ${method} ${path} ${remoteAddress} ${statusCode}\n`;
  try {
    fs.appendFileSync(logPath, line);
  } catch (err) {
    console.error("Failed to write sessions log:", err);
  }
}
