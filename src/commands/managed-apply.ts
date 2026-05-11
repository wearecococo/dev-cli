import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  addTeamMember,
  attachCustomAppTeam,
  attachCustomAppUser,
  attachPolicy,
  createControllerToken,
  createIAMPolicy,
  getControllerByHandle,
  getControllerPolicyByController,
  getCustomAppByHandle,
  getDeviceByIdentifier,
  getIAMPolicy,
  getNetworkByName,
  getTeamByName,
  getTeamMembers,
  getUserByEmail,
  listEdgeAppInstallations,
  removeTeamMember,
  resolveEdgeAppByHandleAndVersion,
  updateIAMPolicy,
  upgradeEdgeAppInstallation,
  upsertController,
  upsertControllerPolicy,
  upsertDevice,
  upsertEdgeAppInstallation,
  upsertNetwork,
  upsertTeam,
  upsertUser,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { loadOps, type LoadedOps } from "../ops.ts";
import {
  controllerHandle,
  iamPolicyHandle,
  networkName,
  teamName,
  userEmail,
  type Controller,
  type ControllerToken,
  type CustomAppTeamBinding,
  type CustomAppUserBinding,
  type Device,
  type EdgeAppInstallation,
  type IAMPolicy,
  type IAMPolicyBinding,
  type Network,
  type Team,
  type User,
} from "../define.ts";
import { LocalFileStateBackend } from "../state/local-backend.ts";
import { fetchLiveSnapshot } from "../state/live-fetch.ts";
import {
  computePlan,
  deleteOpsInExecutionOrder,
  nonDeleteOpsInExecutionOrder,
  type PlanAction,
} from "../state/plan.ts";
import { renderPlan } from "../state/render-plan.ts";
import {
  identityKey,
  identityLabel,
  type ManagedResource,
  type ResourceIdentity,
  type StateFile,
} from "../state/types.ts";
import { managedSpecFromDeclared, type ManagedSpec } from "../state/managed-specs.ts";
import {
  deleteAppTeam,
  deleteAppUser,
  deleteBinding,
  deleteControllerByHandle,
  deleteDeviceByIdentifier,
  deleteNetworkByName,
  deletePolicyByHandle,
  deleteTeamByName,
  deleteUserByEmail,
  revokeTokenByName,
} from "./delete.ts";
import {
  deleteEdgeAppInstallation as deleteInstallationMutation,
} from "../graphql/operations.ts";
import { promptStrictYes, promptYes } from "../prompt.ts";

export type ManagedApplyOptions = {
  yes: boolean;
  allowDestroy: boolean;
};

/**
 * State-tracking apply path. Reaches the server only after the plan
 * is shown and the user has confirmed; deletes require explicit
 * `--allow-destroy` to even reach the prompt.
 */
