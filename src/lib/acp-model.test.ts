import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runAcpSync } from "./acp-client.js";
import {
  applyAcpModelPlan,
  configureAcpSessionModel,
  decideAcpModel,
  type AcpCatalogModel,
  type AcpConfigOption,
  type AcpModelPlan,
  type AcpSessionModelState,
} from "./acp-model.js";
import { AcpToolSession } from "./acp-tool-session.js";

const testsDir = join(process.cwd(), "src", "lib", "__tests__");
const fakeServerPath = join(testsDir, "fake-acp-server.mjs");

/** Captured from the real Cursor CLI; see `_source` in the fixture. */
const catalog = JSON.parse(
  readFileSync(join(testsDir, "acp-real-catalog.json"), "utf8"),
) as {
  sessionNewSample: {
    result: { models: { availableModels: AcpCatalogModel[] } };
  };
  familyOptions: Record<string, AcpConfigOption[]>;
  listModels: Record<string, string>;
  sessions: Record<
    string,
    { currentModelId: string; values: Record<string, string> }
  >;
};

const availableModels = catalog.sessionNewSample.result.models.availableModels;
const publicIds = Object.keys(catalog.listModels);

/** The `session/new` model state the CLI reported for `--model <id>`. */
function realSession(
  id: string,
  currentModelId = catalog.sessions[id]!.currentModelId,
): AcpSessionModelState {
  const values = catalog.sessions[id]!.values;
  return {
    models: { currentModelId, availableModels },
    configOptions: (catalog.familyOptions[currentModelId] ?? []).map(
      (option) => ({
        ...option,
        currentValue: values[option.id] ?? option.currentValue,
      }),
    ),
  };
}

function aliases(id: string): string[] {
  return [catalog.listModels[id]!];
}

/** Apply a plan against the captured CLI and return the final selection. */
async function simulate(
  id: string,
  plan: AcpModelPlan,
): Promise<{ model: string; values: Record<string, string>; calls: string[] }> {
  const session = realSession(id);
  let model = session.models!.currentModelId!;
  let options = structuredClone(session.configOptions!);
  const calls: string[] = [];
  await applyAcpModelPlan(plan, session.configOptions!, async (configId, value) => {
    calls.push(`${configId}=${value}`);
    if (configId === "model") {
      model = value;
      options = structuredClone(catalog.familyOptions[value] ?? []);
    } else {
      options.find((option) => option.id === configId)!.currentValue = value;
    }
    return { configOptions: options };
  }, id);
  return {
    model,
    values: Object.fromEntries(
      options.map((option) => [option.id, String(option.currentValue)]),
    ),
    calls,
  };
}

const ISSUE_57_IDS: Array<[id: string, model: string, values: Record<string, string>]> = [
  ["claude-4.6-sonnet-medium", "claude-sonnet-4-6", { thinking: "false", effort: "medium" }],
  ["claude-4.6-sonnet-medium-thinking", "claude-sonnet-4-6", { thinking: "true", effort: "medium" }],
  ["claude-4.6-opus-high", "claude-opus-4-6", { thinking: "false", effort: "high" }],
  ["claude-4.6-opus-max", "claude-opus-4-6", { thinking: "false", effort: "max" }],
  ["claude-4.6-opus-high-thinking", "claude-opus-4-6", { thinking: "true", effort: "high" }],
  ["claude-4.6-opus-max-thinking", "claude-opus-4-6", { thinking: "true", effort: "max" }],
  ["claude-4.5-opus-high", "claude-opus-4-5", { thinking: "false" }],
  ["claude-4.5-opus-high-thinking", "claude-opus-4-5", { thinking: "true" }],
  ["claude-4.5-sonnet-thinking", "claude-sonnet-4-5", { thinking: "true" }],
  ["claude-4-sonnet-thinking", "claude-sonnet-4", { thinking: "true" }],
];

