import { tmpdir } from "node:os";

import { run, type RunResult } from "./process.js";

export type CursorCliModel = { id: string; name: string };

/**
 * `agent --list-models` failed: the CLI did not start, exited non-zero or
 * printed no model catalog. The message is safe to show clients;
 * `diagnostics` (the binary's path and the CLI's output) is for server logs
 * only.
 */
export class CursorCliModelsError extends Error {
  constructor(readonly diagnostics: string) {
    super("The Cursor CLI could not list models. See server logs for details.");
    this.name = "CursorCliModelsError";
  }
}

const SET_AGENT_BIN =
  "Set CURSOR_AGENT_BIN to the Cursor cursor-agent executable.";

/** Strip CSI / OSC ANSI sequences so colored CLI output still parses. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

export function parseCursorCliModels(output: string): CursorCliModel[] {
  const lines = stripAnsi(output)
    .split(/\r?\n/g)
    .map((l) => l.trim());
  const models: CursorCliModel[] = [];

  for (const line of lines) {
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._:/-]*)\s+-\s+(.*)$/);
    if (!match) continue;
    const id = match[1];
    const rawName = match[2];
    const name = rawName.replace(/\s*\([^)]*\)\s*$/g, "").trim();
    models.push({ id, name: name || id });
  }

  const byId = new Map<string, CursorCliModel>();
  for (const m of models) byId.set(m.id, m);
  return [...byId.values()];
}

export async function listCursorCliModels(args: {
  agentBin: string;
  timeoutMs: number;
}): Promise<CursorCliModel[]> {
  const bin = JSON.stringify(args.agentBin);
  let list: RunResult;
  try {
    // Parent shells (Cursor agent, CI) often set FORCE_COLOR=1; that paints
    // `--list-models` with ANSI and used to yield an empty OpenAI model list.
    list = await run(args.agentBin, ["--list-models"], {
      cwd: tmpdir(),
      timeoutMs: args.timeoutMs,
      envOverrides: {
        NO_COLOR: "1",
        FORCE_COLOR: "0",
        TERM: "dumb",
      },
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CursorCliModelsError(
      `Cursor CLI check failed for ${bin}: --list-models could not run (${reason}). ${SET_AGENT_BIN}`,
    );
  }

  if (list.code !== 0) {
    throw new CursorCliModelsError(
      `Cursor CLI check failed for ${bin}: --list-models exited ${list.code}: ${
        list.stderr.trim() || "no diagnostic output"
      }. ${SET_AGENT_BIN}`,
    );
  }

  const models = parseCursorCliModels(list.stdout);
  if (models.length === 0) {
    const sample = stripAnsi(`${list.stdout}\n${list.stderr}`).trim().slice(0, 240);
    throw new CursorCliModelsError(
      `${bin} did not return a Cursor model catalog and may be another vendor's "agent" binary.${
        sample ? ` Output: ${sample}` : ""
      } ${SET_AGENT_BIN}`,
    );
  }
  return models;
}
