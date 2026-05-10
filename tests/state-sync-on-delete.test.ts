import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncStateAfterDelete } from "../src/state/sync-on-delete.ts";
import type { StateFile } from "../src/state/types.ts";

let root: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-sync-")));
  process.chdir(root);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(root, { recursive: true, force: true });
});

const stateWithUsers = (emails: string[]): StateFile => ({
  schemaVersion: 1,
  lastAppliedAt: "2026-05-10T00:00:00Z",
  resources: emails.map((e) => ({
    identity: { kind: "user", email: e },
    lastAppliedSpec: { email: e, name: "Person", kind: "HUMAN" },
    lastAppliedAt: "2026-05-10T00:00:00Z",
  })),
});

describe("syncStateAfterDelete", () => {
  test("no-op when state.json doesn't exist (additive workspace)", async () => {
    // No file written; should not throw, should not create one.
    await syncStateAfterDelete({ kind: "user", email: "alice@acme.com" });
    expect(readDirHas(root, ".cococo/state.json")).toBe(false);
  });

  test("removes the matching entry from state when present", async () => {
    mkdirSync(join(root, ".cococo"));
    writeFileSync(
      join(root, ".cococo/state.json"),
      JSON.stringify(stateWithUsers(["alice@acme.com", "bob@acme.com"])),
    );
    await syncStateAfterDelete({ kind: "user", email: "alice@acme.com" });
    const after = JSON.parse(
      readFileSync(join(root, ".cococo/state.json"), "utf8"),
    ) as StateFile;
    expect(after.resources).toHaveLength(1);
    expect((after.resources[0]!.identity as { email: string }).email).toBe(
      "bob@acme.com",
    );
  });

  test("identity comparison is case-insensitive on email", async () => {
    mkdirSync(join(root, ".cococo"));
    writeFileSync(
      join(root, ".cococo/state.json"),
      JSON.stringify(stateWithUsers(["Alice@Acme.com"])),
    );
    await syncStateAfterDelete({ kind: "user", email: "alice@acme.com" });
    const after = JSON.parse(
      readFileSync(join(root, ".cococo/state.json"), "utf8"),
    ) as StateFile;
    expect(after.resources).toHaveLength(0);
  });

  test("non-matching identity leaves state untouched", async () => {
    mkdirSync(join(root, ".cococo"));
    writeFileSync(
      join(root, ".cococo/state.json"),
      JSON.stringify(stateWithUsers(["alice@acme.com"])),
    );
    const before = readFileSync(join(root, ".cococo/state.json"), "utf8");
    await syncStateAfterDelete({ kind: "user", email: "carol@acme.com" });
    const after = readFileSync(join(root, ".cococo/state.json"), "utf8");
    // No-op write — file is untouched.
    expect(after).toBe(before);
  });
});

function readDirHas(root: string, path: string): boolean {
  try {
    readFileSync(join(root, path));
    return true;
  } catch {
    return false;
  }
}
