import { tmpdir } from "node:os";

import { run } from "./process.js";

export type CursorCliModel = { id: string; name: string };

export function parseCursorCliModels(output: string): CursorCliModel[] {
  const lines = output.split(/\r?\n/g).map((l) => l.trim());
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
  const list = await run(args.agentBin, ["--list-models"], {
    cwd: tmpdir(),
    timeoutMs: args.timeoutMs,
  });

  if (list.code !== 0) {
    throw new Error(`agent --list-models failed: ${list.stderr.trim()}`);
  }

  return parseCursorCliModels(list.stdout);
}
