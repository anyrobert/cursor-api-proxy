/**
 * Create a stateful stream parser for Cursor CLI stream-json output.
 *
 * The CLI emits individual assistant delta chunks and then a final assistant
 * message containing the full accumulated text. We track what we've already
 * emitted so the final duplicate is skipped.
 */
export function createStreamParser(
  onText: (text: string) => void,
  onDone: () => void,
): (line: string) => void {
  let accumulated = "";
  let done = false;

  return (line: string) => {
    if (done) return;
    try {
      const obj = JSON.parse(line) as {
        type?: string;
        subtype?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };

      if (obj.type === "assistant" && obj.message?.content) {
        const text = obj.message.content
          .filter((p) => p.type === "text" && p.text)
          .map((p) => p.text!)
          .join("");
        if (!text) return;

        if (text === accumulated) return;

        if (text.startsWith(accumulated) && accumulated.length > 0) {
          const delta = text.slice(accumulated.length);
          if (delta) onText(delta);
          accumulated = text;
        } else {
          onText(text);
          accumulated += text;
        }
      }

      if (obj.type === "result" && obj.subtype === "success") {
        done = true;
        onDone();
      }
    } catch {
      /* ignore parse errors for non-JSON lines */
    }
  };
}
