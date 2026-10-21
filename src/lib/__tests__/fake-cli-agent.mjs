/**
 * Fake Cursor CLI (`agent --print ...`) for handler tests. It never talks to
 * Cursor: FAKE_CLI_SCENARIO picks the answer it prints and how it exits.
 * With `--output-format stream-json` it prints what the real CLI does: one
 * assistant line per delta, the full message again, then a success result.
 */
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const scenario = process.env.FAKE_CLI_SCENARIO || "";
const streamJson = process.argv.includes("stream-json");
/** Raw CLI output the proxy must keep out of client responses. */
const SECRET_STDERR = "agent: token=secret-cli-detail\n";

function assistantLine(text) {
  return `${JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  })}\n`;
}

/** A finished answer, as text or as stream-json deltas plus the result line. */
function answer(chunks) {
  if (!streamJson) return chunks.join("");
  return (
    chunks.map(assistantLine).join("") +
    assistantLine(chunks.join("")) +
    `${JSON.stringify({ type: "result", subtype: "success" })}\n`
  );
}

/** Text the agent printed before it died, with no result line. */
function partial(text) {
  return streamJson ? assistantLine(text) : text;
}

/**
 * "persist_model_config" saves the requested model in the CLI config dir the
 * way the chat command does (#87): `--model` sets `model` and
 * `hasChangedDefaultModel`, the selection adds `selectedModel` and
 * `modelSelectionHistory`, and the chat is stored under `chats/`. The answer
 * is the JSON of the config dir the run used and the cli-config.json it
 * found there at startup. "persist_model_config_fail" then exits 1, and
 * "persist_model_config_hang" waits until it is killed. A config dir outside
 * the OS temp dir (a real ~/.cursor) is never read or written: exit 70.
 */
function cliConfigDir() {
  const explicit = process.env.CURSOR_CONFIG_DIR;
  if (explicit?.trim()) return explicit;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg?.trim()) return join(xdg, "cursor");
  return join(homedir(), ".cursor");
}

function insideTmp(dir) {
  let real;
  try {
    real = realpathSync(dir);
  } catch {
    real = resolve(dir);
  }
  return real.startsWith(`${realpathSync(tmpdir())}${sep}`);
}

function persistModelConfig() {
  const dir = cliConfigDir();
  if (!insideTmp(dir)) {
    process.stderr.write(`__FAKE_CLI_REFUSED_CONFIG_DIR__:${dir}\n`);
    process.exit(70);
  }
  const file = join(dir, "cli-config.json");
  let seen = null;
  try {
    seen = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    /* the CLI starts from defaults */
  }
  const i = process.argv.indexOf("--model");
  const model = i >= 0 ? process.argv[i + 1] : "auto";
  const saved = {
    ...seen,
    model: { modelId: model },
    hasChangedDefaultModel: true,
    selectedModel: { modelId: model, parameters: [] },
    modelSelectionHistory: [model, ...(seen?.modelSelectionHistory ?? [])],
  };
  mkdirSync(join(dir, "chats", "fake-chat"), { recursive: true });
  writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "chats", "fake-chat", "store.db"), "");
  return JSON.stringify({ configDir: dir, seen });
}

const runs = {
  exit_after_text: () => [partial("Partial answer "), SECRET_STDERR, 1],
  exit_silent: () => ["", SECRET_STDERR, 1],
  // Cursor's answer once the account's plan is used up (#65).
  plan_limit: () => [answer(["Upgrade your ", "plan to continue"]), "", 0],
  payment_method: () => [answer(["Add a payment ", "method to continue"]), "", 0],
  plan_limit_stderr: () => ["", "Error: Upgrade your plan to continue\n", 1],
  prepaid_balance: () => [
    "",
    "ActionRequiredError: Your team's prepaid balance is used up Buy credits for your team to keep going.\n",
    1,
  ],
  // Real answers that start like the plan-limit reply.
  upgrade_mention: () => [
    answer(["Upgrade your plan to continue ", "using premium models, or pick a free one."]),
    "",
    0,
  ],
  plan_limit_prefix: () => [answer(["Upgrade", " your plan"]), "", 0],
  persist_model_config: () => [answer([persistModelConfig()]), "", 0],
  persist_model_config_fail: () => [partial(persistModelConfig()), SECRET_STDERR, 1],
  persist_model_config_hang: () => {
    setInterval(() => {}, 60_000);
    return [partial(persistModelConfig()), "", 0];
  },
};

const [stdout, stderr, code] = (
  runs[scenario] ?? (() => [answer(["Hello ", "from fake CLI"]), "", 0])
)();
process.stdout.write(stdout);
process.stderr.write(stderr);
// Exit once the pipes drain, so the proxy reads every line first.
process.exitCode = code;
