import { describe, expect, test } from "bun:test";
import { bundleToFiles } from "../src/bundle.ts";
import type { IntegrationBundle } from "../src/graphql/operations.ts";

function bundle(overrides: Partial<IntegrationBundle> = {}): IntegrationBundle {
  return {
    manifest: {
      id: "com.acme.foo",
      version: "0.1.0",
      sdkVersion: "1.0.0",
      resources: [],
      permissions: [],
    },
    scripts: "{}",
    workflows: "{}",
    customAppFiles: "{}",
    runtimeMode: "script_actor",
    ...overrides,
  };
}

describe("bundleToFiles", () => {
  test("re-prefixes bundle entries by category (server stores bare filenames)", () => {
    const files = bundleToFiles(
      bundle({
        scripts: JSON.stringify({
          "main.lua": "return {}",
          "util.lua": "-- util",
        }),
        workflows: JSON.stringify({ "foo.yaml": "name: foo" }),
        customAppFiles: JSON.stringify({ "index.html": "<html/>" }),
      }),
    );
    expect(files.size).toBe(4);
    expect(files.get("scripts/main.lua")).toBe("return {}");
    expect(files.get("scripts/util.lua")).toBe("-- util");
    expect(files.get("workflows/foo.yaml")).toBe("name: foo");
    expect(files.get("app/index.html")).toBe("<html/>");
  });

  test("surfaces configSchema and policy as fixed paths", () => {
    const files = bundleToFiles(
      bundle({
        configSchema: '{"type":"object"}',
        policy: "p, *, *",
      }),
    );
    expect(files.get("config_schema.json")).toBe('{"type":"object"}');
    expect(files.get("policy.yaml")).toBe("p, *, *");
  });

  test("ignores empty configSchema/policy", () => {
    const files = bundleToFiles(bundle({ configSchema: "", policy: null }));
    expect(files.has("config_schema.json")).toBe(false);
    expect(files.has("policy.yaml")).toBe(false);
  });

  test("skips non-string entries in file maps", () => {
    const files = bundleToFiles(
      bundle({
        scripts: JSON.stringify({ "main.lua": "ok", broken: 42 }),
      }),
    );
    expect(files.get("scripts/main.lua")).toBe("ok");
    expect(files.has("scripts/broken")).toBe(false);
  });

  test("tolerates malformed JSON", () => {
    const files = bundleToFiles(bundle({ scripts: "not json" }));
    expect(files.size).toBe(0);
  });
});
