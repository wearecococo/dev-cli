/**
 * Plan computation: given (declared, state, live), produce the list
 * of operations apply needs to execute. Pure — no I/O, no GraphQL.
 *
 * Three inputs, one output. Each declared resource is matched against
 * its state entry (last successfully applied) and its live entry
 * (what the server currently reports), producing one of:
 *
 *  - `create` — declared, no state entry.
 *  - `update` — declared, state has it, declared differs from lastApplied.
 *  - `update (server modified)` — declared, state has it, declared
 *      matches lastApplied, but live differs from lastApplied. Apply
 *      re-converges the server to declared.
 *  - `noop`   — declared, state has it, declared matches lastApplied,
 *      live matches too.
 *  - `delete` — state has it, no longer declared.
 *
 * Resources that exist on the server but aren't in state and aren't
 * declared are *ignored*. Phase 1 deliberately doesn't surface them in
 * plan output — they belong to other repos / dashboard users / etc.
 */

import type { LoadedOps } from "../ops.ts";
import {
  controllerHandle,
  iamPolicyHandle,
  teamName,
  userEmail,
} from "../define.ts";
import type {
  ManagedResource,
  ResourceIdentity,
  ResourceKind,
  StateFile,
} from "./types.ts";
import { KIND_FORWARD_ORDER, identityKey } from "./types.ts";
import type { LiveSnapshot } from "./live-fetch.ts";
import {
  managedSpecFromDeclared,
  managedSpecFromLive,
  type ManagedSpec,
} from "./managed-specs.ts";

export type FieldDiff = {
  path: string;
  declared: unknown;
  lastApplied: unknown;
  live: unknown;
};

export type PlanAction =
  | { op: "create"; identity: ResourceIdentity; spec: ManagedSpec }
  | {
      op: "update";
      identity: ResourceIdentity;
      spec: ManagedSpec;
      diff: FieldDiff[];
      /**
       * True when the declared spec hasn't changed since last apply,
       * but the server has drifted away from it. Apply will re-converge
       * the server to declared.
       */
      serverModified: boolean;
    }
  | { op: "delete"; identity: ResourceIdentity; lastAppliedSpec: ManagedSpec }
  | { op: "noop"; identity: ResourceIdentity };

export type Plan = {
  /** Sorted: forward kind order, then by identity key. Deterministic. */
  actions: PlanAction[];
};

/**
 * Compute the operations needed to bring the server in line with the
 * declared spec, given the recorded state. Caller fetches `live` —
 * see `live-fetch.ts`.
 */
export function computePlan(
  declared: LoadedOps,
  state: StateFile | null,
  live: LiveSnapshot,
): Plan {
  const actions: PlanAction[] = [];
  const stateByKey = indexState(state);
  const seenKeys = new Set<string>();

  for (const { identity, spec } of declaredEntries(declared)) {
    const key = identityKey(identity);
    seenKeys.add(key);
    const stateEntry = stateByKey.get(key);
    const liveSpec = live.get(key);

    if (!stateEntry) {
      // Not previously managed by this workspace. Treat as a create —
      // the underlying upsert is idempotent if the server already has
      // a matching row (adoption path).
      actions.push({ op: "create", identity, spec });
      continue;
    }

    const last = stateEntry.lastAppliedSpec;

    if (deepEqual(spec, last)) {
      if (!liveSpec) {
        // Server-side delete since last apply. Re-create.
        actions.push({ op: "create", identity, spec });
        continue;
      }
      if (deepEqual(spec, liveSpec)) {
        actions.push({ op: "noop", identity });
        continue;
      }
      // Declared still matches last-applied, but live drifted.
      const diff = diffSpecs(last, spec, liveSpec);
      actions.push({
        op: "update",
        identity,
        spec,
        diff,
        serverModified: true,
      });
      continue;
    }

    // Declared changed since last apply.
    const diff = diffSpecs(last, spec, liveSpec ?? null);
    actions.push({
      op: "update",
      identity,
      spec,
      diff,
      serverModified: false,
    });
  }

  if (state) {
    for (const r of state.resources) {
      const key = identityKey(r.identity);
      if (seenKeys.has(key)) continue;
      actions.push({
        op: "delete",
        identity: r.identity,
        lastAppliedSpec: r.lastAppliedSpec,
      });
    }
  }

  return { actions: sortActions(actions) };
}

/**
 * Sort the plan: kinds in forward order (creates/updates), and within
 * a kind, sort by identity key. Apply-time will execute deletes in
 * reverse kind order; the plan keeps a single deterministic order so
 * preview output is stable across runs.
 */
export function sortActions(actions: PlanAction[]): PlanAction[] {
  const kindOrder = new Map(KIND_FORWARD_ORDER.map((k, i) => [k, i]));
  return [...actions].sort((a, b) => {
    const ak = kindOrder.get(a.identity.kind) ?? 99;
    const bk = kindOrder.get(b.identity.kind) ?? 99;
    if (ak !== bk) return ak - bk;
    return identityKey(a.identity).localeCompare(identityKey(b.identity));
  });
}

/**
 * Apply executes deletes in reverse kind order — bindings come down
 * before the users/policies they reference, etc.
 */
