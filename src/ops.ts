import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  manifestKind,
  type BindingSpec,
  type IAMPolicySpec,
  type UserSpec,
} from "./define.ts";

export const USERS_FILENAME = "users.ts";
export const POLICIES_FILENAME = "iam_policies.ts";
export const BINDINGS_FILENAME = "bindings.ts";

export type LoadedOps = {
  /** Absolute paths to the files that were loaded. */
  files: { users?: string; policies?: string; bindings?: string };
  users: UserSpec[];
  policies: IAMPolicySpec[];
  bindings: BindingSpec[];
};

/**
 * Load whichever of `users.ts` / `iam_policies.ts` / `bindings.ts` exist
 * at `repoRoot`. Missing files are silently skipped — the apply command
 * will pick up only what's declared.
 *
 * Cross-references are checked locally where it's cheap: every binding
 * must reference a user/policy that's either declared in this manifest
 * or that the apply command can resolve on the server. We only catch
 * the first half here (reject bindings to undeclared local entities); the
 * server-resolution check happens at apply time so the loader stays
 * pure (no network).
 */
export async function loadOps(repoRoot: string): Promise<LoadedOps> {
  const usersPath = resolve(repoRoot, USERS_FILENAME);
  const policiesPath = resolve(repoRoot, POLICIES_FILENAME);
  const bindingsPath = resolve(repoRoot, BINDINGS_FILENAME);

  const out: LoadedOps = { files: {}, users: [], policies: [], bindings: [] };

  if (existsSync(usersPath)) {
    out.users = await loadList(usersPath, "users", "users");
    out.files.users = usersPath;
  }
  if (existsSync(policiesPath)) {
    out.policies = await loadList(policiesPath, "iam_policies", "policies");
    out.files.policies = policiesPath;
  }
  if (existsSync(bindingsPath)) {
    out.bindings = await loadList(bindingsPath, "bindings", "bindings");
    out.files.bindings = bindingsPath;
  }

  validateNoDuplicates(out);
  return out;
}

async function loadList<T>(
  absPath: string,
  expectedKind: "users" | "iam_policies" | "bindings",
  field: "users" | "policies" | "bindings",
): Promise<T[]> {
  const url = `${absPath}?t=${Date.now()}`;
  const mod = await import(url);
  const spec = (mod as { default?: unknown }).default;
  if (!spec || typeof spec !== "object") {
    throw new Error(
      `${absPath}: must default-export the result of define${expectedKindHelper(expectedKind)}([...]).`,
    );
  }
  const kind = manifestKind(spec);
  if (kind !== expectedKind) {
    throw new Error(
      `${absPath}: expected default export from define${expectedKindHelper(expectedKind)}([...]); ` +
        `got ${kind ? `define${expectedKindHelper(kind as typeof expectedKind)}([...])` : "an untagged value"}.`,
    );
  }
  const list = (spec as Record<string, unknown>)[field];
  if (!Array.isArray(list)) {
    throw new Error(`${absPath}: defineX result missing '${field}' array.`);
  }
  return list as T[];
}

function expectedKindHelper(kind: "users" | "iam_policies" | "bindings"): string {
  if (kind === "users") return "Users";
  if (kind === "iam_policies") return "IAMPolicies";
  return "Bindings";
}

function validateNoDuplicates(ops: LoadedOps): void {
  const seenEmails = new Set<string>();
  for (const u of ops.users) {
    if (seenEmails.has(u.email)) {
      throw new Error(
        `Duplicate user email '${u.email}' in users.ts. Email is the natural key — each user must appear once.`,
      );
    }
    seenEmails.add(u.email);
  }
  const seenHandles = new Set<string>();
  for (const p of ops.policies) {
    if (seenHandles.has(p.handle)) {
      throw new Error(
        `Duplicate policy handle '${p.handle}' in iam_policies.ts. Handle is the natural key.`,
      );
    }
    seenHandles.add(p.handle);
  }
  const seenBindings = new Set<string>();
  for (const b of ops.bindings) {
    const key = `${b.user}|${b.policy}`;
    if (seenBindings.has(key)) {
      throw new Error(
        `Duplicate binding ${b.user} → ${b.policy} in bindings.ts.`,
      );
    }
    seenBindings.add(key);
  }
}
