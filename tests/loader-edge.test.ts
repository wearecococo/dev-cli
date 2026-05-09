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
