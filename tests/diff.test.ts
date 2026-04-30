import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffFiles, summarize } from "../src/diff.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cococo-diff-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeLocal(path: string, content: string): string {
  const abs = join(dir, path);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

describe("diffFiles", () => {
  test("classifies added, changed, deleted, unchanged", () => {
    const local = new Map<string, string>([
      ["scripts/main.lua", writeLocal("main.lua", "return 1")],
      ["scripts/new.lua", writeLocal("new.lua", "new file")],
      ["scripts/same.lua", writeLocal("same.lua", "same content")],
    ]);
    const remote = new Map<string, string>([
      ["scripts/main.lua", "return 0"], // changed
      ["scripts/same.lua", "same content"], // unchanged
      ["scripts/gone.lua", "remote-only"], // deleted
    ]);

    const d = diffFiles(local, remote);
    expect(d.added).toEqual(["scripts/new.lua"]);
    expect(d.changed).toEqual(["scripts/main.lua"]);
    expect(d.unchanged).toEqual(["scripts/same.lua"]);
    expect(d.deleted).toEqual(["scripts/gone.lua"]);
  });

  test("empty inputs yield empty diff", () => {
    const d = diffFiles(new Map(), new Map());
    expect(d.added).toEqual([]);
    expect(d.changed).toEqual([]);
    expect(d.unchanged).toEqual([]);
    expect(d.deleted).toEqual([]);
  });

  test("results are sorted for stable output", () => {
    const local = new Map<string, string>([
      ["b.lua", writeLocal("b.lua", "b")],
      ["a.lua", writeLocal("a.lua", "a")],
    ]);
    const d = diffFiles(local, new Map());
    expect(d.added).toEqual(["a.lua", "b.lua"]);
  });
});

describe("summarize", () => {
  test("formats counts compactly", () => {
    const s = summarize({
      added: ["a"],
      changed: ["b", "c"],
      unchanged: [],
      deleted: ["d", "e", "f"],
    });
    expect(s).toBe("+1 added, ~2 changed, -3 deleted");
  });
});
