/**
 * Auxiliary `cococo state` subcommands beyond `import`. These are
 * the maintenance verbs for state-tracking:
 *
 *  - `list-unmanaged`: surface resources on the server that aren't
 *    tracked in state — useful when adopting an existing tenant or
 *    auditing what other workspaces / dashboard users have created.
 *  - `forget`: remove an entry from state without deleting it
 *    server-side. Use when handing off a resource to another workspace.
 *  - `refresh`: re-pull `lastAppliedSpec` for every state entry from
 *    the live tenant. Use after manual server edits to re-sync state
 *    without applying anything.
 */

import { createClient } from "../graphql/client.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import {
  listControllers,
  listDevices,
  listIAMPolicies,
  listNetworks,
  listTeams,
  listUsers,
} from "../graphql/operations.ts";
import { LocalFileStateBackend } from "../state/local-backend.ts";
import { fetchLiveSnapshot } from "../state/live-fetch.ts";
import { loadOps } from "../ops.ts";
import {
  identityKey,
  identityLabel,
  type ResourceIdentity,
  type StateFile,
} from "../state/types.ts";

// ── list-unmanaged ────────────────────────────────────────────────────

export async function runStateListUnmanaged(
  overrides: ConfigOverrides,
): Promise<void> {
  const backend = new LocalFileStateBackend(process.cwd());
  const state = await backend.read();
  const stateKeys = new Set(
    (state?.resources ?? []).map((r) => identityKey(r.identity)),
  );
  const client = createClient(loadConfig(overrides));

  const unmanaged: ResourceIdentity[] = [];

  for (const u of await listUsers(client)) {
    const id: ResourceIdentity = { kind: "user", email: u.email };
    if (!stateKeys.has(identityKey(id))) unmanaged.push(id);
  }
  for (const p of await listIAMPolicies(client)) {
    const id: ResourceIdentity = { kind: "iam_policy", handle: p.id };
    if (!stateKeys.has(identityKey(id))) unmanaged.push(id);
  }
  for (const n of await listNetworks(client)) {
    const id: ResourceIdentity = { kind: "network", name: n.name };
    if (!stateKeys.has(identityKey(id))) unmanaged.push(id);
  }
  for (const d of await listDevices(client)) {
    const id: ResourceIdentity = { kind: "device", identifier: d.identifier };
    if (!stateKeys.has(identityKey(id))) unmanaged.push(id);
  }
  for (const t of await listTeams(client)) {
    const id: ResourceIdentity = { kind: "team", name: t.name };
    if (!stateKeys.has(identityKey(id))) unmanaged.push(id);
  }
  for (const c of await listControllers(client)) {
    const id: ResourceIdentity = { kind: "controller", handle: c.handle };
    if (!stateKeys.has(identityKey(id))) unmanaged.push(id);
  }

  if (unmanaged.length === 0) {
    console.log("No unmanaged resources on the server.");
    return;
  }

  console.log(
    `Resources on the server not managed by this workspace's state ` +
      `(${unmanaged.length} total):\n`,
  );
  for (const id of unmanaged.sort((a, b) => identityKey(a).localeCompare(identityKey(b)))) {
    console.log(`  ? ${id.kind.padEnd(28)} ${identityLabel(id)}`);
  }
  console.log(
    `\nNote: bindings, controller tokens, and edge-app installations ` +
      `aren't enumerated here (they require per-parent traversal). Use the ` +
      `dashboard or 'cococo dump' for those.`,
  );
}

// ── forget ────────────────────────────────────────────────────────────

export type ForgetKind =
  | "user"
  | "policy"
  | "iam-policy-binding"
  | "network"
  | "device"
  | "team"
  | "custom-app-user-binding"
  | "custom-app-team-binding"
  | "controller"
  | "controller-token"
  | "edge-app-installation";

export async function runStateForget(
  kind: ForgetKind,
  args: string[],
): Promise<void> {
  const identity = parseForgetIdentity(kind, args);
  const backend = new LocalFileStateBackend(process.cwd());
  const release = await backend.lock();
  try {
    const state = await backend.read();
    if (!state) {
      throw new Error(
        `No state file at .cococo/state.json — nothing to forget. ` +
          `State-tracking only operates on workspaces with an existing state file.`,
      );
    }
    const targetKey = identityKey(identity);
    const before = state.resources.length;
    state.resources = state.resources.filter(
      (r) => identityKey(r.identity) !== targetKey,
    );
    if (state.resources.length === before) {
      console.log(
        `${identityLabel(identity)} isn't tracked in state — nothing to forget.`,
      );
      return;
    }
    await backend.write(state);
    console.log(
      `Forgot ${kind} ${identityLabel(identity)} — ` +
        `the resource is still on the server but no longer tracked here. ` +
        `Remove the corresponding entry from your config file to avoid ` +
        `re-adopting it on next 'cococo apply'.`,
    );
  } finally {
    await release();
  }
}

