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
  listControllerTokens,
  listCustomAppTeams,
  listCustomAppUsers,
  listEdgeAppInstallations,
  listUserPolicies,
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
  type ControllerState,
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
  type InboundProtocol,
  type Network,
  type OutboundProtocol,
  type Team,
  type User,
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
        `users.ts, iam_policies.ts, iam_policy_bindings.ts, networks.ts, devices.ts, ` +
        `teams.ts, custom_app_user_bindings.ts, custom_app_team_bindings.ts, ` +
        `controllers.ts, controller_tokens.ts, edge_app_installations.ts.`,
    );
    return;
  }

  const client = createClient(loadConfig(overrides));
  const policiesById = await applyPolicies(client, ops.policies);
  const usersByEmail = await applyUsers(client, ops.users);
  await applyPolicyBindings(client, ops.policyBindings, usersByEmail, policiesById, ops);
  const networksByName = await applyNetworks(client, ops.networks);
  await applyDevices(client, ops.devices, networksByName, ops);
  const teamsByName = await applyTeams(client, ops.teams, usersByEmail, ops);
  await applyCustomAppUserBindings(client, ops.customAppUserBindings, usersByEmail, ops);
  await applyCustomAppTeamBindings(client, ops.customAppTeamBindings, teamsByName, ops);
  const controllersByHandle = await applyControllers(client, ops.controllers, networksByName);
  await applyControllerTokens(client, ops.controllerTokens, controllersByHandle, ops);
  await applyEdgeAppInstallations(
    client,
    ops.edgeAppInstallations,
    controllersByHandle,
    usersByEmail,
    ops,
  );

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
 * it isn't in `iam_policy_bindings.ts`, we leave it. Use
 * `cococo delete iam-policy-binding` to detach.
 */
