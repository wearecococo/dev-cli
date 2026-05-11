import { describe, expect, test } from "bun:test";
import { computePlan, deepEqual } from "../src/state/plan.ts";
import type { LoadedOps } from "../src/ops.ts";
import type { LiveSnapshot } from "../src/state/live-fetch.ts";
import type { StateFile } from "../src/state/types.ts";

const emptyOps: LoadedOps = {
  files: {},
  users: [],
  policies: [],
  policyBindings: [],
  networks: [],
  devices: [],
  teams: [],
  customAppUserBindings: [],
  customAppTeamBindings: [],
  controllers: [],
  controllerTokens: [],
  edgeAppInstallations: [],
  integrationInstallations: [],
};

function withUsers(...users: LoadedOps["users"]): LoadedOps {
  return { ...emptyOps, users };
}

const ALICE = { email: "alice@acme.com", name: "Alice", kind: "HUMAN" } as const;
const ALICE_RENAMED = { ...ALICE, name: "Alice Operator" };
const BOB = { email: "bob@acme.com", name: "Bob", kind: "HUMAN" } as const;

const aliceState: StateFile = {
  schemaVersion: 1,
  lastAppliedAt: "2026-05-10T00:00:00Z",
  resources: [
    {
      identity: { kind: "user", email: "alice@acme.com" },
      lastAppliedSpec: { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
      lastAppliedAt: "2026-05-10T00:00:00Z",
    },
  ],
};

describe("computePlan — base operations", () => {
  test("empty ops + null state + empty live → empty plan", () => {
    const plan = computePlan(emptyOps, null, new Map() as LiveSnapshot);
    expect(plan.actions).toEqual([]);
  });

  test("declared user, no state, not on server → create", () => {
    const plan = computePlan(withUsers(ALICE), null, new Map() as LiveSnapshot);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]!.op).toBe("create");
  });

  test("declared user, no state, exists on server → create (adoption path)", () => {
    const live: LiveSnapshot = new Map([
      ["user:alice@acme.com", { email: "alice@acme.com", name: "Alice", kind: "HUMAN" }],
    ]);
    const plan = computePlan(withUsers(ALICE), null, live);
    // Even though the server has it, no state entry means we record this
    // resource as "to be tracked" — a create that the underlying upsert
    // makes idempotent at execute time.
    expect(plan.actions[0]!.op).toBe("create");
  });

  test("declared user, in state, declared matches lastApplied, server matches → noop", () => {
    const live: LiveSnapshot = new Map([
      ["user:alice@acme.com", { email: "alice@acme.com", name: "Alice", kind: "HUMAN" }],
    ]);
    const plan = computePlan(withUsers(ALICE), aliceState, live);
    expect(plan.actions[0]!.op).toBe("noop");
  });

  test("declared user, in state, declared changed since last apply → update (not server-modified)", () => {
    const live: LiveSnapshot = new Map([
      ["user:alice@acme.com", { email: "alice@acme.com", name: "Alice", kind: "HUMAN" }],
    ]);
    const plan = computePlan(withUsers(ALICE_RENAMED), aliceState, live);
    expect(plan.actions[0]!.op).toBe("update");
    if (plan.actions[0]!.op === "update") {
      expect(plan.actions[0]!.serverModified).toBe(false);
      expect(plan.actions[0]!.diff).toEqual([
        {
          path: "name",
          lastApplied: "Alice",
          declared: "Alice Operator",
          live: "Alice",
        },
      ]);
    }
  });

  test("declared matches lastApplied, server drifted → update (server-modified)", () => {
    const live: LiveSnapshot = new Map([
      [
        "user:alice@acme.com",
        { email: "alice@acme.com", name: "Some other name", kind: "HUMAN" },
      ],
    ]);
    const plan = computePlan(withUsers(ALICE), aliceState, live);
    expect(plan.actions[0]!.op).toBe("update");
    if (plan.actions[0]!.op === "update") {
      expect(plan.actions[0]!.serverModified).toBe(true);
    }
  });

  test("in state, declared but server deleted → create (re-create)", () => {
    const plan = computePlan(withUsers(ALICE), aliceState, new Map() as LiveSnapshot);
    expect(plan.actions[0]!.op).toBe("create");
  });

  test("in state, no longer declared → delete", () => {
    const plan = computePlan(emptyOps, aliceState, new Map() as LiveSnapshot);
    expect(plan.actions[0]!.op).toBe("delete");
    expect(plan.actions[0]!.identity).toEqual({
      kind: "user",
      email: "alice@acme.com",
    });
  });
});

