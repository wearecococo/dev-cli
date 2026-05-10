import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  addTeamMember,
  attachCustomAppTeam,
  attachCustomAppUser,
  attachPolicy,
  createIAMPolicy,
  getCustomAppByHandle,
  getDeviceByIdentifier,
  getIAMPolicy,
  getNetworkByName,
  getTeamByName,
  getTeamMembers,
  getUserByEmail,
  listCustomAppTeams,
  listCustomAppUsers,
  listUserPolicies,
  removeTeamMember,
  updateIAMPolicy,
  upsertDevice,
  upsertNetwork,
  upsertTeam,
  upsertUser,
  type IAMDocument,
  type IAMPolicyState,
  type InboundProtocolConfig,
  type NetworkState,
  type OutboundProtocolConfig,
  type TeamState,
  type UserState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { loadOps, type LoadedOps } from "../ops.ts";
import type {
  Binding,
  CustomAppTeam,
  CustomAppUser,
  Device,
  IAMPolicy,
  InboundProtocol,
  Network,
  OutboundProtocol,
  Team,
  User,
} from "../define.ts";

/**
 * Apply tenant-config "ops" files (users.ts / iam_policies.ts /
 * bindings.ts) to the platform. Additive only — never deletes anything
 * not declared locally; use `cococo delete user|policy|binding` for
 * removals.
 *
 * Order is deliberate:
 *  1. Policies (so we have IDs ready for bindings)
 *  2. Users   (so we have IDs ready for bindings)
 *  3. Bindings (depend on the first two being in place)
 */
export async function runApply(overrides: ConfigOverrides): Promise<void> {
  const ops = await loadOps(process.cwd());
  if (Object.values(ops.files).every((v) => v === undefined)) {
    console.log(
      `No ops files found in ${process.cwd()}. Expected one of: ` +
        `users.ts, iam_policies.ts, bindings.ts, networks.ts, devices.ts, ` +
        `teams.ts, custom_app_users.ts, custom_app_teams.ts.`,
    );
    return;
  }

  const client = createClient(loadConfig(overrides));
  const policiesById = await applyPolicies(client, ops.policies);
  const usersByEmail = await applyUsers(client, ops.users);
  await applyBindings(client, ops.bindings, usersByEmail, policiesById, ops);
  const networksByName = await applyNetworks(client, ops.networks);
  await applyDevices(client, ops.devices, networksByName, ops);
  const teamsByName = await applyTeams(client, ops.teams, usersByEmail, ops);
  await applyCustomAppUsers(client, ops.customAppUsers, usersByEmail, ops);
  await applyCustomAppTeams(client, ops.customAppTeams, teamsByName, ops);

  reportSummary(ops);
}

async function applyPolicies(
  client: GraphQLClient,
  policies: IAMPolicy[],
): Promise<Map<string, IAMPolicyState>> {
  const out = new Map<string, IAMPolicyState>();
  for (const p of policies) {
    const document: IAMDocument = {
      version: "2012-10-17",
      statements: p.statements.map((s) => ({
        effect: s.effect,
        actions: s.actions,
        resources: s.resources,
      })),
    };
    const existing = await getIAMPolicy(client, p.handle);
    let result: IAMPolicyState;
    if (existing) {
      result = await updateIAMPolicy(client, {
        id: p.handle,
        name: p.name,
        description: p.description,
        document,
      });
      console.log(`  policy ~ ${p.handle} (${p.name})`);
    } else {
      result = await createIAMPolicy(client, {
        id: p.handle,
        name: p.name,
        description: p.description,
        document,
      });
      console.log(`  policy + ${p.handle} (${p.name})`);
    }
    out.set(p.handle, result);
  }
  return out;
}

async function applyUsers(
  client: GraphQLClient,
  users: User[],
): Promise<Map<string, UserState>> {
  const out = new Map<string, UserState>();
  for (const u of users) {
    const existing = await getUserByEmail(client, u.email);
    const result = await upsertUser(client, {
      id: existing?.id,
      email: u.email,
      name: u.name,
      kind: u.kind,
      externalId: u.externalId,
    });
    console.log(`  user ${existing ? "~" : "+"} ${u.email}${u.name ? ` (${u.name})` : ""}`);
    out.set(u.email, result);
  }
  return out;
}

/**
 * Apply user → policy attachments. We resolve each user/policy ref by
 * preferring the locally-declared map (seeded by the previous two
 * passes) and falling back to a server lookup — that way you can
 * declare a binding for a pre-existing user without re-declaring the
 * user itself.
 *
 * Additive: if a user already has a policy attached on the server but
 * it isn't in `bindings.ts`, we leave it. Use `cococo delete binding`
 * to detach.
 */
