import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { launch as launchChrome } from "chrome-launcher";

import { loadEnvConfig } from "../lib/env.js";
import { ACCOUNTS_DIR } from "./constants.js";
import { readKeychainToken, writeCachedToken } from "./usage.js";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const LOGIN_URL_RE =
  /(https:\/\/cursor\.com\/loginDeepControl.*?redirectTarget=cli)/s;

async function openIncognito(url: string, proxies: string[]): Promise<void> {
  const chromeFlags = [
    "--incognito",
    "--new-window",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-translate",
  ];

  if (proxies.length > 0) {
    const proxy = proxies[Math.floor(Math.random() * proxies.length)];
    chromeFlags.push(`--proxy-server=${proxy}`);
    console.log(`🔀 Using proxy: ${proxy}`);
  }

  try {
    await launchChrome({
      startingUrl: url,
      chromeFlags,
      ignoreDefaultFlags: true,
      handleSIGINT: false,
      logLevel: "silent",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`\n🌐 Could not open Chrome automatically: ${msg}`);
    console.log(
      `Please open this URL in a private/incognito window:\n${url}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export async function handleLogin(
  accountName: string,
  proxies: string[] = [],
): Promise<void> {
  const envCfg = loadEnvConfig();
  const name = accountName || `account-${Date.now().toString().slice(-4)}`;
  const configDir = path.join(ACCOUNTS_DIR, name);

  const dirWasNew = !fs.existsSync(configDir);

  fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });

  console.log(`🔑 Logging into Cursor account: ${name}`);
  console.log(`📁 Config: ${configDir}`);
  console.log("");
  console.log(
    "A Chrome incognito window will open — complete the login there.",
  );
  console.log("");

  return new Promise<void>((resolve, reject) => {
    let browserOpened = false;
    let stdoutBuffer = "";

    const cleanupDir = () => {
      if (!dirWasNew) return;
      try {
        fs.rmSync(configDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    };

    const child = spawn(envCfg.agentBin, ["login"], {
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        CURSOR_CONFIG_DIR: configDir,
        NO_OPEN_BROWSER: "1",
      },
    });

    // Remove all signal handlers once the child exits (success or failure)
    const onCancel = (signal: string) => {
      child.kill();
      cleanupDir();
      if (signal === "SIGINT") console.log("\n\n❌ Login cancelled.");
      process.exit(0);
    };
    const onSigint = () => onCancel("SIGINT");
    const onSigterm = () => onCancel("SIGTERM");
    const onSighup = () => onCancel("SIGHUP");

    const removeSignalHandlers = () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
      process.removeListener("SIGHUP", onSighup);
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    process.once("SIGHUP", onSighup);

    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stdout.write(text);
      stdoutBuffer += text;

      // The agent prints the login URL across multiple chunks — buffer until complete
      if (
        !browserOpened &&
        stdoutBuffer.includes("https://cursor.com/loginDeepControl")
      ) {
        const match = stdoutBuffer.match(LOGIN_URL_RE);
        if (match?.[1]) {
          const url = match[1].replace(/\s+/g, "");
          openIncognito(url, proxies).catch(() => {});
          browserOpened = true;
        }
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      process.stderr.write(data.toString());
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      removeSignalHandlers();
      cleanupDir();
      if (err.code === "ENOENT") {
        console.error(
          `❌ Could not find '${envCfg.agentBin}'. Make sure the Cursor CLI is installed.`,
        );
      } else {
        console.error("❌ Error launching agent login:", err);
      }
      reject(err);
    });

    child.on("exit", (code: number | null) => {
      removeSignalHandlers();
      if (code === 0) {
        // Immediately cache the keychain token for this account so that
        // 'accounts list' can show live usage without needing a prior request.
        const token = readKeychainToken();
        if (token) writeCachedToken(configDir, token);

        console.log(
          `\n✅ Account '${name}' saved — it will be auto-discovered when you start the proxy.`,
        );
        resolve();
      } else {
        cleanupDir();
        console.error(`\n❌ Login failed (exit code ${code}).`);
        reject(new Error(`Login failed with code ${code}`));
      }
    });
  });
}
