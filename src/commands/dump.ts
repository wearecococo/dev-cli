import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  getCustomAppByHandle,
  getEdgeApp,
  getControllerPolicyByController,
  getTeamMembers,
  getUserByEmail,
  listControllers,
  listCustomAppTeams,
  listCustomAppUsers,
  listDevices,
  listEdgeAppInstallations,
  listIAMPolicies,
  listNetworks,
  listTeams,
  listUserPolicies,
  listUsers,
  type ControllerState,
  type DeviceState,
  type EdgeAppInstallationState,
  type IAMPolicyState,
  type InboundProtocolConfig,
  type NetworkState,
  type OutboundProtocolConfig,
  type TeamState,
  type UserState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import {
  BINDINGS_FILENAME,
  CONTROLLERS_FILENAME,
  CUSTOM_APP_TEAMS_FILENAME,
  CUSTOM_APP_USERS_FILENAME,
  DEVICES_FILENAME,
  EDGE_APP_INSTALLATIONS_FILENAME,
  NETWORKS_FILENAME,
  POLICIES_FILENAME,
  TEAMS_FILENAME,
  USERS_FILENAME,
} from "../ops.ts";

export type DumpKind =
  | "users"
  | "policies"
  | "bindings"
  | "networks"
  | "devices"
  | "teams"
  | "custom-app-users"
  | "custom-app-teams"
  | "controllers"
  | "edge-app-installations"
  | "all";

export type DumpOptions = {
  /** Overwrite local files that already exist. Default false. */
  force?: boolean;
  /** Target directory; defaults to cwd. Used by `bootstrap --pull`. */
  cwd?: string;
};

const ALL_KINDS: Exclude<DumpKind, "all">[] = [
  "users",
  "policies",
  "bindings",
  "networks",
  "devices",
  "teams",
  "custom-app-users",
  "custom-app-teams",
  "controllers",
  "edge-app-installations",
];

export async function runDump(
  kind: DumpKind,
  opts: DumpOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const client = createClient(loadConfig(overrides));
  const cwd = opts.cwd ?? process.cwd();
  const force = opts.force ?? false;

  if (kind === "all") {
    for (const k of ALL_KINDS) {
      await dumpOne(client, k, cwd, force);
    }
    return;
  }
  await dumpOne(client, kind, cwd, force);
}

async function dumpOne(
  client: GraphQLClient,
  kind: Exclude<DumpKind, "all">,
  cwd: string,
  force: boolean,
): Promise<void> {
  if (kind === "users") return dumpUsers(client, cwd, force);
  if (kind === "policies") return dumpPolicies(client, cwd, force);
  if (kind === "bindings") return dumpBindings(client, cwd, force);
  if (kind === "networks") return dumpNetworks(client, cwd, force);
  if (kind === "devices") return dumpDevices(client, cwd, force);
  if (kind === "teams") return dumpTeams(client, cwd, force);
  if (kind === "custom-app-users") return dumpCustomAppUsers(client, cwd, force);
  if (kind === "custom-app-teams") return dumpCustomAppTeams(client, cwd, force);
  if (kind === "controllers") return dumpControllers(client, cwd, force);
  if (kind === "edge-app-installations") return dumpInstallations(client, cwd, force);
}

// ──────────────────────────────────────────────────────────────────────
// Per-kind dumpers. Each one fetches from the server, projects onto
// the author shape, and writes a TS file at the repo root. Empty
// resources still write a stub file so the user can see "I have nothing
// of this kind yet" without having to remember the filename.
// ──────────────────────────────────────────────────────────────────────

async function dumpUsers(client: GraphQLClient, cwd: string, force: boolean): Promise<void> {
  const users = await listUsers(client);
  const items = users.map((u) => ({
    email: u.email,
    name: u.name ?? undefined,
    kind: u.kind,
    externalId: u.externalId ?? undefined,
  }));
  writeOps(cwd, USERS_FILENAME, "defineUsers", items, force);
}

async function dumpPolicies(client: GraphQLClient, cwd: string, force: boolean): Promise<void> {
  const policies = await listIAMPolicies(client);
  const items = policies.map(toPolicySpec);
  writeOps(cwd, POLICIES_FILENAME, "defineIAMPolicies", items, force);
}

function toPolicySpec(p: IAMPolicyState): Record<string, unknown> {
  return {
    handle: p.id,
    name: p.name,
    description: p.description ?? undefined,
    statements: p.document.statements.map((s) => ({
      effect: s.effect,
      actions: s.actions,
      resources: s.resources,
    })),
  };
}