export async function runManagedApply(
  opts: ManagedApplyOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const cwd = process.cwd();
  const backend = new LocalFileStateBackend(cwd);
  const release = await backend.lock();
  try {
    const state = await backend.read();
    if (!state) {
      console.error(
        `cococo apply: state file missing — managed apply requires .cococo/state.json. ` +
          `Run 'cococo state import' to bootstrap, or delete .cococo/ to fall back to ` +
          `the additive apply.`,
      );
      process.exit(1);
    }

    const ops = await loadOps(cwd);
    const client = createClient(loadConfig(overrides));
    const live = await fetchLiveSnapshot(client, ops, state);
    const plan = computePlan(ops, state, live);

    process.stdout.write(renderPlan(plan, { noColor: !process.stdout.isTTY }));

    const hasDeletes = plan.actions.some((a) => a.op === "delete");
    const hasChanges = plan.actions.some(
      (a) => a.op === "create" || a.op === "update" || a.op === "delete",
    );
    if (!hasChanges) {
      console.log("Already up to date — nothing to apply.");
      return;
    }
    if (hasDeletes && !opts.allowDestroy) {
      const n = plan.actions.filter((a) => a.op === "delete").length;
      console.error(
        `\nPlan includes ${n} deletion(s). Re-run with --allow-destroy ` +
          `to execute them, or remove the deletions from the plan first.`,
      );
      process.exit(1);
    }

    if (!opts.yes) {
      const ok = hasDeletes
        ? await promptStrictYes("\nApply these changes including deletions?")
        : await promptYes("\nApply these changes?");
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    // Execute deletes first (reverse-kind order), then creates/updates.
    // `newResources` accumulates the in-flight state as each action
    // succeeds — so on a mid-apply failure we can persist what *did*
    // land before re-throwing. Without this, a re-apply after a
    // partial failure would re-run already-completed creates and (for
    // controller_token) mint a fresh token on top of one already created.
    const newResources = new Map<string, ManagedResource>();
    for (const r of state.resources) newResources.set(identityKey(r.identity), r);

    const ctx = newExecutionCtx(client, ops);
    let executed = 0;
    const total =
      plan.actions.filter((a) => a.op !== "noop").length;

    try {
      for (const action of deleteOpsInExecutionOrder(plan.actions)) {
        await executeAction(ctx, action);
        newResources.delete(identityKey(action.identity));
        console.log(`  - ${action.identity.kind.padEnd(28)} ${identityLabel(action.identity)}`);
        executed++;
      }

      for (const action of nonDeleteOpsInExecutionOrder(plan.actions)) {
        const result = await executeAction(ctx, action);
        if (result?.spec) {
          newResources.set(identityKey(action.identity), {
            identity: action.identity,
            lastAppliedSpec: result.spec,
            lastAppliedAt: new Date().toISOString(),
          });
        }
        const sym = action.op === "create" ? "+" : "~";
        console.log(`  ${sym} ${action.identity.kind.padEnd(28)} ${identityLabel(action.identity)}`);
        executed++;
      }
    } catch (err) {
      // Persist whatever's been applied so far before re-throwing.
      // The next `cococo apply` will see exactly the operations that
      // didn't complete and retry only those.
      const partial: StateFile = {
        schemaVersion: 1,
        lastAppliedAt: new Date().toISOString(),
        resources: [...newResources.values()],
      };
      try {
        await backend.write(partial);
        console.error(
          `\nApply failed after ${executed} of ${total} operation(s). ` +
            `State has been partially saved to .cococo/state.json. ` +
            `Re-run 'cococo apply' to continue with the remaining operations.`,
        );
      } catch (writeErr) {
        const m = writeErr instanceof Error ? writeErr.message : String(writeErr);
        console.error(
          `\nApply failed after ${executed} of ${total} operation(s), AND the partial-state ` +
            `write also failed (${m}). State on disk is unchanged from before this apply — ` +
            `re-running will retry every operation, including those that succeeded.`,
        );
      }
      throw err;
    }

    const newState: StateFile = {
      schemaVersion: 1,
      lastAppliedAt: new Date().toISOString(),
      resources: [...newResources.values()],
    };
    await backend.write(newState);
    console.log(`\nWrote .cococo/state.json (${newState.resources.length} resource(s)).`);
  } finally {
    await release();
  }
}

// ── execution ─────────────────────────────────────────────────────────

type ExecutionCtx = {
  client: GraphQLClient;
  ops: LoadedOps;
  /** Lookup by natural key for refs that need server IDs at execute time. */
  byEmail: Map<string, string>;
  byPolicy: Map<string, string>;
  byNetwork: Map<string, string>;
  byTeam: Map<string, string>;
  byController: Map<string, string>;
  byApp: Map<string, string>;
};

function newExecutionCtx(client: GraphQLClient, ops: LoadedOps): ExecutionCtx {
  return {
    client,
    ops,
    byEmail: new Map(),
    byPolicy: new Map(),
    byNetwork: new Map(),
    byTeam: new Map(),
    byController: new Map(),
    byApp: new Map(),
  };
}

async function resolveUserId(ctx: ExecutionCtx, email: string): Promise<string> {
  const k = email.toLowerCase();
  const cached = ctx.byEmail.get(k);
  if (cached) return cached;
  const u = await getUserByEmail(ctx.client, email);
  if (!u) throw new Error(`User '${email}' not found on the server.`);
  ctx.byEmail.set(k, u.id);
  return u.id;
}

async function resolvePolicyId(ctx: ExecutionCtx, handle: string): Promise<string> {
  const cached = ctx.byPolicy.get(handle);
  if (cached) return cached;
  const p = await getIAMPolicy(ctx.client, handle);
  if (!p) throw new Error(`Policy '${handle}' not found on the server.`);
  ctx.byPolicy.set(handle, p.id);
  return p.id;
}

async function resolveNetworkId(ctx: ExecutionCtx, name: string): Promise<string> {
  const cached = ctx.byNetwork.get(name);
  if (cached) return cached;
  const n = await getNetworkByName(ctx.client, name);
  if (!n) throw new Error(`Network '${name}' not found on the server.`);
  ctx.byNetwork.set(name, n.id);
  return n.id;
}

async function resolveTeamId(ctx: ExecutionCtx, name: string): Promise<string> {
  const cached = ctx.byTeam.get(name);
  if (cached) return cached;
  const t = await getTeamByName(ctx.client, name);
  if (!t) throw new Error(`Team '${name}' not found on the server.`);
  ctx.byTeam.set(name, t.id);
  return t.id;
}

async function resolveControllerId(ctx: ExecutionCtx, handle: string): Promise<string> {
  const cached = ctx.byController.get(handle);
  if (cached) return cached;
  const c = await getControllerByHandle(ctx.client, handle);
  if (!c) throw new Error(`Controller '${handle}' not found on the server.`);
  ctx.byController.set(handle, c.id);
  return c.id;
}

async function resolveAppId(ctx: ExecutionCtx, handle: string): Promise<string> {
  const cached = ctx.byApp.get(handle);
  if (cached) return cached;
  const a = await getCustomAppByHandle(ctx.client, handle);
  if (!a) {
    throw new Error(
      `Custom app '${handle}' not found on the server — push it first with 'cococo push ${handle}'.`,
    );
  }
  ctx.byApp.set(handle, a.id);
  return a.id;
}

/**
 * Execute a single plan action. Returns the new managed spec to
 * record in state (for create/update) or null (for delete/noop).
 */
async function executeAction(
  ctx: ExecutionCtx,
  action: PlanAction,
): Promise<{ spec: ManagedSpec } | null> {
  if (action.op === "noop") return null;
  if (action.op === "delete") {
    await executeDelete(ctx.client, action.identity);
    return null;
  }

  const declared = lookupDeclared(ctx.ops, action.identity);
  if (!declared) {
    throw new Error(
      `Internal error: plan action ${action.op} for ${identityLabel(action.identity)} has no matching declared spec.`,
    );
  }
  return await executeUpsert(ctx, action.identity, declared);
}

/**
 * Find the declared spec object for an identity within the loaded ops.
 * Returns the original author-side object so the upsert call has every
 * field (write-only secrets included) — only `state.json` strips them.
 */
function lookupDeclared(
  ops: LoadedOps,
  identity: ResourceIdentity,
): unknown {
  switch (identity.kind) {
    case "iam_policy":
      return ops.policies.find((p) => p.handle === identity.handle);
    case "user":
      return ops.users.find((u) => u.email.toLowerCase() === identity.email.toLowerCase());
    case "iam_policy_binding":
      return ops.policyBindings.find(
        (b) =>
          userEmail(b.user).toLowerCase() === identity.email.toLowerCase() &&
          iamPolicyHandle(b.policy) === identity.policyHandle,
      );
    case "network":
      return ops.networks.find((n) => n.name === identity.name);
    case "device":
      return ops.devices.find((d) => d.identifier === identity.identifier);
    case "team":
      return ops.teams.find((t) => t.name === identity.name);
    case "custom_app_user_binding":
      return ops.customAppUserBindings.find(
        (b) =>
          userEmail(b.user).toLowerCase() === identity.email.toLowerCase() &&
          b.app === identity.appHandle,
      );
    case "custom_app_team_binding":
      return ops.customAppTeamBindings.find(
        (b) => teamName(b.team) === identity.teamName && b.app === identity.appHandle,
      );
    case "controller":
      return ops.controllers.find((c) => c.handle === identity.handle);
    case "controller_token":
      return ops.controllerTokens.find(
        (t) =>
          controllerHandle(t.controller) === identity.controllerHandle &&
          t.name === identity.name,
      );
    case "edge_app_installation":
      return ops.edgeAppInstallations.find(
        (i) =>
          controllerHandle(i.controller) === identity.controllerHandle &&
          i.app === identity.appHandle,
      );
  }
}

async function executeUpsert(
  ctx: ExecutionCtx,
  identity: ResourceIdentity,
  declared: unknown,
): Promise<{ spec: ManagedSpec }> {
  switch (identity.kind) {
    case "iam_policy": {
      const p = declared as IAMPolicy;
      const document = {
        version: "2012-10-17",
        statements: p.statements.map((s) => ({
          effect: s.effect,
          actions: s.actions,
          resources: s.resources,
        })),
      };
      const existing = await getIAMPolicy(ctx.client, p.handle);
      const result = existing
        ? await updateIAMPolicy(ctx.client, {
            id: p.handle,
            name: p.name,
            description: p.description,
            document,
          })
        : await createIAMPolicy(ctx.client, {
            id: p.handle,
            name: p.name,
            description: p.description,
            document,
          });
      ctx.byPolicy.set(p.handle, result.id);
      return { spec: managedSpecFromDeclared("iam_policy", p) };
    }
    case "user": {
      const u = declared as User;
      const existing = await getUserByEmail(ctx.client, u.email);
      const result = await upsertUser(ctx.client, {
        id: existing?.id,
        email: u.email,
        name: u.name,
        kind: u.kind,
        externalId: u.externalId,
      });
      ctx.byEmail.set(u.email.toLowerCase(), result.id);
      return { spec: managedSpecFromDeclared("user", u) };
    }
    case "iam_policy_binding": {
      const b = declared as IAMPolicyBinding;
      const userId = await resolveUserId(ctx, userEmail(b.user));
      const policyId = await resolvePolicyId(ctx, iamPolicyHandle(b.policy));
      await attachPolicy(ctx.client, { userId, policyId });
      return { spec: managedSpecFromDeclared("iam_policy_binding", b) };
    }
    case "network": {
      const n = declared as Network;
      const existing = await getNetworkByName(ctx.client, n.name);
      const result = await upsertNetwork(ctx.client, {
        id: existing?.id,
        name: n.name,
        description: n.description,
      });
      ctx.byNetwork.set(n.name, result.id);
      return { spec: managedSpecFromDeclared("network", n) };
    }
    case "device": {
      const d = declared as Device;
      const networkId = d.network !== undefined ? await resolveNetworkId(ctx, networkName(d.network)) : undefined;
      const existing = await getDeviceByIdentifier(ctx.client, d.identifier);
      await upsertDevice(ctx.client, {
        id: existing?.id,
        identifier: d.identifier,
        networkId,
        name: d.name,
        description: d.description,
        deviceType: d.deviceType,
        manufacturer: d.manufacturer,
        model: d.model,
        serialNumber: d.serialNumber,
        isActive: d.isActive,
        // Hand the protocol configs to the same wire-mapping path the
        // additive apply uses, except keep secrets on the wire (they
        // shipped in declared) — they're stripped only at the state
        // serialisation step.
        outboundProtocols: d.outboundProtocols as never,
        inboundProtocols: d.inboundProtocols as never,
      });
      return { spec: managedSpecFromDeclared("device", d) };
    }
    case "team": {
      const t = declared as Team;
      const existing = await getTeamByName(ctx.client, t.name);
      const team = await upsertTeam(ctx.client, {
        id: existing?.id,
        name: t.name,
        description: t.description,
      });
      ctx.byTeam.set(t.name, team.id);

      if (t.members !== undefined) {
        const declaredIds = new Map<string, string>();
        for (const ref of t.members) {
          const email = userEmail(ref);
          if (declaredIds.has(email)) continue;
          declaredIds.set(email, await resolveUserId(ctx, email));
        }
        const current = await getTeamMembers(ctx.client, team.id);
        const currentIds = new Set(current.map((m) => m.id));
        const declaredIdSet = new Set(declaredIds.values());
        for (const [, userId] of declaredIds) {
          if (currentIds.has(userId)) continue;
          await addTeamMember(ctx.client, { teamId: team.id, userId });
        }
        for (const m of current) {
          if (declaredIdSet.has(m.id)) continue;
          await removeTeamMember(ctx.client, { teamId: team.id, userId: m.id });
        }
      }
      return { spec: managedSpecFromDeclared("team", t) };
    }
    case "custom_app_user_binding": {
      const r = declared as CustomAppUserBinding;
      const userId = await resolveUserId(ctx, userEmail(r.user));
      const customAppId = await resolveAppId(ctx, r.app);
      await attachCustomAppUser(ctx.client, { customAppId, userId });
      return { spec: managedSpecFromDeclared("custom_app_user_binding", r) };
    }
    case "custom_app_team_binding": {
      const r = declared as CustomAppTeamBinding;
      const teamId = await resolveTeamId(ctx, teamName(r.team));
      const customAppId = await resolveAppId(ctx, r.app);
      await attachCustomAppTeam(ctx.client, { customAppId, teamId });
      return { spec: managedSpecFromDeclared("custom_app_team_binding", r) };
    }
    case "controller": {
      const c = declared as Controller;
      const networkId = c.network !== undefined ? await resolveNetworkId(ctx, networkName(c.network)) : undefined;
      const existing = await getControllerByHandle(ctx.client, c.handle);
      const result = await upsertController(ctx.client, {
        id: existing?.id,
        handle: c.handle,
        networkId,
        name: c.name,
        description: c.description,
        host: c.host,
        port: c.port,
        isActive: c.isActive,
        jmfConfig: c.jmfConfig,
      });
      ctx.byController.set(c.handle, result.id);
      if (c.policy !== undefined) {
        const existingPolicy = await getControllerPolicyByController(ctx.client, result.id);
        const same =
          existingPolicy &&
          equalUnordered(existingPolicy.allowedIoPaths, c.policy.allowedIoPaths) &&
          equalUnordered(existingPolicy.allowedExecBinaries, c.policy.allowedExecBinaries);
        if (!same) {
          await upsertControllerPolicy(ctx.client, {
            controllerId: result.id,
            allowedIoPaths: c.policy.allowedIoPaths,
            allowedExecBinaries: c.policy.allowedExecBinaries,
          });
        }
      }
      return { spec: managedSpecFromDeclared("controller", c) };
    }
    case "controller_token": {
      const t = declared as ControllerToken;
      const ctrlId = await resolveControllerId(ctx, controllerHandle(t.controller));
      // Tokens are create-only: re-applying a declared token that already
      // exists is a no-op. Updates to expiresAt or description don't propagate.
      const created = await createControllerToken(ctx.client, {
        controllerId: ctrlId,
        name: t.name,
        description: t.description,
        expiresAt: t.expiresAt,
      });
      console.log(`    Connect bundle for ${controllerHandle(t.controller)}/${t.name} (save it — never shown again):`);
      console.log(`    ${created.connectBundle}`);
      return { spec: managedSpecFromDeclared("controller_token", t) };
    }
    case "edge_app_installation": {
      const i = declared as EdgeAppInstallation;
      const controllerId = await resolveControllerId(ctx, controllerHandle(i.controller));
      const edgeApp = await resolveEdgeAppByHandleAndVersion(ctx.client, i.app, i.version);
      if (!edgeApp) {
        throw new Error(`Edge app '${i.app}' v${i.version} not found on the server.`);
      }
      if (edgeApp.status === "DRAFT") {
        throw new Error(
          `Edge app '${i.app}' v${i.version} is DRAFT — installations must pin a published version.`,
        );
      }
      let botUserId: string | undefined;
      if (i.botUser !== undefined) {
        botUserId = await resolveUserId(ctx, userEmail(i.botUser));
      }
      const exact = await listEdgeAppInstallations(ctx.client, {
        controllerId,
        edgeAppId: edgeApp.id,
      });
      if (exact.length > 0) {
        await upsertEdgeAppInstallation(ctx.client, {
          id: exact[0]!.id,
          edgeAppId: edgeApp.id,
          controllerId,
          botUserId,
          isActive: i.isActive,
          variables: i.variables,
        });
      } else {
        const onController = await listEdgeAppInstallations(ctx.client, { controllerId });
        const sameHandle = onController.find((inst) => inst.edgeApp?.handle === i.app);
        if (sameHandle) {
          await upgradeEdgeAppInstallation(ctx.client, {
            id: sameHandle.id,
            toEdgeAppId: edgeApp.id,
          });
          await upsertEdgeAppInstallation(ctx.client, {
            id: sameHandle.id,
            edgeAppId: edgeApp.id,
            controllerId,
            botUserId,
            isActive: i.isActive,
            variables: i.variables,
          });
        } else {
          await upsertEdgeAppInstallation(ctx.client, {
            edgeAppId: edgeApp.id,
            controllerId,
            botUserId,
            isActive: i.isActive,
            variables: i.variables,
          });
        }
      }
      return { spec: managedSpecFromDeclared("edge_app_installation", i) };
    }
  }
}

async function executeDelete(
  client: GraphQLClient,
  identity: ResourceIdentity,
): Promise<void> {
  switch (identity.kind) {
    case "user":
      await deleteUserByEmail(client, identity.email);
      return;
    case "iam_policy":
      await deletePolicyByHandle(client, identity.handle);
      return;
    case "iam_policy_binding":
      await deleteBinding(client, identity.email, identity.policyHandle);
      return;
    case "network":
      await deleteNetworkByName(client, identity.name);
      return;
    case "device":
      await deleteDeviceByIdentifier(client, identity.identifier);
      return;
    case "team":
      await deleteTeamByName(client, identity.name);
      return;
    case "custom_app_user_binding":
      await deleteAppUser(client, identity.email, identity.appHandle);
      return;
    case "custom_app_team_binding":
      await deleteAppTeam(client, identity.teamName, identity.appHandle);
      return;
    case "controller":
      await deleteControllerByHandle(client, identity.handle);
      return;
    case "controller_token":
      await revokeTokenByName(client, identity.controllerHandle, identity.name);
      return;
    case "edge_app_installation": {
      const c = await getControllerByHandle(client, identity.controllerHandle);
      if (!c) return;
      // The installation may be at any version — find the one matching
      // the app handle (regardless of version) and delete it.
      const installs = await listEdgeAppInstallations(client, { controllerId: c.id });
      const match = installs.find((i) => i.edgeApp?.handle === identity.appHandle);
      if (!match) return;
      await deleteInstallationMutation(client, match.id);
      return;
    }
  }
}

function equalUnordered(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const x of a) if (!setB.has(x)) return false;
  return true;
}