async function applyBindings(
  client: GraphQLClient,
  bindings: Binding[],
  usersByEmail: Map<string, UserState>,
  policiesByHandle: Map<string, IAMPolicyState>,
  ops: LoadedOps,
): Promise<void> {
  if (bindings.length === 0) return;

  const userId = await resolverFor(
    bindings.map((b) => b.user),
    usersByEmail,
    async (email) => (await getUserByEmail(client, email))?.id,
    "user",
    ops.files.users,
  );
  const policyId = await resolverFor(
    bindings.map((b) => b.policy),
    new Map([...policiesByHandle].map(([h, p]) => [h, p.id])),
    async (handle) => (await getIAMPolicy(client, handle))?.id,
    "policy",
    ops.files.policies,
  );

  // Cache the current attachments per user so we don't issue redundant
  // attachPolicy calls when reapplying the same bindings.ts.
  const existingByUser = new Map<string, Set<string>>();
  for (const b of bindings) {
    const uid = userId.get(b.user)!;
    const pid = policyId.get(b.policy)!;
    let current = existingByUser.get(uid);
    if (!current) {
      const policies = await listUserPolicies(client, uid);
      current = new Set(policies.map((p) => p.id));
      existingByUser.set(uid, current);
    }
    if (current.has(pid)) {
      console.log(`  binding = ${b.user} → ${b.policy}`);
      continue;
    }
    await attachPolicy(client, { userId: uid, policyId: pid });
    current.add(pid);
    console.log(`  binding + ${b.user} → ${b.policy}`);
  }
}

/**
 * Build a key → server-id map for binding refs. For each unique key we
 * either pull the id from the local map (cheap) or fall back to a
 * server lookup (one round-trip per missing key). Refs that resolve
 * neither way fail loudly — the caller almost certainly typo'd a key
 * or forgot to declare the entity.
 */
async function resolverFor<T>(
  keys: string[],
  local: Map<string, T>,
  remote: (key: string) => Promise<string | undefined>,
  label: string,
  source: string | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const key of new Set(keys)) {
    const localHit = local.get(key);
    if (localHit !== undefined) {
      out.set(key, typeof localHit === "string" ? localHit : (localHit as { id: string }).id);
      continue;
    }
    const remoteHit = await remote(key);
    if (remoteHit !== undefined) {
      out.set(key, remoteHit);
      continue;
    }
    const declaredHint = source ? ` declared in ${source}` : "";
    throw new Error(
      `Binding references ${label} '${key}' that doesn't exist locally${declaredHint} or on the server.`,
    );
  }
  return out;
}

async function applyNetworks(
  client: GraphQLClient,
  networks: Network[],
): Promise<Map<string, NetworkState>> {
  const out = new Map<string, NetworkState>();
  for (const n of networks) {
    const existing = await getNetworkByName(client, n.name);
    const result = await upsertNetwork(client, {
      id: existing?.id,
      name: n.name,
      description: n.description,
    });
    console.log(`  network ${existing ? "~" : "+"} ${n.name}`);
    out.set(n.name, result);
  }
  return out;
}

/**
 * Apply devices. `network` is a name reference resolved either against
 * the locally-declared networks (just upserted) or via a server lookup.
 * Refs that don't resolve fail loudly — same belt-and-braces check the
 * binding pass uses.
 */
async function applyDevices(
  client: GraphQLClient,
  devices: Device[],
  networksByName: Map<string, NetworkState>,
  ops: LoadedOps,
): Promise<void> {
  for (const d of devices) {
    let networkId: string | undefined;
    if (d.network !== undefined) {
      const local = networksByName.get(d.network);
      if (local) {
        networkId = local.id;
      } else {
        const remote = await getNetworkByName(client, d.network);
        if (!remote) {
          throw new Error(
            `Device '${d.identifier}' references network '${d.network}' that doesn't exist ` +
              `locally${ops.files.networks ? ` in ${ops.files.networks}` : ""} or on the server.`,
          );
        }
        networkId = remote.id;
      }
    }

    const existing = await getDeviceByIdentifier(client, d.identifier);
    await upsertDevice(client, {
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
      outboundProtocols: d.outboundProtocols?.map(toOutboundWire),
      inboundProtocols: d.inboundProtocols?.map(toInboundWire),
    });
    const netNote = d.network ? ` → ${d.network}` : "";
    console.log(`  device ${existing ? "~" : "+"} ${d.identifier}${netNote}`);
  }
}

/**
 * Flatten a discriminated outbound-protocol spec into the wire shape.
 * The wire type has every per-kind field as optional; the author API
 * has them required-when-applicable. We rely on the discriminator to
 * pick the right fields rather than emitting nulls for non-applicable
 * ones — the server treats absent and null-valued fields the same.
 */