/**
 * Bindings live cross-resource — each user's attached policies are a
 * separate query. We fan out across users to enumerate the full set,
 * then emit `{ user, policy }` pairs by natural keys.
 */
async function dumpBindings(client: GraphQLClient, cwd: string, force: boolean): Promise<void> {
  const users = await listUsers(client);
  const items: Array<{ user: string; policy: string }> = [];
  for (const u of users) {
    const policies = await listUserPolicies(client, u.id);
    for (const p of policies) items.push({ user: u.email, policy: p.id });
  }
  writeOps(cwd, BINDINGS_FILENAME, "defineBindings", items, force);
}

async function dumpNetworks(client: GraphQLClient, cwd: string, force: boolean): Promise<void> {
  const networks = await listNetworks(client);
  const items = networks.map((n) => ({
    name: n.name,
    description: n.description ?? undefined,
  }));
  writeOps(cwd, NETWORKS_FILENAME, "defineNetworks", items, force);
}

/**
 * Devices need a networkId → name resolution and emit `${config:...}`
 * placeholders for write-only secrets the server doesn't return
 * (passwords, connection strings).
 */
async function dumpDevices(client: GraphQLClient, cwd: string, force: boolean): Promise<void> {
  const networks = await listNetworks(client);
  const networkNameById = new Map(networks.map((n) => [n.id, n.name]));

  const devices = await listDevices(client);
  const items = devices.map((d) => toDeviceSpec(d, networkNameById));
  writeOps(cwd, DEVICES_FILENAME, "defineDevices", items, force);
}

function toDeviceSpec(
  d: DeviceState,
  networkNameById: Map<string, string>,
): Record<string, unknown> {
  const network = d.networkId ? networkNameById.get(d.networkId) : undefined;
  return strip({
    identifier: d.identifier,
    network,
    name: d.name,
    description: d.description,
    deviceType: d.deviceType,
    manufacturer: d.manufacturer,
    model: d.model,
    serialNumber: d.serialNumber,
    isActive: d.isActive,
    outboundProtocols: d.outboundProtocols.length
      ? d.outboundProtocols.map((p) => transformOutboundForDump(p, d.identifier))
      : undefined,
    inboundProtocols: d.inboundProtocols.length
      ? d.inboundProtocols.map(transformInboundForDump)
      : undefined,
  });
}

function transformOutboundForDump(
  p: OutboundProtocolConfig,
  deviceIdentifier: string,
): Record<string, unknown> {
  // Server omits passwords + connectionStrings on read. When auth is
  // configured we fill in a placeholder so re-applying the file doesn't
  // silently overwrite the secret with nothing — the user can swap in a
  // real value or define the config key.
  const slug = sanitizeKey(deviceIdentifier);
  const out: Record<string, unknown> = strip({
    kind: p.kind,
    label: p.label,
    url: p.url,
    authMode: p.authMode,
    username: p.username,
    adapter: p.adapter,
    host: p.host,
    port: p.port,
    databaseName: p.databaseName,
    topic: p.topic,
  });
  if (p.kind === "HTTP" || p.kind === "MQTT") {
    if (p.username) out.password = `\${config:DEVICE_${slug}_${p.kind}_PASSWORD}`;
  }
  if (p.kind === "SQL") {
    if (p.username) out.password = `\${config:DEVICE_${slug}_SQL_PASSWORD}`;
    // `connectionString` is also write-only; we don't know if it was
    // configured. Leave it absent — users explicitly using it can edit
    // by hand.
  }
  return out;
}

function transformInboundForDump(p: InboundProtocolConfig): Record<string, unknown> {
  return strip({
    kind: p.kind,
    label: p.label,
    topic: p.topic,
    webhookPath: p.webhookPath,
  });
}

/**
 * Teams emit with their canonical members list — fetched per team via
 * `getTeamMembers`. The downstream apply pass treats this list as the
 * exact set, so the dumped state is round-trip-clean.
 */
async function dumpTeams(client: GraphQLClient, cwd: string, force: boolean): Promise<void> {
  const teams = await listTeams(client);
  const items: Array<Record<string, unknown>> = [];
  for (const t of teams) {
    const members = await getTeamMembers(client, t.id);
    items.push(
      strip({
        name: t.name,
        description: t.description,
        members: members.length ? members.map((m) => m.email) : undefined,
      }),
    );
  }
  writeOps(cwd, TEAMS_FILENAME, "defineTeams", items, force);
}