describe("computePlan — ordering", () => {
  test("creates sort by kind forward order, then by identity", () => {
    const ops: LoadedOps = {
      ...emptyOps,
      users: [BOB, ALICE],
      policies: [
        { handle: "press-op", name: "Press Op", statements: [] },
      ],
    };
    const plan = computePlan(ops, null, new Map() as LiveSnapshot);
    const kinds = plan.actions.map((a) => a.identity.kind);
    // iam_policy comes before user in KIND_FORWARD_ORDER.
    expect(kinds).toEqual(["iam_policy", "user", "user"]);
    // Within users, alphabetical.
    const emails = plan.actions
      .filter((a) => a.identity.kind === "user")
      .map((a) => (a.identity as { email: string }).email);
    expect(emails).toEqual(["alice@acme.com", "bob@acme.com"]);
  });

  test("plan output is deterministic across runs with the same input", () => {
    const ops = withUsers(BOB, ALICE);
    const a = computePlan(ops, null, new Map() as LiveSnapshot);
    const b = computePlan(ops, null, new Map() as LiveSnapshot);
    expect(a).toEqual(b);
  });
});

describe("computePlan — write-only fields are stripped", () => {
  test("device password isn't part of the diff", () => {
    const declared: LoadedOps = {
      ...emptyOps,
      devices: [
        {
          identifier: "press-01",
          outboundProtocols: [
            {
              kind: "HTTP",
              label: "main",
              url: "https://example.com",
              authMode: "BASIC",
              username: "user",
              password: "secret-1",
            },
          ],
        },
      ],
    };
    const stateWithMatchingDevice: StateFile = {
      schemaVersion: 1,
      lastAppliedAt: "2026-05-10T00:00:00Z",
      resources: [
        {
          identity: { kind: "device", identifier: "press-01" },
          lastAppliedSpec: {
            identifier: "press-01",
            // stored without password — write-only fields are stripped.
            outboundProtocols: [
              {
                kind: "HTTP",
                label: "main",
                url: "https://example.com",
                authMode: "BASIC",
                username: "user",
              },
            ],
          },
          lastAppliedAt: "2026-05-10T00:00:00Z",
        },
      ],
    };
    const live: LiveSnapshot = new Map([
      [
        "device:press-01",
        {
          identifier: "press-01",
          outboundProtocols: [
            {
              kind: "HTTP",
              label: "main",
              url: "https://example.com",
              authMode: "BASIC",
              username: "user",
            },
          ],
        },
      ],
    ]);
    const plan = computePlan(declared, stateWithMatchingDevice, live);
    // Password change shouldn't trigger drift detection — it's intentionally
    // ignored at the diff layer (managed by future variable-config system).
    expect(plan.actions[0]!.op).toBe("noop");
  });
});

describe("deepEqual", () => {
  test("undefined vs missing key compare equal", () => {
    expect(deepEqual({ a: 1 }, { a: 1, b: undefined })).toBe(true);
  });

  test("nested arrays are order-sensitive", () => {
    expect(deepEqual({ x: [1, 2] }, { x: [2, 1] })).toBe(false);
  });

  test("nested objects compare by structural equality", () => {
    expect(deepEqual({ x: { a: 1 } }, { x: { a: 1 } })).toBe(true);
    expect(deepEqual({ x: { a: 1 } }, { x: { a: 2 } })).toBe(false);
  });
});
