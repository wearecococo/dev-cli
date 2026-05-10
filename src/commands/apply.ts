import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  attachPolicy,
  createIAMPolicy,
  getDeviceByIdentifier,
  getIAMPolicy,
  getNetworkByName,
  getUserByEmail,
  listUserPolicies,
  updateIAMPolicy,
  upsertDevice,
  upsertNetwork,
  upsertUser,
  type IAMDocument,
  type IAMPolicyState,
  type InboundProtocolConfig,
  type NetworkState,
  type OutboundProtocolConfig,
  type UserState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { loadOps, type LoadedOps } from "../ops.ts";
import type {
  Binding,
  Device,
  IAMPolicy,
  InboundProtocol,
  Network,
  OutboundProtocol,
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
        `users.ts, iam_policies.ts, bindings.ts, networks.ts, devices.ts.`,
    );
    return;
  }

  const client = createClient(loadConfig(overrides));
  const policiesById = await applyPolicies(client, ops.policies);
  const usersByEmail = await applyUsers(client, ops.users);
  await applyBindings(client, ops.bindings, usersByEmail, policiesById, ops);
  const networksByName = await applyNetworks(client, ops.networks);
  await applyDevices(client, ops.devices, networksByName, ops);

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

function reportSummary(ops: LoadedOps): void {
  const parts: string[] = [];
  if (ops.users.length > 0) parts.push(`${ops.users.length} user(s)`);
  if (ops.policies.length > 0) parts.push(`${ops.policies.length} polic${ops.policies.length === 1 ? "y" : "ies"}`);
  if (ops.bindings.length > 0) parts.push(`${ops.bindings.length} binding(s)`);
  if (ops.networks.length > 0) parts.push(`${ops.networks.length} network(s)`);
  if (ops.devices.length > 0) parts.push(`${ops.devices.length} device(s)`);
  console.log(`Applied ${parts.join(", ")}.`);
}