export function deleteOpsInExecutionOrder(actions: PlanAction[]): PlanAction[] {
  const deletes = actions.filter((a): a is Extract<PlanAction, { op: "delete" }> => a.op === "delete");
  const reverseOrder = new Map(
    [...KIND_FORWARD_ORDER].reverse().map((k, i) => [k, i]),
  );
  return [...deletes].sort((a, b) => {
    const ak = reverseOrder.get(a.identity.kind) ?? 99;
    const bk = reverseOrder.get(b.identity.kind) ?? 99;
    if (ak !== bk) return ak - bk;
    return identityKey(a.identity).localeCompare(identityKey(b.identity));
  });
}

export function nonDeleteOpsInExecutionOrder(actions: PlanAction[]): PlanAction[] {
  const nonDelete = actions.filter((a) => a.op !== "delete" && a.op !== "noop");
  return sortActions(nonDelete);
}

function indexState(state: StateFile | null): Map<string, ManagedResource> {
  const out = new Map<string, ManagedResource>();
  if (!state) return out;
  for (const r of state.resources) out.set(identityKey(r.identity), r);
  return out;
}

/**
 * Walk every declared resource across all ops kinds. Per-kind code
 * lives here (rather than in adapter objects) — phase 1 has 11 kinds,
 * a switch statement is the readable thing.
 */
function* declaredEntries(
  ops: LoadedOps,
): Generator<{ identity: ResourceIdentity; spec: ManagedSpec }> {
  for (const p of ops.policies) {
    yield {
      identity: { kind: "iam_policy", handle: p.handle },
      spec: managedSpecFromDeclared("iam_policy", p),
    };
  }
  for (const u of ops.users) {
    yield {
      identity: { kind: "user", email: u.email },
      spec: managedSpecFromDeclared("user", u),
    };
  }
  for (const b of ops.policyBindings) {
    yield {
      identity: {
        kind: "iam_policy_binding",
        email: userEmail(b.user),
        policyHandle: iamPolicyHandle(b.policy),
      },
      spec: managedSpecFromDeclared("iam_policy_binding", b),
    };
  }
  for (const n of ops.networks) {
    yield {
      identity: { kind: "network", name: n.name },
      spec: managedSpecFromDeclared("network", n),
    };
  }
  for (const d of ops.devices) {
    yield {
      identity: { kind: "device", identifier: d.identifier },
      spec: managedSpecFromDeclared("device", d),
    };
  }
  for (const t of ops.teams) {
    yield {
      identity: { kind: "team", name: t.name },
      spec: managedSpecFromDeclared("team", t),
    };
  }
  for (const r of ops.customAppUserBindings) {
    yield {
      identity: {
        kind: "custom_app_user_binding",
        email: userEmail(r.user),
        appHandle: r.app,
      },
      spec: managedSpecFromDeclared("custom_app_user_binding", r),
    };
  }
  for (const r of ops.customAppTeamBindings) {
    yield {
      identity: {
        kind: "custom_app_team_binding",
        teamName: teamName(r.team),
        appHandle: r.app,
      },
      spec: managedSpecFromDeclared("custom_app_team_binding", r),
    };
  }
  for (const c of ops.controllers) {
    yield {
      identity: { kind: "controller", handle: c.handle },
      spec: managedSpecFromDeclared("controller", c),
    };
  }
  for (const tk of ops.controllerTokens) {
    yield {
      identity: {
        kind: "controller_token",
        controllerHandle: controllerHandle(tk.controller),
        name: tk.name,
      },
      spec: managedSpecFromDeclared("controller_token", tk),
    };
  }
  for (const i of ops.edgeAppInstallations) {
    yield {
      identity: {
        kind: "edge_app_installation",
        controllerHandle: controllerHandle(i.controller),
        appHandle: i.app,
      },
      spec: managedSpecFromDeclared("edge_app_installation", i),
    };
  }
  for (const i of ops.integrationInstallations) {
    yield {
      identity: {
        kind: "integration_installation",
        integration: i.integration,
        name: i.name,
      },
      spec: managedSpecFromDeclared("integration_installation", i),
    };
  }
}

/**
 * Compute a flat top-level diff between two managed specs. Nested
 * objects/arrays surface as a single entry with the whole sub-tree as
 * the value — the renderer expands known structural fields (team
 * `members`, controller `policy.allowedIoPaths`) when displaying.
 *
 * `live` is informational only — used to show server drift in the
 * rendered output.
 */
export function diffSpecs(
  lastApplied: ManagedSpec,
  declared: ManagedSpec,
  live: ManagedSpec | null,
): FieldDiff[] {
  const out: FieldDiff[] = [];
  const keys = new Set<string>([
    ...Object.keys(lastApplied),
    ...Object.keys(declared),
  ]);
  for (const key of [...keys].sort()) {
    const a = lastApplied[key];
    const b = declared[key];
    if (deepEqual(a, b)) continue;
    out.push({
      path: key,
      lastApplied: a,
      declared: b,
      live: live ? live[key] : undefined,
    });
  }
  return out;
}

/**
 * Structural equality: deep, key-order-insensitive. Treats `undefined`
 * and missing keys as equivalent so specs round-tripping through
 * JSON serialisation compare correctly.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set<string>([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) {
      const av = ao[k];
      const bv = bo[k];
      if (av === undefined && bv === undefined) continue;
      if (!deepEqual(av, bv)) return false;
    }
    return true;
  }
  return false;
}

/** Re-export so live-fetch can build snapshots from the same shape. */
export type { LiveSnapshot } from "./live-fetch.ts";
export { managedSpecFromLive };
export type { ManagedSpec } from "./managed-specs.ts";
export type { ResourceKind };
