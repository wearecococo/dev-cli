import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectWorkflow, loadManifest } from "../src/loader.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-workflow-load-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const DEFINE_PATH = new URL("../src/define.ts", import.meta.url).pathname;

describe("loadManifest — workflow", () => {
  test("emits the wire shape with JSON-stringified node configs and renamed edge fields", async () => {
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineWorkflow } from "${DEFINE_PATH}";

export default defineWorkflow({
  handle: "nightly-rollup",
  displayName: "Nightly Rollup",
  description: "Aggregates daily metrics overnight.",
  isActive: true,
  defaultNodeTimeoutSeconds: 60,
  variables: [
    { name: "lookbackDays", type: "number", defaultValue: 7 },
  ],
  nodes: [
    { id: "start", name: "Start", type: "trigger", config: {} },
    {
      id: "transform",
      name: "Transform",
      type: "lua_script",
      config: { language: "lua", maxRows: 1000 },
    },
  ],
  edges: [
    { id: "e1", from: "start", to: "transform" },
  ],
  triggers: [
    {
      name: "nightly",
      config: {
        kind: "scheduled",
        cronExpression: "0 2 * * *",
        overlapPolicy: "SKIP",
        timezone: "UTC",
      },
    },
  ],
});
`,
    );

    const loaded = await loadManifest(root);
    const wf = expectWorkflow(loaded);

    expect(wf.workflow.handle).toBe("nightly-rollup");
    expect(wf.workflow.name).toBe("Nightly Rollup");
    expect(wf.workflow.is_active).toBe(true);
    expect(wf.workflow.default_node_timeout_seconds).toBe(60);

    expect(wf.workflow.definition.nodes).toHaveLength(2);
    const transform = wf.workflow.definition.nodes.find((n) => n.id === "transform");
    expect(transform?.type).toBe("lua_script");
    // Configs land on the wire as JSON strings.
    expect(typeof transform?.config).toBe("string");
    expect(JSON.parse(transform!.config!)).toEqual({ language: "lua", maxRows: 1000 });

    // Edges rename `from` / `to` → `fromNodeId` / `toNodeId`.
    expect(wf.workflow.definition.edges[0]).toMatchObject({
      id: "e1",
      fromNodeId: "start",
      toNodeId: "transform",
    });

    // Variable defaultValue is JSON-stringified.
    const variable = wf.workflow.definition.variables[0]!;
    expect(variable.name).toBe("lookbackDays");
    expect(JSON.parse(variable.defaultValue!)).toBe(7);

    expect(wf.workflow.triggers).toHaveLength(1);
    expect(wf.workflow.triggers[0]!.config.kind).toBe("scheduled");
  });

  test("inlines luaFile() refs found inside node config trees", async () => {
    mkdirSync(join(root, "scripts"));
    writeFileSync(
      join(root, "scripts/transform.lua"),
      "return { ok = true }\n",
    );

    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineWorkflow, luaFile } from "${DEFINE_PATH}";

export default defineWorkflow({
  handle: "with-script",
  nodes: [
    {
      id: "n1",
      name: "Run script",
      type: "lua_script",
      config: { source: luaFile("./scripts/transform.lua") },
    },
  ],
  edges: [],
});
`,
    );

    const loaded = await loadManifest(root);
    const wf = expectWorkflow(loaded);

    const node = wf.workflow.definition.nodes[0]!;
    const config = JSON.parse(node.config!) as { source: string };
    expect(config.source).toContain("ok = true");

    // The provenance map records the file origin under the JSON-pointer-ish key.
    const origin = wf.manifestSourceOrigins.get("nodes.n1.config.source");
    expect(origin?.kind).toBe("file");
  });
});
