import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOps } from "../src/ops.ts";

let root: string;
const DEFINE_PATH = new URL("../src/define.ts", import.meta.url).pathname;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-ops-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadOps", () => {
  test("loads users / policies / bindings when all three files exist", async () => {
    writeFileSync(
      join(root, "users.ts"),
      `import { defineUsers } from "${DEFINE_PATH}";
export default defineUsers([
  { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
  { email: "bot@acme.com", name: "Webhook Bot", kind: "BOT", externalId: "svc_001" },
]);
`,
    );
    writeFileSync(
      join(root, "iam_policies.ts"),
      `import { defineIAMPolicies } from "${DEFINE_PATH}";
export default defineIAMPolicies([
  {
    handle: "press-operator",
    name: "Press Operator",
    description: "Run jobs on the press floor",
    statements: [
      { effect: "ALLOW", actions: ["job:read", "job:transition"], resources: ["*"] },
    ],
  },
]);
`,
    );
    writeFileSync(
      join(root, "iam_policy_bindings.ts"),
      `import { defineIAMPolicyBindings } from "${DEFINE_PATH}";
export default defineIAMPolicyBindings([
  { user: "alice@acme.com", policy: "press-operator" },
]);
`,
    );

    const ops = await loadOps(root);
    expect(ops.users).toHaveLength(2);
    expect(ops.users[0]?.email).toBe("alice@acme.com");
    expect(ops.users[1]?.kind).toBe("BOT");
    expect(ops.policies).toHaveLength(1);
    expect(ops.policies[0]?.handle).toBe("press-operator");
    expect(ops.policies[0]?.statements[0]?.actions).toEqual(["job:read", "job:transition"]);
    expect(ops.policyBindings).toHaveLength(1);
    expect(ops.policyBindings[0]?.user).toBe("alice@acme.com");
    // All three file paths recorded.
    expect(ops.files.users).toBeDefined();
    expect(ops.files.policies).toBeDefined();
    expect(ops.files.policyBindings).toBeDefined();
  });

  test("skips files that don't exist", async () => {
    writeFileSync(
      join(root, "users.ts"),
      `import { defineUsers } from "${DEFINE_PATH}";
export default defineUsers([{ email: "solo@acme.com" }]);
`,
    );
    const ops = await loadOps(root);
    expect(ops.users).toHaveLength(1);
    expect(ops.policies).toHaveLength(0);
    expect(ops.policyBindings).toHaveLength(0);
    expect(ops.files.users).toBeDefined();
    expect(ops.files.policies).toBeUndefined();
    expect(ops.files.policyBindings).toBeUndefined();
  });

  test("rejects a duplicate user email", async () => {
    writeFileSync(
      join(root, "users.ts"),
      `import { defineUsers } from "${DEFINE_PATH}";
export default defineUsers([
  { email: "alice@acme.com" },
  { email: "alice@acme.com", name: "different alice" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate user 'alice@acme.com'/);
  });

  test("rejects case-mismatched user emails (Alice vs alice)", async () => {
    writeFileSync(
      join(root, "users.ts"),
      `import { defineUsers } from "${DEFINE_PATH}";
export default defineUsers([
  { email: "Alice@Acme.com" },
  { email: "alice@acme.com" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(
      /Duplicate user 'alice@acme.com'.*already declared as 'Alice@Acme.com'/,
    );
  });

  test("rejects a duplicate policy handle", async () => {
    writeFileSync(
      join(root, "iam_policies.ts"),
      `import { defineIAMPolicies } from "${DEFINE_PATH}";
export default defineIAMPolicies([
  { handle: "p", name: "P1", statements: [] },
  { handle: "p", name: "P2", statements: [] },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate policy handle 'p'/);
  });

  test("rejects a duplicate binding row", async () => {
    writeFileSync(
      join(root, "iam_policy_bindings.ts"),
      `import { defineIAMPolicyBindings } from "${DEFINE_PATH}";
export default defineIAMPolicyBindings([
  { user: "alice@acme.com", policy: "p" },
  { user: "alice@acme.com", policy: "p" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate IAM policy binding alice@acme.com → p/);
  });

  test("rejects when the file's default export isn't a defineX(...) result", async () => {
    writeFileSync(
      join(root, "users.ts"),
      `export default [{ email: "raw@acme.com" }];\n`,
    );
    await expect(loadOps(root)).rejects.toThrow(/defineUsers/);
  });

  test("rejects when the wrong defineX is used in a file", async () => {
    writeFileSync(
      join(root, "users.ts"),
      `import { defineIAMPolicies } from "${DEFINE_PATH}";
export default defineIAMPolicies([{ handle: "p", name: "P", statements: [] }]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/expected.*defineUsers/);
  });

  test("loads networks + devices with discriminated protocol configs", async () => {
    writeFileSync(
      join(root, "networks.ts"),
      `import { defineNetworks } from "${DEFINE_PATH}";
export default defineNetworks([
  { name: "press-floor", description: "Production floor" },
  { name: "office" },
]);
`,
    );
    writeFileSync(
      join(root, "devices.ts"),
      `import { defineDevices } from "${DEFINE_PATH}";
export default defineDevices([
  {
    identifier: "press-01",
    network: "press-floor",
    name: "Heidelberg Press",
    manufacturer: "Heidelberg",
    outboundProtocols: [
      {
        kind: "HTTP",
        url: "https://press-01.local/api",
        authMode: "BASIC",
        username: "ops",
        password: "\${config:PRESS_01_HTTP_PASSWORD}",
      },
      {
        kind: "SQL",
        adapter: "POSTGRESQL",
        host: "press-01.local",
        port: 5432,
        databaseName: "metrics",
        username: "reader",
      },
    ],
    inboundProtocols: [
      { kind: "MQTT", topic: "press/01/telemetry" },
      { kind: "HTTP", webhookPath: "/hooks/press-01" },
    ],
  },
]);
`,
    );

    const ops = await loadOps(root);
    expect(ops.networks).toHaveLength(2);
    expect(ops.networks[0]?.name).toBe("press-floor");
    expect(ops.devices).toHaveLength(1);
    const dev = ops.devices[0]!;
    expect(dev.identifier).toBe("press-01");
    expect(dev.network).toBe("press-floor");
    expect(dev.outboundProtocols).toHaveLength(2);
    const http = dev.outboundProtocols![0]!;
    if (http.kind !== "HTTP") throw new Error("expected HTTP");
    expect(http.url).toBe("https://press-01.local/api");
    expect(http.password).toContain("config:");
    const sql = dev.outboundProtocols![1]!;
    if (sql.kind !== "SQL") throw new Error("expected SQL");
    expect(sql.adapter).toBe("POSTGRESQL");
    expect(sql.host).toBe("press-01.local");
    expect(dev.inboundProtocols).toHaveLength(2);
    expect(dev.inboundProtocols![0]?.kind).toBe("MQTT");
    expect(dev.inboundProtocols![1]?.kind).toBe("HTTP");
  });

  test("rejects duplicate network names", async () => {
    writeFileSync(
      join(root, "networks.ts"),
      `import { defineNetworks } from "${DEFINE_PATH}";
export default defineNetworks([
  { name: "n" },
  { name: "n" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate network name 'n'/);
  });

  test("rejects duplicate device identifiers", async () => {
    writeFileSync(
      join(root, "devices.ts"),
      `import { defineDevices } from "${DEFINE_PATH}";
export default defineDevices([
  { identifier: "d" },
  { identifier: "d" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate device identifier 'd'/);
  });

  test("loads teams + custom-app bindings", async () => {
    writeFileSync(
      join(root, "teams.ts"),
      `import { defineTeams } from "${DEFINE_PATH}";
export default defineTeams([
  {
    name: "press-operators",
    description: "Press floor crew",
    members: ["alice@acme.com", "bob@acme.com"],
  },
  { name: "shipping" },
]);
`,
    );
    writeFileSync(
      join(root, "custom_app_user_bindings.ts"),
      `import { defineCustomAppUserBindings } from "${DEFINE_PATH}";
export default defineCustomAppUserBindings([
  { user: "alice@acme.com", app: "job-board" },
]);
`,
    );
    writeFileSync(
      join(root, "custom_app_team_bindings.ts"),
      `import { defineCustomAppTeamBindings } from "${DEFINE_PATH}";
export default defineCustomAppTeamBindings([
  { team: "press-operators", app: "press-dashboard" },
]);
`,
    );

    const ops = await loadOps(root);
    expect(ops.teams).toHaveLength(2);
    expect(ops.teams[0]?.name).toBe("press-operators");
    expect(ops.teams[0]?.members).toEqual(["alice@acme.com", "bob@acme.com"]);
    expect(ops.teams[1]?.members).toBeUndefined();
    expect(ops.customAppUserBindings).toHaveLength(1);
    expect(ops.customAppUserBindings[0]).toEqual({ user: "alice@acme.com", app: "job-board" });
    expect(ops.customAppTeamBindings).toHaveLength(1);
    expect(ops.customAppTeamBindings[0]).toEqual({ team: "press-operators", app: "press-dashboard" });
    expect(ops.files.teams).toBeDefined();
    expect(ops.files.customAppUserBindings).toBeDefined();
    expect(ops.files.customAppTeamBindings).toBeDefined();
  });

  test("rejects duplicate team names", async () => {
    writeFileSync(
      join(root, "teams.ts"),
      `import { defineTeams } from "${DEFINE_PATH}";
export default defineTeams([
  { name: "t" },
  { name: "t" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate team name 't'/);
  });

  test("rejects duplicate members within a single team", async () => {
    writeFileSync(
      join(root, "teams.ts"),
      `import { defineTeams } from "${DEFINE_PATH}";
export default defineTeams([
  { name: "t", members: ["alice@acme.com", "alice@acme.com"] },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(
      /Duplicate member 'alice@acme.com' in team 't'/,
    );
  });

  test("rejects duplicate custom-app-user bindings", async () => {
    writeFileSync(
      join(root, "custom_app_user_bindings.ts"),
      `import { defineCustomAppUserBindings } from "${DEFINE_PATH}";
export default defineCustomAppUserBindings([
  { user: "u@x", app: "a" },
  { user: "u@x", app: "a" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate custom-app user binding u@x → a/);
  });

  test("rejects duplicate custom-app-team bindings", async () => {
    writeFileSync(
      join(root, "custom_app_team_bindings.ts"),
      `import { defineCustomAppTeamBindings } from "${DEFINE_PATH}";
export default defineCustomAppTeamBindings([
  { team: "t", app: "a" },
  { team: "t", app: "a" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate custom-app team binding t → a/);
  });

  test("loads controllers, tokens, and installations", async () => {
    writeFileSync(
      join(root, "controllers.ts"),
      `import { defineControllers } from "${DEFINE_PATH}";
export default defineControllers([
  {
    handle: "press-01",
    network: "press-floor",
    name: "Press Floor Controller",
    host: "192.168.1.10",
    port: 8443,
    policy: {
      allowedIoPaths: ["/var/log/door"],
      allowedExecBinaries: ["/usr/bin/ping"],
    },
  },
  { handle: "shipping-01", name: "Shipping Bay Controller" },
]);
`,
    );
    writeFileSync(
      join(root, "controller_tokens.ts"),
      `import { defineControllerTokens } from "${DEFINE_PATH}";
export default defineControllerTokens([
  { controller: "press-01", name: "primary" },
  { controller: "press-01", name: "backup", description: "Standby token" },
]);
`,
    );
    writeFileSync(
      join(root, "edge_app_installations.ts"),
      `import { defineEdgeAppInstallations } from "${DEFINE_PATH}";
export default defineEdgeAppInstallations([
  {
    controller: "press-01",
    app: "door-monitor",
    version: 3,
    variables: { LOG_PATH: "/var/log/door" },
    botUser: "bot@acme.com",
  },
]);
`,
    );

    const ops = await loadOps(root);
    expect(ops.controllers).toHaveLength(2);
    expect(ops.controllers[0]?.handle).toBe("press-01");
    expect(ops.controllers[0]?.policy?.allowedIoPaths).toEqual(["/var/log/door"]);
    expect(ops.controllers[1]?.policy).toBeUndefined();
    expect(ops.controllerTokens).toHaveLength(2);
    expect(ops.controllerTokens[0]).toMatchObject({ controller: "press-01", name: "primary" });
    expect(ops.edgeAppInstallations).toHaveLength(1);
    const inst = ops.edgeAppInstallations[0]!;
    expect(inst.controller).toBe("press-01");
    expect(inst.app).toBe("door-monitor");
    expect(inst.version).toBe(3);
    expect(inst.variables).toEqual({ LOG_PATH: "/var/log/door" });
    expect(inst.botUser).toBe("bot@acme.com");
    expect(ops.files.controllers).toBeDefined();
    expect(ops.files.controllerTokens).toBeDefined();
    expect(ops.files.edgeAppInstallations).toBeDefined();
  });

  test("rejects duplicate controller handles", async () => {
    writeFileSync(
      join(root, "controllers.ts"),
      `import { defineControllers } from "${DEFINE_PATH}";
export default defineControllers([
  { handle: "c" },
  { handle: "c" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate controller handle 'c'/);
  });

  test("rejects duplicate (controller, name) token entries", async () => {
    writeFileSync(
      join(root, "controller_tokens.ts"),
      `import { defineControllerTokens } from "${DEFINE_PATH}";
export default defineControllerTokens([
  { controller: "c1", name: "t" },
  { controller: "c1", name: "t" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate controller token c1\/t/);
  });

  test("accepts typed object refs for cross-resource references", async () => {
    // The headline win for typed refs: this file would not compile if
    // someone typo'd a user email — `alice` is the actual TS object,
    // not a free-form string.
    writeFileSync(
      join(root, "users.ts"),
      `import { defineUsers } from "${DEFINE_PATH}";
export const alice = { email: "alice@acme.com", name: "Alice", kind: "HUMAN" } as const;
export const bob = { email: "bob@acme.com", name: "Bob", kind: "HUMAN" } as const;
export default defineUsers([alice, bob]);
`,
    );
    writeFileSync(
      join(root, "iam_policies.ts"),
      `import { defineIAMPolicies } from "${DEFINE_PATH}";
export const pressOperator = {
  handle: "press-operator",
  name: "Press Operator",
  statements: [{ effect: "ALLOW" as const, actions: ["job:read"], resources: ["*"] }],
};
export default defineIAMPolicies([pressOperator]);
`,
    );
    writeFileSync(
      join(root, "iam_policy_bindings.ts"),
      `import { defineIAMPolicyBindings } from "${DEFINE_PATH}";
import { alice, bob } from "./users.ts";
import { pressOperator } from "./iam_policies.ts";
export default defineIAMPolicyBindings([
  { user: alice, policy: pressOperator },
  // Mixed: typed object on one side, string on the other.
  { user: bob, policy: "press-operator" },
]);
`,
    );

    const ops = await loadOps(root);
    expect(ops.policyBindings).toHaveLength(2);
    // The user side is the typed object (round-tripped through dynamic import).
    const first = ops.policyBindings[0]!;
    expect(typeof first.user).toBe("object");
    expect(typeof first.user === "object" && first.user.email).toBe("alice@acme.com");
    expect(typeof first.policy === "object" && first.policy.handle).toBe("press-operator");
    // The mixed-form binding has a string user/policy.
    const second = ops.policyBindings[1]!;
    expect(typeof second.user === "object" && second.user.email).toBe("bob@acme.com");
    expect(second.policy).toBe("press-operator");
  });

  test("typed object refs work for team members (mixed string + object)", async () => {
    writeFileSync(
      join(root, "users.ts"),
      `import { defineUsers } from "${DEFINE_PATH}";
export const alice = { email: "alice@acme.com", kind: "HUMAN" } as const;
export default defineUsers([alice, { email: "bob@acme.com", kind: "HUMAN" }]);
`,
    );
    writeFileSync(
      join(root, "teams.ts"),
      `import { defineTeams } from "${DEFINE_PATH}";
import { alice } from "./users.ts";
export default defineTeams([
  { name: "press-operators", members: [alice, "bob@acme.com"] },
]);
`,
    );
    const ops = await loadOps(root);
    const team = ops.teams[0]!;
    expect(team.members).toHaveLength(2);
    expect(typeof team.members![0] === "object" && (team.members![0] as { email: string }).email).toBe("alice@acme.com");
    expect(team.members![1]).toBe("bob@acme.com");
  });

  test("rejects two installs of the same edge-app handle on the same controller", async () => {
    writeFileSync(
      join(root, "edge_app_installations.ts"),
      `import { defineEdgeAppInstallations } from "${DEFINE_PATH}";
export default defineEdgeAppInstallations([
  { controller: "c", app: "a", version: 1 },
  { controller: "c", app: "a", version: 2 },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(
      /Duplicate edge-app installation a on c.*Only one version/,
    );
  });
});