function toOutboundWire(p: OutboundProtocol): OutboundProtocolConfig {
  if (p.kind === "HTTP") {
    return {
      kind: "HTTP",
      label: p.label,
      url: p.url,
      authMode: p.authMode,
      username: p.username,
      password: p.password,
    };
  }
  if (p.kind === "JMF") {
    return { kind: "JMF", label: p.label, url: p.url };
  }
  if (p.kind === "MQTT") {
    return {
      kind: "MQTT",
      label: p.label,
      url: p.url,
      topic: p.topic,
      authMode: p.authMode,
      username: p.username,
      password: p.password,
    };
  }
  return {
    kind: "SQL",
    label: p.label,
    adapter: p.adapter,
    url: p.url,
    host: p.host,
    port: p.port,
    databaseName: p.databaseName,
    username: p.username,
    password: p.password,
    connectionString: p.connectionString,
  };
}

function toInboundWire(p: InboundProtocol): InboundProtocolConfig {
  if (p.kind === "MQTT") {
    return { kind: "MQTT", label: p.label, topic: p.topic };
  }
  return { kind: "HTTP", label: p.label, webhookPath: p.webhookPath };
}

/**
 * Apply teams + their member lists. The team row itself is additive
 * (declared teams get upserted, undeclared ones are left alone). The
 * inline `members: [email]` list, however, is the *canonical* set for
 * that team — applied as a reconcile: declared members get added,
 * server-side members not in the list get removed. Undeclared teams
 * are not touched.
 *
 * Member emails resolve in the same belt-and-braces order as policy
 * bindings: locally declared users first (from `applyUsers`), then a
 * server lookup. Refs that resolve neither way fail loudly.
 */
async function applyTeams(
  client: GraphQLClient,
  teams: Team[],
  usersByEmail: Map<string, UserState>,
  ops: LoadedOps,
): Promise<Map<string, TeamState>> {
  const out = new Map<string, TeamState>();
  for (const t of teams) {
    const existing = await getTeamByName(client, t.name);
    const team = await upsertTeam(client, {
      id: existing?.id,
      name: t.name,
      description: t.description,
    });
    console.log(`  team ${existing ? "~" : "+"} ${t.name}`);
    out.set(t.name, team);

    if (t.members === undefined) continue;
    await reconcileTeamMembers(client, team, t.members, usersByEmail, ops);
  }
  return out;
}

async function reconcileTeamMembers(
  client: GraphQLClient,
  team: TeamState,
  declared: string[],
  usersByEmail: Map<string, UserState>,
  ops: LoadedOps,
): Promise<void> {
  const declaredIds = new Map<string, string>();
  for (const email of new Set(declared)) {
    const local = usersByEmail.get(email);
    if (local) {
      declaredIds.set(email, local.id);
      continue;
    }
    const remote = await getUserByEmail(client, email);
    if (!remote) {
      const hint = ops.files.teams ? ` declared in ${ops.files.teams}` : "";
      throw new Error(
        `Team '${team.name}' member '${email}' doesn't exist${hint} or on the server.`,
      );
    }
    declaredIds.set(email, remote.id);
  }

  const current = await getTeamMembers(client, team.id);
  const currentIds = new Set(current.map((m) => m.id));
  const declaredIdSet = new Set(declaredIds.values());

  for (const [email, userId] of declaredIds) {
    if (currentIds.has(userId)) continue;
    await addTeamMember(client, { teamId: team.id, userId });
    console.log(`    member + ${email}`);
  }
  for (const m of current) {
    if (declaredIdSet.has(m.id)) continue;
    await removeTeamMember(client, { teamId: team.id, userId: m.id });
    console.log(`    member - ${m.email}`);
  }
}

/**
 * Apply user → custom-app bindings. Additive — declared rows get
 * attached if missing, others are left alone. Use
 * `cococo delete custom-app-user <email> <app-handle>` to detach.
 */
