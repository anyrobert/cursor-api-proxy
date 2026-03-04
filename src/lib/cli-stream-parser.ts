/**
 * Parse a line from Cursor CLI stream-json output.
 * Calls onText for each text chunk and onDone when the stream completes.
 */
export function parseCliStreamLine(
  line: string,
  onText: (text: string) => void,
  onDone: () => void,
): void {
  try {
    const obj = JSON.parse(line) as {
      type?: string;
      subtype?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    if (obj.type === "assistant" && obj.message?.content) {
      for (const part of obj.message.content) {
        if (part.type === "text" && part.text) onText(part.text);
      }
    }
    if (obj.type === "result" && obj.subtype === "success") onDone();
  } catch {
    /* ignore parse errors for non-JSON lines */
  }
}