async function dumpCustomAppUsers(
  client: GraphQLClient,
  cwd: string,
  force: boolean,
): Promise<void> {
  const bindings = await listCustomAppUsers(client);
  // Bulk-resolve emails + handles. Iterating through getUser/getCustomApp
  // for every binding row would explode for big tenants — so we cache by
  // id within the dump.
  const userEmails = new Map<string, string>();
  const appHandles = new Map<string, string>();
  for (const b of bindings) {
    if (!userEmails.has(b.userId)) {
      const user = await getUserById(client, b.userId);
      if (user) userEmails.set(b.userId, user.email);
    }
    if (!appHandles.has(b.customAppId)) {
      const handle = await getCustomAppHandleById(client, b.customAppId);
      if (handle) appHandles.set(b.customAppId, handle);
    }
  }
  const items = bindings
    .filter((b) => userEmails.has(b.userId) && appHandles.has(b.customAppId))
    .map((b) => ({ user: userEmails.get(b.userId)!, app: appHandles.get(b.customAppId)! }));
  writeOps(cwd, CUSTOM_APP_USERS_FILENAME, "defineCustomAppUsers", items, force);
}

async function dumpCustomAppTeams(
  client: GraphQLClient,
  cwd: string,
  force: boolean,
): Promise<void> {
  const bindings = await listCustomAppTeams(client);
  const teamNames = new Map<string, string>();
  const appHandles = new Map<string, string>();
  // Pre-fetch all teams so we can map id → name in one pass.
  const teams = await listTeams(client);
  for (const t of teams) teamNames.set(t.id, t.name);
  for (const b of bindings) {
    if (!appHandles.has(b.customAppId)) {
      const handle = await getCustomAppHandleById(client, b.customAppId);
      if (handle) appHandles.set(b.customAppId, handle);
    }
  }
  const items = bindings
    .filter((b) => teamNames.has(b.teamId) && appHandles.has(b.customAppId))
    .map((b) => ({ team: teamNames.get(b.teamId)!, app: appHandles.get(b.customAppId)! }));
  writeOps(cwd, CUSTOM_APP_TEAMS_FILENAME, "defineCustomAppTeams", items, force);
}

async function dumpControllers(
  client: GraphQLClient,
  cwd: string,
  force: boolean,
): Promise<void> {
  const controllers = await listControllers(client);
  const networks = await listNetworks(client);
  const networkNameById = new Map(networks.map((n) => [n.id, n.name]));

  const items: Array<Record<string, unknown>> = [];
  for (const c of controllers) {
    items.push(await toControllerSpec(client, c, networkNameById));
  }
  writeOps(cwd, CONTROLLERS_FILENAME, "defineControllers", items, force);
}

async function toControllerSpec(
  client: GraphQLClient,
  c: ControllerState,
  networkNameById: Map<string, string>,
): Promise<Record<string, unknown>> {
  const policy = await getControllerPolicyByController(client, c.id);
  return strip({
    handle: c.handle,
    network: c.networkId ? networkNameById.get(c.networkId) : undefined,
    name: c.name,
    description: c.description,
    host: c.host,
    port: c.port,
    isActive: c.isActive,
    jmfConfig: c.jmfConfig
      ? strip({
          enabled: c.jmfConfig.enabled,
          path: c.jmfConfig.path,
          authEnabled: c.jmfConfig.authEnabled,
        })
      : undefined,
    policy: policy
      ? {
          allowedIoPaths: policy.allowedIoPaths,
          allowedExecBinaries: policy.allowedExecBinaries,
        }
      : undefined,
  });
}

async function dumpInstallations(
  client: GraphQLClient,
  cwd: string,
  force: boolean,
): Promise<void> {
  const installs = await listEdgeAppInstallations(client);
  const controllers = await listControllers(client);
  const controllerHandleById = new Map(controllers.map((c) => [c.id, c.handle]));

  const items: Array<Record<string, unknown>> = [];
  for (const i of installs) {
    const item = await toInstallationSpec(client, i, controllerHandleById);
    if (item) items.push(item);
  }
  writeOps(
    cwd,
    EDGE_APP_INSTALLATIONS_FILENAME,
    "defineEdgeAppInstallations",
    items,
    force,
  );
}

