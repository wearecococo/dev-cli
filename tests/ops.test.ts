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
      join(root, "bindings.ts"),
      `import { defineBindings } from "${DEFINE_PATH}";
export default defineBindings([
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
    expect(ops.bindings).toHaveLength(1);
    expect(ops.bindings[0]?.user).toBe("alice@acme.com");
    // All three file paths recorded.
    expect(ops.files.users).toBeDefined();
    expect(ops.files.policies).toBeDefined();
    expect(ops.files.bindings).toBeDefined();
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
    expect(ops.bindings).toHaveLength(0);
    expect(ops.files.users).toBeDefined();
    expect(ops.files.policies).toBeUndefined();
    expect(ops.files.bindings).toBeUndefined();
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
    await expect(loadOps(root)).rejects.toThrow(/Duplicate user email 'alice@acme.com'/);
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
      join(root, "bindings.ts"),
      `import { defineBindings } from "${DEFINE_PATH}";
export default defineBindings([
  { user: "alice@acme.com", policy: "p" },
  { user: "alice@acme.com", policy: "p" },
]);
`,
    );
    await expect(loadOps(root)).rejects.toThrow(/Duplicate binding alice@acme.com → p/);
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
});
