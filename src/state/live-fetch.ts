/**
 * Build a "live snapshot" of the resources we care about for plan
 * computation. Keyed by `identityKey` so plan can compare against
 * declared specs and last-applied state without server round-trips
 * during the diff itself.
 *
 * To bound the number of API calls, we fetch only kinds that appear
 * in declared OR state — there's no point asking "what users exist?"
 * on a workspace that doesn't manage any users.
 */

import type { GraphQLClient } from "../graphql/client.ts";
import {
  getControllerByHandle,
  getControllerPolicyByController,
  getCustomAppByHandle,
  getDeviceByIdentifier,
  getIAMPolicy,
  getIntegrationInstanceByName,
  getNetworkByName,
  getTeamByName,
  getTeamMembers,
  getUserByEmail,
  listControllerTokens,
  listCustomAppTeams,
  listCustomAppUsers,
  listEdgeAppInstallations,
  listNetworks,
  listUserPolicies,
  listUsers,
} from "../graphql/operations.ts";
import type { LoadedOps } from "../ops.ts";
import {
  controllerHandle,
  iamPolicyHandle,
  teamName,
  userEmail,
} from "../define.ts";
import {
  identityKey,
  type ResourceIdentity,
  type ResourceKind,
  type StateFile,
} from "./types.ts";
import { managedSpecFromLive, type ManagedSpec } from "./managed-specs.ts";

export type LiveSnapshot = Map<string, ManagedSpec>;

/**
 * Lookup caches used to translate server-side IDs back into the
 * natural keys the declared spec uses (network id → name, user id →
 * email). Built lazily — fetched on first access by a kind that
 * needs them.
 */
type ResolverCtx = {
  networkNameById: () => Promise<Map<string, string>>;
  userEmailById: () => Promise<Map<string, string>>;
};

function createResolverCtx(client: GraphQLClient): ResolverCtx {
  let networkPromise: Promise<Map<string, string>> | undefined;
  let userPromise: Promise<Map<string, string>> | undefined;
  return {
    networkNameById: () => {
      if (!networkPromise) {
        networkPromise = listNetworks(client).then(
          (rows) => new Map(rows.map((n) => [n.id, n.name])),
        );
      }
      return networkPromise;
    },
    userEmailById: () => {
      if (!userPromise) {
        userPromise = listUsers(client).then(
          (rows) => new Map(rows.map((u) => [u.id, u.email])),
        );
      }
      return userPromise;
    },
  };
}

export async function fetchLiveSnapshot(
  client: GraphQLClient,
  declared: LoadedOps,
  state: StateFile | null,
): Promise<LiveSnapshot> {
  const out: LiveSnapshot = new Map();
  const ctx = createResolverCtx(client);

  // Collect every identity we need to look up — declared + state
  // gives the union of "things this workspace cares about." Dedup by
  // identityKey.
  const identities = collectIdentities(declared, state);

  // Per-kind fetch. Each branch handles "doesn't exist on server" by
  // simply not adding to the snapshot — plan treats absence as "needs
  // create".
  for (const id of identities) {
    const spec = await fetchOne(client, id, ctx);
    if (spec) out.set(identityKey(id), spec);
  }
  return out;
}