async function applyCustomAppUsers(
  client: GraphQLClient,
  rows: CustomAppUser[],
  usersByEmail: Map<string, UserState>,
  ops: LoadedOps,
): Promise<void> {
  if (rows.length === 0) return;
  const userId = await resolveByKey(
    rows.map((r) => r.user),
    new Map([...usersByEmail].map(([email, u]) => [email, u.id])),
    async (email) => (await getUserByEmail(client, email))?.id,
    "user",
    ops.files.customAppUsers,
  );
  const appId = await resolveAppHandles(
    client,
    rows.map((r) => r.app),
    ops.files.customAppUsers,
  );

  // Bulk-fetch existing bindings per app so we don't issue redundant
  // attachCustomAppUser calls when reapplying the same file.
  const existingByApp = new Map<string, Set<string>>();
  for (const r of rows) {
    const aid = appId.get(r.app)!;
    let cached = existingByApp.get(aid);
    if (!cached) {
      const bindings = await listCustomAppUsers(client, { customAppId: aid });
      cached = new Set(bindings.map((b) => b.userId));
      existingByApp.set(aid, cached);
    }
    const uid = userId.get(r.user)!;
    if (cached.has(uid)) {
      console.log(`  app-user = ${r.user} → ${r.app}`);
      continue;
    }
    await attachCustomAppUser(client, { customAppId: aid, userId: uid });
    cached.add(uid);
    console.log(`  app-user + ${r.user} → ${r.app}`);
  }
}

/**
 * Apply team → custom-app bindings. Additive in the same shape as
 * `applyCustomAppUsers`; team handles resolve via `getTeamByName`.
 */
async function applyCustomAppTeams(
  client: GraphQLClient,
  rows: CustomAppTeam[],
  teamsByName: Map<string, TeamState>,
  ops: LoadedOps,
): Promise<void> {
  if (rows.length === 0) return;
  const teamId = await resolveByKey(
    rows.map((r) => r.team),
    new Map([...teamsByName].map(([n, t]) => [n, t.id])),
    async (name) => (await getTeamByName(client, name))?.id,
    "team",
    ops.files.customAppTeams,
  );
  const appId = await resolveAppHandles(
    client,
    rows.map((r) => r.app),
    ops.files.customAppTeams,
  );

  const existingByApp = new Map<string, Set<string>>();
  for (const r of rows) {
    const aid = appId.get(r.app)!;
    let cached = existingByApp.get(aid);
    if (!cached) {
      const bindings = await listCustomAppTeams(client, { customAppId: aid });
      cached = new Set(bindings.map((b) => b.teamId));
      existingByApp.set(aid, cached);
    }
    const tid = teamId.get(r.team)!;
    if (cached.has(tid)) {
      console.log(`  app-team = ${r.team} → ${r.app}`);
      continue;
    }
    await attachCustomAppTeam(client, { customAppId: aid, teamId: tid });
    cached.add(tid);
    console.log(`  app-team + ${r.team} → ${r.app}`);
  }
}

/**
 * Resolve a list of custom-app handles to their server IDs. Caches
 * each lookup so re-used handles don't re-query.
 */
async function resolveAppHandles(
  client: GraphQLClient,
  handles: string[],
  source: string | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const handle of new Set(handles)) {
    const app = await getCustomAppByHandle(client, handle);
    if (!app) {
      const hint = source ? ` (referenced from ${source})` : "";
      throw new Error(
        `Custom app '${handle}' doesn't exist on the server${hint}. ` +
          `Push the app first with 'cococo push ${handle}', then re-run apply.`,
      );
    }
    out.set(handle, app.id);
  }
  return out;
}

/** Generic resolver for natural-key → server-id lookups. */
async function resolveByKey(
  keys: string[],
  local: Map<string, string>,
  remote: (key: string) => Promise<string | undefined>,
  label: string,
  source: string | undefined,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const key of new Set(keys)) {
    const localHit = local.get(key);
    if (localHit !== undefined) {
      out.set(key, localHit);
      continue;
    }
    const remoteHit = await remote(key);
    if (remoteHit !== undefined) {
      out.set(key, remoteHit);
      continue;
    }
    const hint = source ? ` declared in ${source}` : "";
    throw new Error(
      `Reference to ${label} '${key}' that doesn't exist locally${hint} or on the server.`,
    );
  }
  return out;
}

function reportSummary(ops: LoadedOps): void {
  const parts: string[] = [];
  if (ops.users.length > 0) parts.push(`${ops.users.length} user(s)`);
  if (ops.policies.length > 0) parts.push(`${ops.policies.length} polic${ops.policies.length === 1 ? "y" : "ies"}`);
  if (ops.bindings.length > 0) parts.push(`${ops.bindings.length} binding(s)`);
  if (ops.networks.length > 0) parts.push(`${ops.networks.length} network(s)`);
  if (ops.devices.length > 0) parts.push(`${ops.devices.length} device(s)`);
  if (ops.teams.length > 0) parts.push(`${ops.teams.length} team(s)`);
  if (ops.customAppUsers.length > 0) parts.push(`${ops.customAppUsers.length} app-user(s)`);
  if (ops.customAppTeams.length > 0) parts.push(`${ops.customAppTeams.length} app-team(s)`);
  console.log(`Applied ${parts.join(", ")}.`);
}