describe("decideAcpModel with the real ACP catalog", () => {
  it.each(ISSUE_57_IDS)(
    "keeps the CLI's row for %s (issue #57)",
    async (id, model, values) => {
      const plan = decideAcpModel(id, realSession(id), aliases(id));
      expect(plan).toMatchObject({ action: "keep", modelId: model });
      const final = await simulate(id, plan);
      expect(final.calls).toEqual([]);
      expect(final.model).toBe(model);
      expect(final.values).toMatchObject(values);
    },
  );

  it("resolves every listed public id to the model the CLI selected", async () => {
    const failures: string[] = [];
    for (const id of publicIds) {
      const session = realSession(id);
      const plan = decideAcpModel(id, session, aliases(id));
      if (id === "auto") {
        expect(plan).toEqual({ action: "set", modelId: "default" });
        continue;
      }
      if (plan.action !== "set" && plan.action !== "keep") {
        failures.push(`${id}: ${plan.action}`);
        continue;
      }
      try {
        const final = await simulate(id, plan);
        const cliModel = session.models!.currentModelId;
        if (final.model !== cliModel) {
          failures.push(`${id}: ${final.model} != ${cliModel}`);
        }
        for (const configId of final.calls.map((call) => call.split("=")[0]!)) {
          if (configId === "model") continue;
          const cli = catalog.sessions[id]!.values[configId];
          if (final.values[configId] !== cli) {
            failures.push(`${id}: ${configId}=${final.values[configId]} != ${cli}`);
          }
        }
      } catch (error) {
        failures.push(`${id}: ${(error as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("applies a requested option the CLI left on another value", async () => {
    const id = "claude-4.6-sonnet-medium";
    const session = realSession(id);
    session.configOptions!.find((option) => option.id === "effort")!.currentValue = "high";
    const calls: string[] = [];
    await configureAcpSessionModel(
      { model: id, modelAliases: aliases(id), strictModel: true },
      session,
      async (configId, value) => {
        calls.push(`${configId}=${value}`);
        return {};
      },
    );
    expect(calls).toEqual(["effort=medium"]);
  });

  it("skips an option the CLI-selected row does not offer", async () => {
    const id = "claude-4.5-opus-high";
    const calls: string[] = [];
    const plan = await configureAcpSessionModel(
      { model: id, modelAliases: aliases(id), strictModel: true },
      realSession(id),
      async (configId, value) => {
        calls.push(`${configId}=${value}`);
        return {};
      },
    );
    expect(plan).toEqual({
      action: "keep",
      modelId: "claude-opus-4-5",
      parameters: { effort: "high", thinking: false, fast: false },
    });
    expect(calls).toEqual([]);
  });

  it("errors with the requested id when neither the catalog nor the CLI has a model", async () => {
    const id = "claude-4.6-sonnet-medium";
    await expect(
      configureAcpSessionModel(
        { model: id, modelAliases: aliases(id), strictModel: true },
        realSession(id, "default"),
        async () => ({}),
      ),
    ).rejects.toThrow(
      'ACP model catalog has no match for "claude-4.6-sonnet-medium" (also tried: claude sonnet 4.6 1m, claude-4.6-sonnet); the Cursor CLI did not select a model for it either (session model: default)',
    );
  });

  it("leaves the session alone on a miss when the model is not strict", async () => {
    const id = "claude-4.6-sonnet-medium";
    const calls: string[] = [];
    const plan = await configureAcpSessionModel(
      { model: id, modelAliases: aliases(id), strictModel: false },
      realSession(id, "default"),
      async (configId, value) => {
        calls.push(`${configId}=${value}`);
        return {};
      },
    );
    expect(plan.action).toBe("missing");
    expect(calls).toEqual([]);
  });
});

/** What the fake CLI ran the prompt with ({ model, values, calls }). */
type TurnSelection =
  | {
      ok: true;
      model: string;
      values: Record<string, string>;
      calls: string[];
    }
  | { ok: false; error: string };

const toolSessions: AcpToolSession[] = [];

afterEach(async () => {
  await Promise.all(toolSessions.splice(0).map((session) => session.close()));
});

async function clientPath(
  id: string,
  env: Record<string, string> = {},
): Promise<TurnSelection> {
  const result = await runAcpSync(
    process.execPath,
    [fakeServerPath, "--model", id],
    "hi",
    {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      skipAuthenticate: true,
      model: id,
      modelAliases: aliases(id),
      strictModel: true,
      env: { FAKE_ACP_SCENARIO: "real_catalog", ...env },
    },
  );
  return result.code === 0
    ? { ok: true, ...JSON.parse(result.stdout) }
    : { ok: false, error: result.stderr };
}

async function toolPath(
  id: string,
  env: Record<string, string> = {},
): Promise<TurnSelection> {
  const session = new AcpToolSession({
    command: process.execPath,
    args: [fakeServerPath, "--model", id],
    cwd: process.cwd(),
    env: { FAKE_ACP_SCENARIO: "real_catalog", ...env },
    timeoutMs: 5_000,
    skipAuthenticate: true,
    model: id,
    modelAliases: aliases(id),
    strictModel: true,
    tools: [{ name: "noop", inputSchema: { type: "object", properties: {} } }],
  });
  toolSessions.push(session);
  try {
    await session.start("hi");
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
  const result = await session.collect();
  return { ok: true, ...JSON.parse(result.text) };
}

describe("ACP client and tool paths", () => {
  it.each([
    ...ISSUE_57_IDS.map(([id]) => id),
    "cursor-grok-4.6-medium",
    "cursor-grok-4.5-high-fast",
    "composer-2.5-fast",
    "claude-opus-5-thinking-high-fast",
    "gpt-5.5-extra-high",
    "auto",
  ])("run %s with the same model and options", async (id) => {
    const client = await clientPath(id);
    expect(client.ok).toBe(true);
    expect(await toolPath(id)).toEqual(client);
  });

  it("keep the CLI's selection for claude-4.6-sonnet-medium", async () => {
    expect(await clientPath("claude-4.6-sonnet-medium")).toEqual({
      ok: true,
      model: "claude-sonnet-4-6",
      values: { thinking: "false", context: "200k", effort: "medium" },
      calls: [],
    });
  });

  it("re-select the Grok base row and options for cursor-grok-4.6-medium", async () => {
    expect(await clientPath("cursor-grok-4.6-medium")).toMatchObject({
      ok: true,
      model: "grok-4.6",
      values: { effort: "medium", fast: "false" },
      calls: ["model=grok-4.6", "effort=medium", "fast=false"],
    });
  });

  it("both fail naming the requested id when the CLI did not resolve it", async () => {
    const env = { FAKE_ACP_CURRENT_MODEL: "default" };
    const client = await clientPath("claude-4.6-sonnet-medium", env);
    const tool = await toolPath("claude-4.6-sonnet-medium", env);
    const message =
      'ACP model catalog has no match for "claude-4.6-sonnet-medium"';
    expect(client.ok ? "" : client.error).toContain(message);
    expect(tool.ok ? "" : tool.error).toContain(message);
    expect(tool.ok ? "" : tool.error).toContain("session model: default");
  });
});