async function fetchOne(
  client: GraphQLClient,
  id: ResourceIdentity,
  ctx: ResolverCtx,
): Promise<ManagedSpec | null> {
  switch (id.kind) {
    case "user": {
      const u = await getUserByEmail(client, id.email);
      if (!u) return null;
      return managedSpecFromLive("user", {
        email: u.email,
        name: u.name,
        kind: u.kind,
        externalId: u.externalId,
      });
    }
    case "iam_policy": {
      const p = await getIAMPolicy(client, id.handle);
      if (!p) return null;
      return managedSpecFromLive("iam_policy", {
        // Policy `id` is the handle by convention.
        handle: p.id,
        name: p.name,
        description: p.description,
        document: p.document,
      });
    }
    case "iam_policy_binding": {
      // No single "get binding" query — list policies attached to the
      // user and check for the policy handle. listUserPolicies returns
      // IAMPolicyState shapes whose `id` is the policy handle.
      const u = await getUserByEmail(client, id.email);
      if (!u) return null;
      const policies = await listUserPolicies(client, u.id);
      const match = policies.find((p) => p.id === id.policyHandle);
      if (!match) return null;
      return managedSpecFromLive("iam_policy_binding", {
        userEmail: id.email,
        policyHandle: id.policyHandle,
      });
    }
    case "network": {
      const n = await getNetworkByName(client, id.name);
      if (!n) return null;
      return managedSpecFromLive("network", {
        name: n.name,
        description: n.description,
      });
    }
    case "device": {
      const d = await getDeviceByIdentifier(client, id.identifier);
      if (!d) return null;
      const network = d.networkId
        ? { name: (await ctx.networkNameById()).get(d.networkId) ?? "" }
        : null;
      return managedSpecFromLive("device", {
        identifier: d.identifier,
        name: d.name,
        description: d.description,
        deviceType: d.deviceType,
        manufacturer: d.manufacturer,
        model: d.model,
        serialNumber: d.serialNumber,
        isActive: d.isActive,
        network,
        outboundProtocols: d.outboundProtocols,
        inboundProtocols: d.inboundProtocols,
      });
    }
    case "team": {
      const t = await getTeamByName(client, id.name);
      if (!t) return null;
      const members = await getTeamMembers(client, t.id);
      return managedSpecFromLive("team", {
        name: t.name,
        description: t.description,
        members: members.map((m) => ({ email: m.email })),
      });
    }
    case "custom_app_user_binding": {
      // Resolve user + app first, then check the bindings list for the app.
      const [u, app] = await Promise.all([
        getUserByEmail(client, id.email),
        getCustomAppByHandle(client, id.appHandle),
      ]);
      if (!u || !app) return null;
      const bindings = await listCustomAppUsers(client, { customAppId: app.id });
      const match = bindings.find((b) => b.userId === u.id);
      if (!match) return null;
      return managedSpecFromLive("custom_app_user_binding", {
        userEmail: id.email,
        appHandle: id.appHandle,
      });
    }
    case "custom_app_team_binding": {
      const [t, app] = await Promise.all([
        getTeamByName(client, id.teamName),
        getCustomAppByHandle(client, id.appHandle),
      ]);
      if (!t || !app) return null;
      const bindings = await listCustomAppTeams(client, { customAppId: app.id });
      const match = bindings.find((b) => b.teamId === t.id);
      if (!match) return null;
      return managedSpecFromLive("custom_app_team_binding", {
        teamName: id.teamName,
        appHandle: id.appHandle,
      });
    }
    case "controller": {
      const c = await getControllerByHandle(client, id.handle);
      if (!c) return null;
      const policy = await getControllerPolicyByController(client, c.id);
      const network = c.networkId
        ? { name: (await ctx.networkNameById()).get(c.networkId) ?? "" }
        : null;
      return managedSpecFromLive("controller", {
        handle: c.handle,
        name: c.name,
        description: c.description,
        host: c.host,
        port: c.port,
        isActive: c.isActive,
        network,
        jmfConfig: c.jmfConfig,
        policy: policy
          ? {
              allowedIoPaths: policy.allowedIoPaths,
              allowedExecBinaries: policy.allowedExecBinaries,
            }
          : null,
      });
    }
    case "controller_token": {
      const c = await getControllerByHandle(client, id.controllerHandle);
      if (!c) return null;
      const matches = await listControllerTokens(client, {
        controllerId: c.id,
        name: id.name,
        isRevoked: false,
      });
      const tok = matches[0];
      if (!tok) return null;
      return managedSpecFromLive("controller_token", {
        controllerHandle: id.controllerHandle,
        name: tok.name,
        description: tok.description,
        expiresAt: tok.expiresAt,
      });
    }
    case "edge_app_installation": {
      const c = await getControllerByHandle(client, id.controllerHandle);
      if (!c) return null;
      const installs = await listEdgeAppInstallations(client, {
        controllerId: c.id,
      });
      const match = installs.find((i) => i.edgeApp?.handle === id.appHandle);
      if (!match || !match.edgeApp) return null;
      const botUserEmail = match.botUserId
        ? (await ctx.userEmailById()).get(match.botUserId) ?? null
        : null;
      return managedSpecFromLive("edge_app_installation", {
        controllerHandle: id.controllerHandle,
        appHandle: id.appHandle,
        version: match.edgeApp.version,
        isActive: match.isActive,
        botUserEmail,
        variables: match.variables,
      });
    }
    case "integration_installation": {
      const inst = await getIntegrationInstanceByName(client, id.integration, id.name);
      if (!inst) return null;
      const botUserEmail = inst.botUserId
        ? (await ctx.userEmailById()).get(inst.botUserId) ?? null
        : null;
      // config + bindings come back as JSON strings; parse for diffing.
      const parseMaybe = (s: string | null | undefined): Record<string, unknown> | null => {
        if (!s) return null;
        try {
          return JSON.parse(s) as Record<string, unknown>;
        } catch {
          return null;
        }
      };
      return managedSpecFromLive("integration_installation", {
        integrationId: inst.integrationId,
        name: inst.name,
        description: inst.description,
        version: inst.version,
        status: inst.status,
        botUserEmail,
        config: parseMaybe(inst.config),
        bindings: parseMaybe(inst.bindings) as Record<string, string> | null,
      });
    }
  }
}

function collectIdentities(
  declared: LoadedOps,
  state: StateFile | null,
): ResourceIdentity[] {
  const seen = new Map<string, ResourceIdentity>();
  const add = (id: ResourceIdentity) => {
    const k = identityKey(id);
    if (!seen.has(k)) seen.set(k, id);
  };

  for (const p of declared.policies) add({ kind: "iam_policy", handle: p.handle });
  for (const u of declared.users) add({ kind: "user", email: u.email });
  for (const b of declared.policyBindings) {
    add({
      kind: "iam_policy_binding",
      email: userEmail(b.user),
      policyHandle: iamPolicyHandle(b.policy),
    });
  }
  for (const n of declared.networks) add({ kind: "network", name: n.name });
  for (const d of declared.devices) add({ kind: "device", identifier: d.identifier });
  for (const t of declared.teams) add({ kind: "team", name: t.name });
  for (const r of declared.customAppUserBindings) {
    add({
      kind: "custom_app_user_binding",
      email: userEmail(r.user),
      appHandle: r.app,
    });
  }
  for (const r of declared.customAppTeamBindings) {
    add({
      kind: "custom_app_team_binding",
      teamName: teamName(r.team),
      appHandle: r.app,
    });
  }
  for (const c of declared.controllers) add({ kind: "controller", handle: c.handle });
  for (const t of declared.controllerTokens) {
    add({
      kind: "controller_token",
      controllerHandle: controllerHandle(t.controller),
      name: t.name,
    });
  }
  for (const i of declared.edgeAppInstallations) {
    add({
      kind: "edge_app_installation",
      controllerHandle: controllerHandle(i.controller),
      appHandle: i.app,
    });
  }
  for (const i of declared.integrationInstallations) {
    add({
      kind: "integration_installation",
      integration: i.integration,
      name: i.name,
    });
  }

  if (state) {
    for (const r of state.resources) add(r.identity);
  }

  return [...seen.values()];
}

/**
 * Re-export so callers can import the type from one module.
 */
export type { ResourceKind };
