import { describe, expect, test } from "bun:test";
import {
  defineCustomApp,
  defineIntegration,
  file,
  isFileMarker,
  isLuaFileMarker,
  luaFile,
  manifestKind,
} from "../src/define.ts";

describe("file() marker", () => {
  test("returns a sentinel carrying the requested path", () => {
    const ref = file("./template.vue");
    expect(isFileMarker(ref)).toBe(true);
    if (isFileMarker(ref)) {
      expect(ref.path).toBe("./template.vue");
    }
  });

  test("file and luaFile produce distinct markers", () => {
    const f = file("./x.vue");
    const lf = luaFile("./x.lua");
    expect(isFileMarker(f)).toBe(true);
    expect(isLuaFileMarker(f)).toBe(false);
    expect(isFileMarker(lf)).toBe(false);
    expect(isLuaFileMarker(lf)).toBe(true);
  });
});

describe("manifestKind discriminator", () => {
  test("defineIntegration tags result as 'integration'", () => {
    const spec = defineIntegration({
      id: "com.acme.foo",
      version: "0.1.0",
      sdkVersion: "1.0",
      runtimeMode: "script_actor",
      resources: [],
      permissions: [],
    });
    expect(manifestKind(spec)).toBe("integration");
  });

  test("defineCustomApp tags result as 'app'", () => {
    const spec = defineCustomApp({
      handle: "job-board",
      name: "Job Board",
      kind: "PAGE",
      template: "<div/>",
      script: "// boot",
    });
    expect(manifestKind(spec)).toBe("app");
  });

  test("plain objects are untagged", () => {
    expect(manifestKind({})).toBeUndefined();
    expect(manifestKind({ id: "x" })).toBeUndefined();
    expect(manifestKind(null)).toBeUndefined();
    expect(manifestKind("string")).toBeUndefined();
  });

  test("the tag survives spread / Object.assign (Symbol-keyed)", () => {
    const spec = defineCustomApp({
      handle: "job-board",
      name: "Job Board",
      kind: "PAGE",
      template: "<div/>",
      script: "// boot",
    });
    const copy = { ...spec };
    expect(manifestKind(copy)).toBe("app");
  });

  test("the tag is invisible to JSON.stringify (wire payload unaffected)", () => {
    const spec = defineCustomApp({
      handle: "job-board",
      name: "Job Board",
      kind: "PAGE",
      template: "<div/>",
      script: "// boot",
    });
    const json = JSON.stringify(spec);
    const round = JSON.parse(json);
    expect(round.handle).toBe("job-board");
    expect(round.kind).toBe("PAGE");
    // Symbol-keyed property doesn't survive JSON.
    expect(manifestKind(round)).toBeUndefined();
  });
});

describe("defineCustomApp identity", () => {
  test("returns a value usable in TS-strict context (handle, kind, etc. accessible)", () => {
    const spec = defineCustomApp({
      handle: "job-board",
      name: "Job Board",
      kind: "DASHBOARD",
      template: file("./template.vue"),
      script: file("./script.js"),
      serverApi: luaFile("./server.lua"),
    });
    expect(spec.handle).toBe("job-board");
    expect(spec.kind).toBe("DASHBOARD");
    expect(isFileMarker(spec.template)).toBe(true);
    expect(isLuaFileMarker(spec.serverApi)).toBe(true);
  });
});
