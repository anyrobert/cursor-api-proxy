import { describe, expect, it } from "vitest";

import { AcpTrailerFilter, RETRIABLE_TRAILER } from "./acp-text-trailer.js";

/** The chunk the Cursor CLI sends after the answer (`\n\nError: ${error}`). */
const CLI_TRAILER = `\n\n${RETRIABLE_TRAILER}`;
const ANSWER = "The image shows a red square.";

type Step = string | "<tool_call>";

function filtered(steps: readonly Step[]): { text: string; emitted: string[] } {
  const emitted: string[] = [];
  const filter = new AcpTrailerFilter((text) => emitted.push(text));
  for (const step of steps) {
    if (step === "<tool_call>") filter.flush();
    else filter.push(step);
  }
  filter.end();
  return { text: emitted.join(""), emitted };
}

/** Every way to cut `text` into three chunks (two cut points). */
function threeWaySplits(text: string): string[][] {
  const splits: string[][] = [];
  for (let i = 0; i <= text.length; i += 1) {
    for (let j = i; j <= text.length; j += 1) {
      splits.push([text.slice(0, i), text.slice(i, j), text.slice(j)]);
    }
  }
  return splits;
}

describe("AcpTrailerFilter", () => {
  it("drops the trailer the CLI sends as its own last chunk", () => {
    expect(filtered([ANSWER, CLI_TRAILER]).text).toBe(ANSWER);
  });

  it("drops the trailer in the same chunk as the answer, and whitespace after it", () => {
    expect(filtered([`${ANSWER}${CLI_TRAILER}`]).text).toBe(ANSWER);
    expect(filtered([ANSWER, `${CLI_TRAILER}\n`]).text).toBe(ANSWER);
  });

  it("drops a trailer split across chunks without streaming any of it", () => {
    const pieces = [ANSWER, "\n", "\nErr", "or: Retriable", "Error: Writable", "Iterable is clo", "sed"];
    const emitted: string[] = [];
    const filter = new AcpTrailerFilter((text) => emitted.push(text));
    for (const piece of pieces) {
      filter.push(piece);
      expect(ANSWER.startsWith(emitted.join(""))).toBe(true);
    }
    filter.end();
    expect(emitted.join("")).toBe(ANSWER);
  });

  it("drops the trailer however the turn is chunked", () => {
    for (const chunks of threeWaySplits(`${ANSWER}${CLI_TRAILER}`)) {
      expect(filtered(chunks).text).toBe(ANSWER);
    }
  });

  it("keeps a start of the trailer when the turn ends without the rest", () => {
    expect(filtered([ANSWER, "\n\nError: Retriable"]).text).toBe(
      `${ANSWER}\n\nError: Retriable`,
    );
    expect(filtered([ANSWER, "\n\n"]).text).toBe(`${ANSWER}\n\n`);
  });

  it("keeps the trailer text when the answer goes on after it", () => {
    const answer = `The CLI printed${CLI_TRAILER} and then recovered.`;
    for (const chunks of threeWaySplits(answer)) {
      expect(filtered(chunks).text).toBe(answer);
    }
  });

  it("leaves an answer without the trailer unchanged", () => {
    const answer = "Use `Error: Retry` as the title.\n\nSee E\n";
    for (const chunks of threeWaySplits(answer)) {
      expect(filtered(chunks).text).toBe(answer);
    }
  });

  it("holds back only text that could start the trailer", () => {
    const emitted: string[] = [];
    const filter = new AcpTrailerFilter((text) => emitted.push(text));
    filter.push("The answer is E");
    expect(emitted).toEqual(["The answer is"]);
    filter.push("ight.\n\n");
    expect(emitted).toEqual(["The answer is", " Eight."]);
    filter.push("Next");
    expect(emitted.join("")).toBe("The answer is Eight.\n\nNext");
  });

  it("matches the trailer only after whitespace or as the whole turn", () => {
    const glued = `TypeError: RetriableError: WritableIterable is closed`;
    expect(filtered([glued]).text).toBe(glued);
    expect(filtered([`Done.${RETRIABLE_TRAILER}`]).text).toBe(
      `Done.${RETRIABLE_TRAILER}`,
    );
    expect(filtered([CLI_TRAILER]).text).toBe("");
    expect(filtered([RETRIABLE_TRAILER]).text).toBe("");
  });

  it("emits held text at a tool call and keeps a trailer that a tool call follows", () => {
    const { emitted } = filtered(["Let me look.\n\n", "<tool_call>", "It is red.", CLI_TRAILER]);
    expect(emitted).toEqual(["Let me look.", "\n\n", "It is red."]);
    expect(filtered([ANSWER, CLI_TRAILER, "<tool_call>", "Next."]).text).toBe(
      `${ANSWER}${CLI_TRAILER}Next.`,
    );
  });

  it("starts each turn afresh", () => {
    const emitted: string[] = [];
    const filter = new AcpTrailerFilter((text) => emitted.push(text));
    filter.push("First.");
    filter.end();
    filter.push(RETRIABLE_TRAILER);
    filter.end();
    expect(emitted).toEqual(["First."]);
  });
});
