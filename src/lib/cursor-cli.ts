import { tmpdir } from "node:os";

import { run } from "./process.js";

export type CursorCliModel = { id: string; name: string };

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
  // Parent shells (Cursor agent, CI) often set FORCE_COLOR=1; that paints
  // `--list-models` with ANSI and used to yield an empty OpenAI model list.
  const list = await run(args.agentBin, ["--list-models"], {
    cwd: tmpdir(),
    timeoutMs: args.timeoutMs,
    envOverrides: {
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      TERM: "dumb",
    },
  });

  if (list.code !== 0) {
    throw new Error(
      `Cursor CLI check failed for ${JSON.stringify(
        args.agentBin,
      )}: --list-models exited ${list.code}: ${
        list.stderr.trim() || "no diagnostic output"
      }. Set CURSOR_AGENT_BIN to the Cursor cursor-agent executable.`,
    );
  }

  const models = parseCursorCliModels(list.stdout);
  if (models.length === 0) {
    const sample = stripAnsi(`${list.stdout}\n${list.stderr}`).trim().slice(0, 240);
    throw new Error(
      `${JSON.stringify(
        args.agentBin,
      )} did not return a Cursor model catalog and may be another vendor's "agent" binary.${
        sample ? ` Output: ${sample}` : ""
      } Set CURSOR_AGENT_BIN to the Cursor cursor-agent executable.`,
    );
  }
  return models;
}
