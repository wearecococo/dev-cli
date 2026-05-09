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
import { loadManifest, expectApp, expectIntegration } from "../src/loader.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-app-load-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const DEFINE_PATH = new URL("../src/define.ts", import.meta.url).pathname;

describe("loadManifest — custom app", () => {
  test("resolves file() and luaFile() into the wire shape", async () => {
    writeFileSync(join(root, "template.vue"), "<div>hi</div>");
    writeFileSync(join(root, "script.js"), "const setupReturn = {};");
    writeFileSync(join(root, "server.lua"), "exports = {}\n");
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineCustomApp, file, luaFile } from "${DEFINE_PATH}";

export default defineCustomApp({
  handle: "job-board",
  name: "Job Board",
  kind: "PAGE",
  template: file("./template.vue"),
  script: file("./script.js"),
  serverApi: luaFile("./server.lua"),
});
`,
    );

    const loaded = await loadManifest(root);
    expect(loaded.kind).toBe("app");
    const app = expectApp(loaded);
    expect(app.app.handle).toBe("job-board");
    expect(app.app.name).toBe("Job Board");
    expect(app.app.kind).toBe("PAGE");
    expect(app.app.engine_version).toBe(2);
    expect(app.app.template).toBe("<div>hi</div>");
    expect(app.app.script).toBe("const setupReturn = {};");
    expect(app.app.server_api).toBe("exports = {}\n");
    expect(app.serverApiOrigin?.kind).toBe("file");
    expect(app.consumed.size).toBe(3);
  });

  test("inline strings on template/script work without file()", async () => {
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineCustomApp } from "${DEFINE_PATH}";

export default defineCustomApp({
  handle: "tiny",
  name: "Tiny",
  kind: "PAGE",
  template: "<div>inline</div>",
  script: "const setupReturn = {};",
});
`,
    );
    const loaded = await loadManifest(root);
    const app = expectApp(loaded);
    expect(app.app.template).toBe("<div>inline</div>");
    expect(app.app.script).toBe("const setupReturn = {};");
    expect(app.app.server_api).toBeUndefined();
    expect(app.serverApiOrigin).toBeUndefined();
  });

  test("rejects luaFile() in non-Lua slots (template/script)", async () => {
    writeFileSync(join(root, "wrong.lua"), "exports = {}\n");
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineCustomApp, luaFile } from "${DEFINE_PATH}";

export default defineCustomApp({
  handle: "broken",
  name: "Broken",
  kind: "PAGE",
  template: luaFile("./wrong.lua"),
  script: "const setupReturn = {};",
});
`,
    );
    await expect(loadManifest(root)).rejects.toThrow(/template.*luaFile|serverApi is the only Lua slot/i);
  });

  test("expectIntegration throws when given an app load", async () => {
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineCustomApp } from "${DEFINE_PATH}";

export default defineCustomApp({
  handle: "x",
  name: "X",
  kind: "PAGE",
  template: "<div/>",
  script: "// b",
});
`,
    );
    const loaded = await loadManifest(root);
    expect(() => expectIntegration(loaded)).toThrow(/integration manifest|got a custom app/i);
  });

  test("dataContainerSpec is JSON-encoded into the wire payload", async () => {
    writeFileSync(
      join(root, "manifest.ts"),
      `import { defineCustomApp } from "${DEFINE_PATH}";

export default defineCustomApp({
  handle: "with-spec",
  name: "With Spec",
  kind: "PAGE",
  template: "<div/>",
  script: "// b",
  dataContainerSpec: { type: "object", required: ["foo"] },
});
`,
    );
    const loaded = await loadManifest(root);
    const app = expectApp(loaded);
    expect(app.app.data_container_spec).toBeDefined();
    const parsed = JSON.parse(app.app.data_container_spec!);
    expect(parsed.required).toEqual(["foo"]);
  });
});
