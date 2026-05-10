import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import type { StateBackend } from "./backend.ts";
import type { StateFile } from "./types.ts";
import { STATE_SCHEMA_VERSION } from "./types.ts";

const STATE_FILE = ".cococo/state.json";
const LOCK_FILE = ".cococo/state.lock";

/**
 * Default stale-lock window — a held lock older than this is
 * considered abandoned (prior process crashed or was SIGKILL'd) and
 * we forcibly take it. Override via `COCOCO_LOCK_TIMEOUT_MS` for
 * tests or pathological CI environments.
 */
const DEFAULT_STALE_LOCK_MS = 5 * 60 * 1000;

type LockContents = {
  pid: number;
  acquiredAt: string;
};

export class LocalFileStateBackend implements StateBackend {
  constructor(private readonly workspaceRoot: string) {}

  async read(): Promise<StateFile | null> {
    const path = resolve(this.workspaceRoot, STATE_FILE);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`State file at ${STATE_FILE} is not valid JSON: ${msg}`);
    }
    if (!isStateFile(parsed)) {
      throw new Error(
        `State file at ${STATE_FILE} has unexpected shape — expected ` +
          `schemaVersion=${STATE_SCHEMA_VERSION}.`,
      );
    }
    return parsed;
  }

  async write(state: StateFile): Promise<void> {
    const path = resolve(this.workspaceRoot, STATE_FILE);
    mkdirSync(dirname(path), { recursive: true });
    // Pretty-print for diffability — committed JSON should merge cleanly.
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
  }

  async lock(): Promise<() => Promise<void>> {
    const path = resolve(this.workspaceRoot, LOCK_FILE);
    mkdirSync(dirname(path), { recursive: true });

    if (existsSync(path)) {
      const existing = readLock(path);
      const ageMs = existing ? Date.now() - Date.parse(existing.acquiredAt) : Infinity;
      const staleMs = staleLockMs();
      if (existing && ageMs < staleMs && processIsAlive(existing.pid)) {
        throw new Error(
          `State is locked by another cococo process (pid=${existing.pid}, ` +
            `acquired ${existing.acquiredAt}). If that process has crashed, ` +
            `delete ${LOCK_FILE} manually or wait ${Math.ceil((staleMs - ageMs) / 1000)}s ` +
            `for the lock to be considered stale.`,
        );
      }
      // Stale or owner-dead — take over.
      rmSync(path, { force: true });
    }

    const contents: LockContents = {
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
    };
    writeFileSync(path, JSON.stringify(contents) + "\n");

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      // Only remove the lockfile if it still represents *our* hold —
      // otherwise we'd clobber another process's later lock if our
      // release ran late.
      const current = existsSync(path) ? readLock(path) : null;
      if (current && current.pid === process.pid && current.acquiredAt === contents.acquiredAt) {
        rmSync(path, { force: true });
      }
    };
  }
}

function readLock(path: string): LockContents | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockContents>;
    if (typeof parsed.pid !== "number" || typeof parsed.acquiredAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, acquiredAt: parsed.acquiredAt };
  } catch {
    return null;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    // Signal 0 is "are you there" — throws ESRCH if the pid is gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function staleLockMs(): number {
  const env = process.env.COCOCO_LOCK_TIMEOUT_MS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_STALE_LOCK_MS;
}

function isStateFile(x: unknown): x is StateFile {
  if (!x || typeof x !== "object") return false;
  const obj = x as Record<string, unknown>;
  return (
    obj.schemaVersion === STATE_SCHEMA_VERSION &&
    Array.isArray(obj.resources) &&
    (obj.lastAppliedAt === null || typeof obj.lastAppliedAt === "string")
  );
}
