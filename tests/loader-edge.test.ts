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
import { expectEdge, loadManifest } from "../src/loader.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-edge-load-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const DEFINE_PATH = new URL("../src/define.ts", import.meta.url).pathname;

describe("loadManifest — edge app", () => {
  test("resolves handlers / libraries / onMessage and emits the wire shape", async () => {
    mkdirSync(join(root, "handlers"));
    writeFileSync(join(root, "handlers/onDoor.lua"), 'bridge.log.info("door")\n');
    writeFileSync(join(root, "handlers/heartbeat.lua"), 'bridge.log.info("tick")\n');
    mkdirSync(join(root, "libraries"));
    writeFileSync(join(root, "libraries/format.lua"), "return { id = function() return 1 end }\n");

    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineEdgeApp, lua, luaFile } from "${DEFINE_PATH}";

export default defineEdgeApp({
  handle: "door-monitor",
  name: "Door Monitor",
  description: "Watches a folder",
  logLevel: "INFO",
  handlers: {
    onDoor: luaFile("./handlers/onDoor.lua"),
    heartbeat: luaFile("./handlers/heartbeat.lua"),
  },
  libraries: {
    format: luaFile("./libraries/format.lua"),
  },
  onMessage: lua\`local payload = ...
bridge.log.info("invoked: " .. payload.kind)\`,
  triggers: [
    { kind: "CRON", name: "tick", handler: "heartbeat", schedule: "*/5 * * * *" },
    { kind: "FILE_CREATED", name: "doorEvt", handler: "onDoor", path: "/var/log/door", pattern: "*.evt" },
  ],
});
`,
    );

    const loaded = await loadManifest(root);
    const edge = expectEdge(loaded);
    expect(edge.app.handle).toBe("door-monitor");
    expect(edge.app.name).toBe("Door Monitor");
    expect(edge.app.handlers).toHaveLength(2);
    expect(edge.app.handlers.find((h) => h.name === "onDoor")?.source).toContain(
      "door",
    );
    expect(edge.app.libraries).toHaveLength(1);
    expect(edge.app.on_message).toContain("invoked");
    expect(edge.app.triggers).toHaveLength(2);
    expect(edge.app.log_level).toBe("INFO");

    // Origin tracking — onDoor / heartbeat / format are file-backed,
    // onMessage is tag-backed.
    expect(edge.manifestSourceOrigins.get("handlers.onDoor")?.kind).toBe("file");
    expect(edge.manifestSourceOrigins.get("libraries.format")?.kind).toBe("file");
    expect(edge.manifestSourceOrigins.get("onMessage")?.kind).toBe("tag");

    expect(edge.consumed.size).toBe(3);
  });

  test("passes I/O config through to the wire shape and validates handler refs", async () => {
    mkdirSync(join(root, "handlers"));
    writeFileSync(join(root, "handlers/onMsg.lua"), 'bridge.log.info("msg")\n');
    writeFileSync(join(root, "handlers/onPoll.lua"), 'bridge.log.info("poll")\n');
    writeFileSync(join(root, "handlers/onWebhook.lua"), 'bridge.log.info("hook")\n');

    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineEdgeApp, luaFile } from "${DEFINE_PATH}";

export default defineEdgeApp({
  handle: "io-kitchen-sink",
  name: "IO Kitchen Sink",
  handlers: {
    onMsg: luaFile("./handlers/onMsg.lua"),
    onPoll: luaFile("./handlers/onPoll.lua"),
    onWebhook: luaFile("./handlers/onWebhook.lua"),
  },
  triggers: [],
  mqttBrokers: [
    {
      name: "broker1",
      url: "mqtt://broker:1883",
      subscriptions: [{ topic: "data/#", handler: "onMsg" }],
    },
  ],
  opcuaEndpoints: [
    {
      name: "press",
      endpoint: "opc.tcp://press:4840",
      subscriptions: [{ nodeId: "ns=2;s=Temp", handler: "onMsg" }],
      auth: { mode: "ANONYMOUS" },
    },
  ],
  snmpDevices: [
    {
      version: "V2C",
      name: "sw1",
      host: "10.0.0.10",
      community: "public",
      pollGroups: [
        {
          name: "uptime",
          intervalMs: 5000,
          handler: "onPoll",
          oids: [{ label: "uptime", oid: "1.3.6.1.2.1.1.3.0" }],
        },
      ],
    },
  ],
  modbusPorts: [
    {
      transport: "TCP",
      name: "plc1",
      host: "10.0.0.1",
      slaves: [
        {
          name: "main",
          unitId: 1,
          pollGroups: [
            {
              name: "g1",
              intervalMs: 1000,
              handler: "onPoll",
              reads: [
                { label: "x", function: "INPUT", address: 0, quantity: 1, type: "UINT16" },
              ],
            },
          ],
        },
      ],
    },
  ],
  execCommands: [
    {
      name: "ping",
      path: "/usr/bin/ping",
      args: ["-c", "1", "\${input}"],
      timeoutMs: 5000,
    },
  ],
  httpRoutes: [
    {
      method: "POST",
      path: "/webhook",
      handler: "onWebhook",
      auth: { mode: "BEARER", bearerTokens: ["t-1"] },
    },
  ],
});
`,
    );

    const loaded = await loadManifest(root);
    const edge = expectEdge(loaded);
    expect(edge.app.mqtt_brokers).toHaveLength(1);
    expect(edge.app.mqtt_brokers?.[0]?.subscriptions[0]?.handler).toBe("onMsg");
    expect(edge.app.opcua_endpoints?.[0]?.auth?.mode).toBe("ANONYMOUS");
    expect(edge.app.snmp_devices?.[0]?.community).toBe("public");
    expect(edge.app.modbus_ports?.[0]?.transport).toBe("TCP");
    expect(edge.app.exec_commands?.[0]?.path).toBe("/usr/bin/ping");
    expect(edge.app.http_routes?.[0]?.auth.mode).toBe("BEARER");
  });

  test("rejects MQTT subscription referencing an undefined handler", async () => {
    mkdirSync(join(root, "handlers"));
    writeFileSync(join(root, "handlers/known.lua"), "-- noop\n");
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineEdgeApp, luaFile } from "${DEFINE_PATH}";

export default defineEdgeApp({
  handle: "stray",
  name: "Stray",
  handlers: { known: luaFile("./handlers/known.lua") },
  triggers: [],
  mqttBrokers: [
    {
      name: "b",
      url: "mqtt://b:1883",
      // @ts-expect-error — bypass via cast at the array level
      subscriptions: [{ topic: "x", handler: "missing" }] as any,
    },
  ],
});
`,
    );
    await expect(loadManifest(root)).rejects.toThrow(
      /MQTT broker.*subscription.*missing/,
    );
  });

  test("rejects a trigger that references an undefined handler at runtime too", async () => {
    // Belt-and-braces: the type system already prevents this for
    // typed callers, but a runtime cast or YAML→TS bridge would slip
    // through. Loader catches it.
    mkdirSync(join(root, "handlers"));
    writeFileSync(join(root, "handlers/known.lua"), "-- noop\n");
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineEdgeApp, luaFile } from "${DEFINE_PATH}";

export default defineEdgeApp({
  handle: "broken",
  name: "Broken",
  handlers: { known: luaFile("./handlers/known.lua") },
  triggers: [
    // @ts-expect-error — bypass via cast
    { kind: "CRON", name: "tick", handler: "missing", schedule: "* * * * *" },
  ] as any,
});
`,
    );
    await expect(loadManifest(root)).rejects.toThrow(
      /references handler 'missing'/,
    );
  });
});
