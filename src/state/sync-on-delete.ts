/**
 * After an explicit `cococo delete <kind> <args>` succeeds, remove the
 * corresponding entry from `.cococo/state.json` if a state file exists.
 * Pure-by-default: in additive (no-state) workspaces this is a no-op.
 *
 * Without this hook, deleting via the CLI would leave the state file
 * pointing at a now-missing resource — and the next `cococo plan` /
 * `cococo apply` would re-create it because state still says "this
 * was last applied successfully".
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { LocalFileStateBackend } from "./local-backend.ts";
import { identityKey, type ResourceIdentity } from "./types.ts";

export async function syncStateAfterDelete(
  identity: ResourceIdentity,
): Promise<void> {
  const cwd = process.cwd();
  if (!existsSync(resolve(cwd, ".cococo/state.json"))) return;

  const backend = new LocalFileStateBackend(cwd);
  const release = await backend.lock();
  try {
    const state = await backend.read();
    if (!state) return;
    const targetKey = identityKey(identity);
    const before = state.resources.length;
    state.resources = state.resources.filter(
      (r) => identityKey(r.identity) !== targetKey,
    );
    if (state.resources.length === before) return;
    state.lastAppliedAt = new Date().toISOString();
    await backend.write(state);
    console.log(`  (also removed from .cococo/state.json)`);
  } finally {
    await release();
  }
}
