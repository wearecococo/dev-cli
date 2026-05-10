import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalFileStateBackend } from "../src/state/local-backend.ts";
import type { StateFile } from "../src/state/types.ts";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cococo-state-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.COCOCO_LOCK_TIMEOUT_MS;
});

const sampleState: StateFile = {
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

describe("LocalFileStateBackend — read/write round-trip", () => {
  test("read returns null when no state file exists", async () => {
    const backend = new LocalFileStateBackend(root);
    expect(await backend.read()).toBeNull();
  });

  test("write then read returns the same state", async () => {
    const backend = new LocalFileStateBackend(root);
    await backend.write(sampleState);
    const read = await backend.read();
    expect(read).toEqual(sampleState);
  });

  test("write creates .cococo/ directory if it doesn't exist", async () => {
    const backend = new LocalFileStateBackend(root);
    await backend.write(sampleState);
    expect(existsSync(join(root, ".cococo/state.json"))).toBe(true);
  });

  test("write produces pretty-printed JSON for diffability", async () => {
    const backend = new LocalFileStateBackend(root);
    await backend.write(sampleState);
    const raw = readFileSync(join(root, ".cococo/state.json"), "utf8");
    expect(raw).toContain("\n");
    expect(raw).toContain("  "); // indentation
    expect(raw.endsWith("\n")).toBe(true);
  });

  test("read throws on corrupt JSON with a clear error", async () => {
    const dotcococo = join(root, ".cococo");
    require("node:fs").mkdirSync(dotcococo);
    writeFileSync(join(dotcococo, "state.json"), "{ not json");
    const backend = new LocalFileStateBackend(root);
    await expect(backend.read()).rejects.toThrow(/not valid JSON/);
  });

  test("read throws on unexpected schema with a hint about schemaVersion", async () => {
    const dotcococo = join(root, ".cococo");
    require("node:fs").mkdirSync(dotcococo);
    writeFileSync(
      join(dotcococo, "state.json"),
      JSON.stringify({ schemaVersion: 99, resources: [] }),
    );
    const backend = new LocalFileStateBackend(root);
    await expect(backend.read()).rejects.toThrow(/unexpected shape/);
  });
});

describe("LocalFileStateBackend — locking", () => {
  test("lock then release leaves the lockfile gone", async () => {
    const backend = new LocalFileStateBackend(root);
    const release = await backend.lock();
    expect(existsSync(join(root, ".cococo/state.lock"))).toBe(true);
    await release();
    expect(existsSync(join(root, ".cococo/state.lock"))).toBe(false);
  });

  test("release is idempotent", async () => {
    const backend = new LocalFileStateBackend(root);
    const release = await backend.lock();
    await release();
    await release();
    expect(existsSync(join(root, ".cococo/state.lock"))).toBe(false);
  });

  test("acquiring an existing live lock throws with a diagnostic message", async () => {
    const lockPath = join(root, ".cococo/state.lock");
    require("node:fs").mkdirSync(join(root, ".cococo"));
    // Simulate an existing lock held by *this* process — guaranteed alive.
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    );
    const backend = new LocalFileStateBackend(root);
    await expect(backend.lock()).rejects.toThrow(/locked by another cococo process/);
  });

  test("stale lock (older than threshold) is forcibly taken", async () => {
    process.env.COCOCO_LOCK_TIMEOUT_MS = "100";
    const lockPath = join(root, ".cococo/state.lock");
    require("node:fs").mkdirSync(join(root, ".cococo"));
    writeFileSync(
      lockPath,
      JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const backend = new LocalFileStateBackend(root);
    const release = await backend.lock();
    // Lock was taken — the file now contains *our* lock with a current timestamp.
    const newContents = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(newContents.pid).toBe(process.pid);
    await release();
  });

  test("dead-pid lock is forcibly taken even when fresh", async () => {
    const lockPath = join(root, ".cococo/state.lock");
    require("node:fs").mkdirSync(join(root, ".cococo"));
    // PID 1 is init — alive on every Unix box. Pick a PID that's almost certainly dead.
    // Use a very high number; we tolerate a tiny chance of false positive.
    const probablyDeadPid = 999999;
    writeFileSync(
      lockPath,
      JSON.stringify({ pid: probablyDeadPid, acquiredAt: new Date().toISOString() }),
    );
    const backend = new LocalFileStateBackend(root);
    const release = await backend.lock();
    const newContents = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(newContents.pid).toBe(process.pid);
    await release();
  });

  test("releasing a lock we don't own anymore is a no-op", async () => {
    const backend = new LocalFileStateBackend(root);
    const release = await backend.lock();
    // Simulate someone else taking the lock by overwriting it.
    writeFileSync(
      join(root, ".cococo/state.lock"),
      JSON.stringify({ pid: 1, acquiredAt: new Date().toISOString() }),
    );
    await release();
    // The "other" lock should still be there — we shouldn't have clobbered it.
    expect(existsSync(join(root, ".cococo/state.lock"))).toBe(true);
  });
});