async function applyPolicyBindings(
  client: GraphQLClient,
  bindings: IAMPolicyBinding[],
  usersByEmail: Map<string, UserState>,
  policiesByHandle: Map<string, IAMPolicyState>,
  ops: LoadedOps,
): Promise<void> {
  if (bindings.length === 0) return;

  // Each binding ref is either a string natural key or a typed object;
  // extract the natural key so we can resolve uniformly.
  const userKeys = bindings.map((b) => userEmail(b.user));
  const policyKeys = bindings.map((b) => iamPolicyHandle(b.policy));

  const userId = await resolverFor(
    userKeys,
    usersByEmail,
    async (email) => (await getUserByEmail(client, email))?.id,
    "user",
    ops.files.users,
  );
  const policyId = await resolverFor(
    policyKeys,
    new Map([...policiesByHandle].map(([h, p]) => [h, p.id])),
    async (handle) => (await getIAMPolicy(client, handle))?.id,
    "policy",
    ops.files.policies,
  );

  // Cache the current attachments per user so we don't issue redundant
  // attachPolicy calls when reapplying the same file.
  const existingByUser = new Map<string, Set<string>>();
  for (const b of bindings) {
    const u = userEmail(b.user);
    const p = iamPolicyHandle(b.policy);
    const uid = userId.get(u)!;
    const pid = policyId.get(p)!;
    let current = existingByUser.get(uid);
    if (!current) {
      const policies = await listUserPolicies(client, uid);
      current = new Set(policies.map((pp) => pp.id));
      existingByUser.set(uid, current);
    }
    if (current.has(pid)) {
      console.log(`  binding = ${u} → ${p}`);
      continue;
    }
    await attachPolicy(client, { userId: uid, policyId: pid });
    current.add(pid);
    console.log(`  binding + ${u} → ${p}`);
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
    let netLabel: string | undefined;
    if (d.network !== undefined) {
      netLabel = networkName(d.network);
      const local = networksByName.get(netLabel);
      if (local) {
        networkId = local.id;
      } else {
        const remote = await getNetworkByName(client, netLabel);
        if (!remote) {
          throw new Error(
            `Device '${d.identifier}' references network '${netLabel}' that doesn't exist ` +
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
    const netNote = netLabel ? ` → ${netLabel}` : "";
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
  declared: Team["members"],
  usersByEmail: Map<string, UserState>,
  ops: LoadedOps,
): Promise<void> {
  const declaredIds = new Map<string, string>();
  for (const ref of declared ?? []) {
    const email = userEmail(ref);
    if (declaredIds.has(email)) continue;
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
async function applyCustomAppUserBindings(
  client: GraphQLClient,
  rows: CustomAppUserBinding[],
  usersByEmail: Map<string, UserState>,
  ops: LoadedOps,
): Promise<void> {
  if (rows.length === 0) return;
  const userKeys = rows.map((r) => userEmail(r.user));
  const userId = await resolveByKey(
    userKeys,
    new Map([...usersByEmail].map(([email, u]) => [email, u.id])),
    async (email) => (await getUserByEmail(client, email))?.id,
    "user",
    ops.files.customAppUserBindings,
  );
  const appId = await resolveAppHandles(
    client,
    rows.map((r) => r.app),
    ops.files.customAppUserBindings,
  );

  // Bulk-fetch existing bindings per app so we don't issue redundant
  // attachCustomAppUser calls when reapplying the same file.
  const existingByApp = new Map<string, Set<string>>();
  for (const r of rows) {
    const u = userEmail(r.user);
    const aid = appId.get(r.app)!;
    let cached = existingByApp.get(aid);
    if (!cached) {
      const bindings = await listCustomAppUsers(client, { customAppId: aid });
      cached = new Set(bindings.map((b) => b.userId));
      existingByApp.set(aid, cached);
    }
    const uid = userId.get(u)!;
    if (cached.has(uid)) {
      console.log(`  app-user = ${u} → ${r.app}`);
      continue;
    }
    await attachCustomAppUser(client, { customAppId: aid, userId: uid });
    cached.add(uid);
    console.log(`  app-user + ${u} → ${r.app}`);
  }
}

/**
 * Apply team → custom-app bindings. Additive in the same shape as
 * `applyCustomAppUsers`; team handles resolve via `getTeamByName`.
 */
async function applyCustomAppTeamBindings(
  client: GraphQLClient,
  rows: CustomAppTeamBinding[],
  teamsByName: Map<string, TeamState>,
  ops: LoadedOps,
): Promise<void> {
  if (rows.length === 0) return;
  const teamKeys = rows.map((r) => teamName(r.team));
  const teamId = await resolveByKey(
    teamKeys,
    new Map([...teamsByName].map(([n, t]) => [n, t.id])),
    async (name) => (await getTeamByName(client, name))?.id,
    "team",
    ops.files.customAppTeamBindings,
  );
  const appId = await resolveAppHandles(
    client,
    rows.map((r) => r.app),
    ops.files.customAppTeamBindings,
  );

  const existingByApp = new Map<string, Set<string>>();
  for (const r of rows) {
    const t = teamName(r.team);
    const aid = appId.get(r.app)!;
    let cached = existingByApp.get(aid);
    if (!cached) {
      const bindings = await listCustomAppTeams(client, { customAppId: aid });
      cached = new Set(bindings.map((b) => b.teamId));
      existingByApp.set(aid, cached);
    }
    const tid = teamId.get(t)!;
    if (cached.has(tid)) {
      console.log(`  app-team = ${t} → ${r.app}`);
      continue;
    }
    await attachCustomAppTeam(client, { customAppId: aid, teamId: tid });
    cached.add(tid);
    console.log(`  app-team + ${t} → ${r.app}`);
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

/**
 * Apply controllers + their inline policy. The controller row is
 * additive (declared rows get upserted). The inline `policy.allowedIoPaths`
 * and `allowedExecBinaries` lists are reconciled wholesale per the
 * server's "Idempotent on controllerId, wholesale-replace on both
 * allowlists" semantics — what's listed is exactly what the bridge gets.
 *
 * Network ref resolves the same belt-and-braces way as devices.
 */
async function applyControllers(
  client: GraphQLClient,
  controllers: Controller[],
  networksByName: Map<string, NetworkState>,
): Promise<Map<string, ControllerState>> {
  const out = new Map<string, ControllerState>();
  for (const c of controllers) {
    let networkId: string | undefined;
    if (c.network !== undefined) {
      const netLabel = networkName(c.network);
      const local = networksByName.get(netLabel);
      if (local) {
        networkId = local.id;
      } else {
        const remote = await getNetworkByName(client, netLabel);
        if (!remote) {
          throw new Error(
            `Controller '${c.handle}' references network '${netLabel}' that ` +
              `doesn't exist locally or on the server.`,
          );
        }
        networkId = remote.id;
      }
    }

    const existing = await getControllerByHandle(client, c.handle);
    const result = await upsertController(client, {
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
    console.log(`  controller ${existing ? "~" : "+"} ${c.handle}`);
    out.set(c.handle, result);

    if (c.policy !== undefined) {
      const existingPolicy = await getControllerPolicyByController(client, result.id);
      const same = existingPolicy &&
        equalUnorderedString(existingPolicy.allowedIoPaths, c.policy.allowedIoPaths) &&
        equalUnorderedString(existingPolicy.allowedExecBinaries, c.policy.allowedExecBinaries);
      if (same) {
        console.log(`    policy =  io=${c.policy.allowedIoPaths.length} exec=${c.policy.allowedExecBinaries.length}`);
      } else {
        await upsertControllerPolicy(client, {
          controllerId: result.id,
          allowedIoPaths: c.policy.allowedIoPaths,
          allowedExecBinaries: c.policy.allowedExecBinaries,
        });
        console.log(
          `    policy ${existingPolicy ? "~" : "+"} io=${c.policy.allowedIoPaths.length} exec=${c.policy.allowedExecBinaries.length}`,
        );
      }
    }
  }
  return out;
}

function equalUnorderedString(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  for (const x of a) if (!setB.has(x)) return false;
  return true;
}

/**
 * Apply controller tokens. Create-only with an existence check: for
 * each declared (controller, name) pair, look up an active (non-revoked)
 * token. If one exists, skip. Otherwise mint a new one and print the
 * connect bundle to stdout exactly once — the platform never returns
 * it again, so the user must capture it now (pipe to a secret manager,
 * paste into the bridge config, etc).
 */
async function applyControllerTokens(
  client: GraphQLClient,
  tokens: ControllerToken[],
  controllersByHandle: Map<string, ControllerState>,
  ops: LoadedOps,
): Promise<void> {
  for (const t of tokens) {
    const ctrlHandle = controllerHandle(t.controller);
    const controllerId = await resolveControllerId(client, ctrlHandle, controllersByHandle, ops);

    const matches = await listControllerTokens(client, {
      controllerId,
      name: t.name,
      isRevoked: false,
    });
    if (matches.length > 0) {
      console.log(`  token = ${ctrlHandle}/${t.name}`);
      continue;
    }

    const created = await createControllerToken(client, {
      controllerId,
      name: t.name,
      description: t.description,
      expiresAt: t.expiresAt,
    });
    console.log(`  token + ${ctrlHandle}/${t.name}`);
    console.log(`    Connect bundle (save this — never shown again):`);
    console.log(`    ${created.connectBundle}`);
  }
}

/**
 * Apply edge-app installations. For each declared
 * `(controller, app-handle, version)`:
 *
 *  1. Resolve `(handle, version)` to a specific server-side `edgeAppId`.
 *     Each edge-app version is its own row; install pins one of them.
 *  2. Look up an existing install for `(controllerId, edgeAppId)`
 *     exactly. If found, upsert with id (idempotent variable update).
 *  3. If no exact match, look for any install on this controller
 *     pointing at *another* version of the same handle. If found,
 *     `upgrade` re-pins it without losing per-installation state.
 *  4. If neither, create a fresh install.
 */
async function applyEdgeAppInstallations(
  client: GraphQLClient,
  installs: EdgeAppInstallation[],
  controllersByHandle: Map<string, ControllerState>,
  usersByEmail: Map<string, UserState>,
  ops: LoadedOps,
): Promise<void> {
  for (const i of installs) {
    const ctrlHandle = controllerHandle(i.controller);
    const controllerId = await resolveControllerId(client, ctrlHandle, controllersByHandle, ops);
    const edgeApp = await resolveEdgeAppByHandleAndVersion(client, i.app, i.version);
    if (!edgeApp) {
      throw new Error(
        `Edge app '${i.app}' v${i.version} doesn't exist on the server. ` +
          `Push and publish the edge app first.`,
      );
    }
    if (edgeApp.status === "DRAFT") {
      throw new Error(
        `Edge app '${i.app}' v${i.version} is DRAFT — installations must pin a ` +
          `PUBLISHED or DEPRECATED version. Run 'cococo publish ${i.app}' first.`,
      );
    }

    let botUserId: string | null | undefined;
    if (i.botUser !== undefined) {
      const botEmail = userEmail(i.botUser);
      const local = usersByEmail.get(botEmail);
      const user = local ?? (await getUserByEmail(client, botEmail));
      if (!user) {
        throw new Error(
          `Installation ${ctrlHandle}/${i.app} references botUser '${botEmail}' ` +
            `that doesn't exist locally or on the server.`,
        );
      }
      botUserId = user.id;
    }

    const exact = await listEdgeAppInstallations(client, {
      controllerId,
      edgeAppId: edgeApp.id,
    });
    if (exact.length > 0) {
      const cur = exact[0]!;
      await upsertEdgeAppInstallation(client, {
        id: cur.id,
        edgeAppId: edgeApp.id,
        controllerId,
        botUserId,
        isActive: i.isActive,
        variables: i.variables,
      });
      console.log(`  install ~ ${ctrlHandle}/${i.app}@v${i.version}`);
      continue;
    }

    // No install at this exact version — check for an install of a
    // different version of the same handle (the upgrade case).
    const onController = await listEdgeAppInstallations(client, { controllerId });
    const sameHandle = onController.find((inst) => inst.edgeApp?.handle === i.app);
    if (sameHandle) {
      await upgradeEdgeAppInstallation(client, {
        id: sameHandle.id,
        toEdgeAppId: edgeApp.id,
      });
      // After upgrade, push the latest variables/botUser/isActive via
      // the same id so the install reflects the declared spec.
      await upsertEdgeAppInstallation(client, {
        id: sameHandle.id,
        edgeAppId: edgeApp.id,
        controllerId,
        botUserId,
        isActive: i.isActive,
        variables: i.variables,
      });
      console.log(
        `  install ↑ ${ctrlHandle}/${i.app} v${sameHandle.edgeApp?.version} → v${i.version}`,
      );
      continue;
    }

    await upsertEdgeAppInstallation(client, {
      edgeAppId: edgeApp.id,
      controllerId,
      botUserId,
      isActive: i.isActive,
      variables: i.variables,
    });
    console.log(`  install + ${ctrlHandle}/${i.app}@v${i.version}`);
  }
}

async function resolveControllerId(
  client: GraphQLClient,
  handle: string,
  controllersByHandle: Map<string, ControllerState>,
  ops: LoadedOps,
): Promise<string> {
  const local = controllersByHandle.get(handle);
  if (local) return local.id;
  const remote = await getControllerByHandle(client, handle);
  if (!remote) {
    const hint = ops.files.controllers ? ` declared in ${ops.files.controllers}` : "";
    throw new Error(
      `Controller '${handle}' doesn't exist locally${hint} or on the server.`,
    );
  }
  return remote.id;
}

function reportSummary(ops: LoadedOps): void {
  const parts: string[] = [];
  if (ops.users.length > 0) parts.push(`${ops.users.length} user(s)`);
  if (ops.policies.length > 0) parts.push(`${ops.policies.length} polic${ops.policies.length === 1 ? "y" : "ies"}`);
  if (ops.policyBindings.length > 0) parts.push(`${ops.policyBindings.length} binding(s)`);
  if (ops.networks.length > 0) parts.push(`${ops.networks.length} network(s)`);
  if (ops.devices.length > 0) parts.push(`${ops.devices.length} device(s)`);
  if (ops.teams.length > 0) parts.push(`${ops.teams.length} team(s)`);
  if (ops.customAppUserBindings.length > 0) parts.push(`${ops.customAppUserBindings.length} app-user(s)`);
  if (ops.customAppTeamBindings.length > 0) parts.push(`${ops.customAppTeamBindings.length} app-team(s)`);
  if (ops.controllers.length > 0) parts.push(`${ops.controllers.length} controller(s)`);
  if (ops.controllerTokens.length > 0) parts.push(`${ops.controllerTokens.length} token(s)`);
  if (ops.edgeAppInstallations.length > 0) {
    parts.push(`${ops.edgeAppInstallations.length} install(s)`);
  }
  console.log(`Applied ${parts.join(", ")}.`);
}
