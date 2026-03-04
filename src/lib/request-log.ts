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

/**
 * Log an agent execution error to console and sessions log.
 * Returns the error message for use in API responses.
 */
export function logAgentError(
  logPath: string,
  method: string,
  pathname: string,
  remoteAddress: string,
  exitCode: number,
  stderr: string,
): string {
  const errMsg = `Cursor CLI failed (exit ${exitCode}): ${stderr.trim()}`;
  console.error(`[${new Date().toISOString()}] Agent error: ${errMsg}`);
  try {
    const truncated = stderr.trim().slice(0, 200).replace(/\n/g, " ");
    fs.appendFileSync(
      logPath,
      `${new Date().toISOString()} ERROR ${method} ${pathname} ${remoteAddress} agent_exit_${exitCode} ${truncated}\n`,
    );
  } catch {
    /* ignore */
  }
  return errMsg;
}