async function toInstallationSpec(
  client: GraphQLClient,
  i: EdgeAppInstallationState,
  controllerHandleById: Map<string, string>,
): Promise<Record<string, unknown> | undefined> {
  const controller = controllerHandleById.get(i.controllerId);
  if (!controller) return undefined;

  // Prefer the inline edgeApp ref when the server returned one — saves a
  // round-trip. Fall back to a getEdgeApp query for robustness.
  let app: string | undefined = i.edgeApp?.handle;
  let version: number | undefined = i.edgeApp?.version;
  if (!app || version === undefined) {
    try {
      const fetched = await getEdgeApp(client, i.edgeAppId);
      app = fetched.handle;
      version = fetched.version;
    } catch {
      return undefined;
    }
  }

  let botUser: string | undefined;
  if (i.botUserId) {
    const user = await getUserById(client, i.botUserId);
    if (user) botUser = user.email;
  }

  return strip({
    controller,
    app,
    version,
    botUser,
    isActive: i.isActive ? undefined : false, // default true; only emit when overridden
    variables:
      i.variables && Object.keys(i.variables).length > 0 ? i.variables : undefined,
  });
}

// ──────────────────────────────────────────────────────────────────────
// Helpers used across dumpers.
// ──────────────────────────────────────────────────────────────────────

async function getUserById(
  client: GraphQLClient,
  id: string,
): Promise<UserState | undefined> {
  const query = `query GetUser($id: UserID!) { getUser(id: $id) { id email name kind externalId createdAt updatedAt } }`;
  const data = await client.request<{ getUser: UserState | null }>(query, { id });
  return data.getUser ?? undefined;
}

async function getCustomAppHandleById(
  client: GraphQLClient,
  id: string,
): Promise<string | undefined> {
  const query = `query GetCustomApp($id: CustomAppID!) { getCustomApp(id: $id) { handle } }`;
  const data = await client.request<{ getCustomApp: { handle: string } | null }>(query, { id });
  return data.getCustomApp?.handle;
}

/**
 * Drop undefined entries so `printObject` doesn't emit `field: undefined`.
 * Recursive — nested optional fields disappear too.
 */
function strip<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v === null) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Serialize a list of items into the body of an ops file. Pure — no
 * filesystem touched. Tested directly to lock in the printer's output
 * shape and the placeholder banner behavior without mocking GraphQL.
 */
export function serializeOps(fn: string, items: unknown[]): string {
  const banner = items.some(containsConfigPlaceholder)
    ? `// NOTE: Some secrets aren't returned by the server, so the dumper\n` +
      `// filled them in with \${config:...} template-string placeholders.\n` +
      `// Replace with literal values or define the config keys before applying.\n\n`
    : "";
  return `${banner}import { ${fn} } from "@wearecococo/dev-cli/define";\n\nexport default ${fn}(${printArray(items, 0)});\n`;
}

function writeOps(
  cwd: string,
  filename: string,
  fn: string,
  items: unknown[],
  force: boolean,
): void {
  const dest = resolve(cwd, filename);
  if (existsSync(dest) && !force) {
    console.error(`${filename} already exists. Use --force to overwrite.`);
    process.exit(1);
  }
  writeFileSync(dest, serializeOps(fn, items));
  console.log(`  ${filename}  (${items.length} item${items.length === 1 ? "" : "s"})`);
}

function containsConfigPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${config:");
  if (Array.isArray(value)) return value.some(containsConfigPlaceholder);
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsConfigPlaceholder);
  }
  return false;
}

function sanitizeKey(s: string): string {
  return s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();
}

// ──────────────────────────────────────────────────────────────────────
// Tiny TS-literal printer for ops file output. Only handles plain JSON
// shapes plus identifier-safe key names — the manifest printer in
// `src/printer.ts` does more (LuaFile refs etc), but ops files are
// pure data and don't need that extra surface.
// ──────────────────────────────────────────────────────────────────────

function printValue(value: unknown, indent: number): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return printArray(value, indent);
  if (typeof value === "object") return printObject(value as Record<string, unknown>, indent);
  return JSON.stringify(value);
}

function printArray(arr: unknown[], indent: number): string {
  if (arr.length === 0) return "[]";
  const inner = " ".repeat((indent + 1) * 2);
  const closing = " ".repeat(indent * 2);
  const items = arr.map((v) => `${inner}${printValue(v, indent + 1)}`);
  return `[\n${items.join(",\n")},\n${closing}]`;
}

function printObject(obj: Record<string, unknown>, indent: number): string {
  const entries = Object.entries(obj).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return "{}";
  const inner = " ".repeat((indent + 1) * 2);
  const closing = " ".repeat(indent * 2);
  const lines = entries.map(([k, v]) => `${inner}${formatKey(k)}: ${printValue(v, indent + 1)}`);
  return `{\n${lines.join(",\n")},\n${closing}}`;
}

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
function formatKey(k: string): string {
  return SAFE_KEY.test(k) ? k : JSON.stringify(k);
}