function parseForgetIdentity(kind: ForgetKind, args: string[]): ResourceIdentity {
  switch (kind) {
    case "user":
      requireArgs(kind, args, 1);
      return { kind: "user", email: args[0]! };
    case "policy":
      requireArgs(kind, args, 1);
      return { kind: "iam_policy", handle: args[0]! };
    case "iam-policy-binding":
      requireArgs(kind, args, 2);
      return { kind: "iam_policy_binding", email: args[0]!, policyHandle: args[1]! };
    case "network":
      requireArgs(kind, args, 1);
      return { kind: "network", name: args[0]! };
    case "device":
      requireArgs(kind, args, 1);
      return { kind: "device", identifier: args[0]! };
    case "team":
      requireArgs(kind, args, 1);
      return { kind: "team", name: args[0]! };
    case "custom-app-user-binding":
      requireArgs(kind, args, 2);
      return { kind: "custom_app_user_binding", email: args[0]!, appHandle: args[1]! };
    case "custom-app-team-binding":
      requireArgs(kind, args, 2);
      return { kind: "custom_app_team_binding", teamName: args[0]!, appHandle: args[1]! };
    case "controller":
      requireArgs(kind, args, 1);
      return { kind: "controller", handle: args[0]! };
    case "controller-token":
      requireArgs(kind, args, 2);
      return { kind: "controller_token", controllerHandle: args[0]!, name: args[1]! };
    case "edge-app-installation":
      requireArgs(kind, args, 2);
      return { kind: "edge_app_installation", controllerHandle: args[0]!, appHandle: args[1]! };
  }
}

function requireArgs(kind: ForgetKind, args: string[], n: number): void {
  if (args.length !== n) {
    throw new Error(
      `cococo state forget ${kind} expects ${n} argument(s); got ${args.length}.`,
    );
  }
}

// ── refresh ───────────────────────────────────────────────────────────

export async function runStateRefresh(overrides: ConfigOverrides): Promise<void> {
  const backend = new LocalFileStateBackend(process.cwd());
  const release = await backend.lock();
  try {
    const state = await backend.read();
    if (!state) {
      throw new Error(
        `No state file at .cococo/state.json — nothing to refresh. ` +
          `Run 'cococo state import' first.`,
      );
    }

    const ops = await loadOps(process.cwd());
    const client = createClient(loadConfig(overrides));
    // fetchLiveSnapshot honours the union of declared + state, but for
    // refresh we want to re-pull every state entry — pass empty ops so
    // we walk strictly from state.
    const live = await fetchLiveSnapshot(
      client,
      { ...ops, users: [], policies: [], policyBindings: [], networks: [], devices: [], teams: [], customAppUserBindings: [], customAppTeamBindings: [], controllers: [], controllerTokens: [], edgeAppInstallations: [] },
      state,
    );

    let refreshed = 0;
    let dropped = 0;
    const newResources = [];
    for (const r of state.resources) {
      const liveSpec = live.get(identityKey(r.identity));
      if (!liveSpec) {
        dropped++;
        console.log(
          `  - ${r.identity.kind.padEnd(28)} ${identityLabel(r.identity)} (gone from server, removing from state)`,
        );
        continue;
      }
      newResources.push({
        identity: r.identity,
        lastAppliedSpec: liveSpec,
        lastAppliedAt: new Date().toISOString(),
      });
      refreshed++;
    }

    const newState: StateFile = {
      schemaVersion: 1,
      lastAppliedAt: new Date().toISOString(),
      resources: newResources,
    };
    await backend.write(newState);

    console.log(
      `Refreshed ${refreshed} resource(s)${dropped > 0 ? `, dropped ${dropped} no longer on the server` : ""}.`,
    );
    console.log(
      `Run 'cococo plan' to see what's now drifted between your declared specs and refreshed state.`,
    );
  } finally {
    await release();
  }
}
