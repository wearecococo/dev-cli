import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  manifestKind,
  type Binding,
  type Device,
  type IAMPolicy,
  type Network,
  type User,
} from "./define.ts";

export const USERS_FILENAME = "users.ts";
export const POLICIES_FILENAME = "iam_policies.ts";
export const BINDINGS_FILENAME = "bindings.ts";
export const NETWORKS_FILENAME = "networks.ts";
export const DEVICES_FILENAME = "devices.ts";

export type LoadedOps = {
  /** Absolute paths to the files that were loaded. */
  files: {
    users?: string;
    policies?: string;
    bindings?: string;
    networks?: string;
    devices?: string;
  };
  users: User[];
  policies: IAMPolicy[];
  bindings: Binding[];
  networks: Network[];
  devices: Device[];
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
  const networksPath = resolve(repoRoot, NETWORKS_FILENAME);
  const devicesPath = resolve(repoRoot, DEVICES_FILENAME);

  const out: LoadedOps = {
    files: {},
    users: [],
    policies: [],
    bindings: [],
    networks: [],
    devices: [],
  };

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
  if (existsSync(networksPath)) {
    out.networks = await loadList(networksPath, "networks", "networks");
    out.files.networks = networksPath;
  }
  if (existsSync(devicesPath)) {
    out.devices = await loadList(devicesPath, "devices", "devices");
    out.files.devices = devicesPath;
  }

  validateNoDuplicates(out);
  return out;
}

type OpsKind = "users" | "iam_policies" | "bindings" | "networks" | "devices";
type OpsField = "users" | "policies" | "bindings" | "networks" | "devices";

async function loadList<T>(
  absPath: string,
  expectedKind: OpsKind,
  field: OpsField,
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

function expectedKindHelper(kind: OpsKind): string {
  if (kind === "users") return "Users";
  if (kind === "iam_policies") return "IAMPolicies";
  if (kind === "bindings") return "Bindings";
  if (kind === "networks") return "Networks";
  return "Devices";
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
  const seenNetworks = new Set<string>();
  for (const n of ops.networks) {
    if (seenNetworks.has(n.name)) {
      throw new Error(
        `Duplicate network name '${n.name}' in networks.ts. Name is the natural key.`,
      );
    }
    seenNetworks.add(n.name);
  }
  const seenDevices = new Set<string>();
  for (const d of ops.devices) {
    if (seenDevices.has(d.identifier)) {
      throw new Error(
        `Duplicate device identifier '${d.identifier}' in devices.ts. Identifier is the natural key.`,
      );
    }
    seenDevices.add(d.identifier);
  }
}
