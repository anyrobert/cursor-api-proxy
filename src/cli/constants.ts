import os from "node:os";
import path from "node:path";

export const ACCOUNTS_DIR = path.join(
  process.env["HOME"] || process.env["USERPROFILE"] || os.homedir(),
  ".cursor-api-proxy",
  "accounts",
);
