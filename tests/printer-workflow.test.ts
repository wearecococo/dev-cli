import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { printWorkflowManifestTs } from "../src/printer.ts";
import { expectWorkflow, loadManifest } from "../src/loader.ts";
import type {
  WorkflowTriggerState,
  WorkflowVersionState,
} from "../src/graphql/operations.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-printer-wf-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const version: WorkflowVersionState = {
  id: "wfv_1",
  workflowId: "wf_1",
  tenantId: "t_1",
  version: 3,
  isValid: true,
  validationErrors: [],
  createdAt: "2026-05-10T00:00:00Z",
  definition: {
    nodes: [
      { id: "start", name: "Start", type: "trigger", config: JSON.stringify({}) },
      {
        id: "transform",
        name: "Transform",
        type: "lua_script",
        config: JSON.stringify({ language: "lua", maxRows: 1000 }),
      },
    ],
    edges: [
      { id: "e1", fromNodeId: "start", toNodeId: "transform" },
    ],
    variables: [
      { name: "lookbackDays", type: "number", defaultValue: JSON.stringify(7) },
    ],
  },
};

const triggers: WorkflowTriggerState[] = [
  {
    id: "trg_1",
    tenantId: "t_1",
    workflowId: "wf_1",
    name: "nightly",
    configJSON: JSON.stringify({
      type: "scheduled",
      scheduled: {
        cronExpression: "0 2 * * *",
        overlapPolicy: "SKIP",
        timezone: "UTC",
      },
    }),
    isEnabled: true,
    concurrencyPolicy: "ALLOW",
    maxConcurrentExecutions: null,
    createdAt: "2026-05-10T00:00:00Z",
    updatedAt: "2026-05-10T00:00:00Z",
  },
];

describe("printWorkflowManifestTs", () => {
  test("emits a manifest.ts that round-trips through the loader", async () => {
    const ts = printWorkflowManifestTs({
      handle: "nightly-rollup",
      displayName: "Nightly Rollup",
      description: "Aggregates daily metrics overnight.",
      isActive: true,
      defaultNodeTimeoutSeconds: 60,
      version,
      triggers,
    });

    // The printer references the runtime package; tests load through the
    // local source instead. Patch the import path to the in-repo
    // `define.ts` so the loader can resolve it.
    const localDefine = new URL("../src/define.ts", import.meta.url).pathname;
    const patched = ts.replace(
      `from "@wearecococo/dev-cli/define"`,
      `from "${localDefine}"`,
    );
    writeFileSync(join(root, "manifest.ts"), patched);

    const loaded = await loadManifest(root);
    const wf = expectWorkflow(loaded);

    expect(wf.workflow.handle).toBe("nightly-rollup");
    expect(wf.workflow.name).toBe("Nightly Rollup");
    expect(wf.workflow.is_active).toBe(true);
    expect(wf.workflow.default_node_timeout_seconds).toBe(60);

    expect(wf.workflow.definition.nodes).toHaveLength(2);
    const transform = wf.workflow.definition.nodes.find((n) => n.id === "transform");
    expect(JSON.parse(transform!.config!)).toEqual({ language: "lua", maxRows: 1000 });

    expect(wf.workflow.definition.edges[0]).toMatchObject({
      fromNodeId: "start",
      toNodeId: "transform",
    });

    expect(JSON.parse(wf.workflow.definition.variables[0]!.defaultValue!)).toBe(7);

    expect(wf.workflow.triggers).toHaveLength(1);
    const t = wf.workflow.triggers[0]!;
    expect(t.name).toBe("nightly");
    expect(t.config).toMatchObject({
      kind: "scheduled",
      cronExpression: "0 2 * * *",
      overlapPolicy: "SKIP",
      timezone: "UTC",
    });
  });
});
