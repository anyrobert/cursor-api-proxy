/**
 * Fake Cursor CLI (`agent --print ...`) for handler tests. It never talks to
 * Cursor: FAKE_CLI_SCENARIO picks the answer it prints and how it exits.
 * With `--output-format stream-json` it prints what the real CLI does: one
 * assistant line per delta, the full message again, then a success result.
 */
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

const runs = {
  exit_after_text: () => [partial("Partial answer "), SECRET_STDERR, 1],
  exit_silent: () => ["", SECRET_STDERR, 1],
};

const [stdout, stderr, code] = (
  runs[scenario] ?? (() => [answer(["Hello ", "from fake CLI"]), "", 0])
)();
process.stdout.write(stdout);
process.stderr.write(stderr);
// Exit once the pipes drain, so the proxy reads every line first.
process.exitCode = code;
