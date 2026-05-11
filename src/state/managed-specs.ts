/**
 * Project per-kind specs into a single canonical shape used for
 * comparison and storage in state.json. The shape is intentionally
 * close to the declared author-side spec, but:
 *
 *  - Write-only fields (passwords, secrets) are stripped — they belong
 *    to the future variable-config system, not state.json.
 *  - Server-generated identifiers (UUIDs, IDs) are dropped — natural
 *    keys are the source of truth.
 *  - Optional fields are only emitted when present, so absent vs.
 *    explicit-undefined compare equal under deepEqual.
 *  - Unordered arrays (statements, allowedIoPaths, members) are
 *    sorted into a canonical order before storage.
 *
 * Two entry points: `managedSpecFromDeclared` for author-side specs,
 * `managedSpecFromLive` for server-returned objects. Both must produce
 * identical output for an equivalent input — that's what makes
 * deepEqual a useful comparison.
 */

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
  type IntegrationInstallation,
  type Network,
  type Team,
  type User,
} from "../define.ts";
import type { ResourceKind } from "./types.ts";

export type ManagedSpec = Record<string, unknown>;

export function managedSpecFromDeclared(
  kind: ResourceKind,
  spec: unknown,
): ManagedSpec {
  switch (kind) {
    case "user":
      return userToManaged(spec as User);
    case "iam_policy":
      return policyToManaged(spec as IAMPolicy);
    case "iam_policy_binding":
      return bindingToManaged(spec as IAMPolicyBinding);
    case "network":
      return networkToManaged(spec as Network);
    case "device":
      return deviceToManaged(spec as Device);
    case "team":
      return teamToManaged(spec as Team);
    case "custom_app_user_binding":
      return appUserBindingToManaged(spec as CustomAppUserBinding);
    case "custom_app_team_binding":
      return appTeamBindingToManaged(spec as CustomAppTeamBinding);
    case "controller":
      return controllerToManaged(spec as Controller);
    case "controller_token":
      return controllerTokenToManaged(spec as ControllerToken);
    case "edge_app_installation":
      return edgeAppInstallationToManaged(spec as EdgeAppInstallation);
    case "integration_installation":
      return integrationInstallationToManaged(spec as IntegrationInstallation);
  }
}

export function managedSpecFromLive(
  kind: ResourceKind,
  live: unknown,
): ManagedSpec {
  switch (kind) {
    case "user":
      return liveUserToManaged(live as LiveUser);
    case "iam_policy":
      return livePolicyToManaged(live as LivePolicy);
    case "iam_policy_binding":
      return liveBindingToManaged(live as LiveBinding);
    case "network":
      return liveNetworkToManaged(live as LiveNetwork);
    case "device":
      return liveDeviceToManaged(live as LiveDevice);
    case "team":
      return liveTeamToManaged(live as LiveTeam);
    case "custom_app_user_binding":
      return liveAppUserBindingToManaged(live as LiveAppUserBinding);
    case "custom_app_team_binding":
      return liveAppTeamBindingToManaged(live as LiveAppTeamBinding);
    case "controller":
      return liveControllerToManaged(live as LiveController);
    case "controller_token":
      return liveControllerTokenToManaged(live as LiveControllerToken);
    case "edge_app_installation":
      return liveEdgeAppInstallationToManaged(live as LiveEdgeAppInstallation);
    case "integration_installation":
      return liveIntegrationInstallationToManaged(live as LiveIntegrationInstallation);
  }
}

// ── declared-side projections ─────────────────────────────────────────

function userToManaged(u: User): ManagedSpec {
  return compact({
    email: u.email.trim().toLowerCase(),
    name: u.name,
    kind: u.kind,
    externalId: u.externalId,
  });
}

function policyToManaged(p: IAMPolicy): ManagedSpec {
  return compact({
    handle: p.handle,
    name: p.name,
    description: p.description,
    statements: sortedStatements(p.statements),
  });
}

function bindingToManaged(b: IAMPolicyBinding): ManagedSpec {
  return {
    user: userEmail(b.user).toLowerCase(),
    policy: iamPolicyHandle(b.policy),
  };
}

function networkToManaged(n: Network): ManagedSpec {
  return compact({
    name: n.name,
    description: n.description,
  });
}

function deviceToManaged(d: Device): ManagedSpec {
  return compact({
    identifier: d.identifier,
    name: d.name,
    description: d.description,
    deviceType: d.deviceType,
    manufacturer: d.manufacturer,
    model: d.model,
    serialNumber: d.serialNumber,
    isActive: d.isActive,
    network: d.network !== undefined ? networkName(d.network) : undefined,
    // Strip secrets out of protocol configs (passwords, basicCredentials,
    // bearerTokens, etc.) — those will be handled by the future
    // variable-config system. Diff non-secret fields only.
    outboundProtocols: d.outboundProtocols?.map(stripProtocolSecrets),
    inboundProtocols: d.inboundProtocols,
  });
}

function teamToManaged(t: Team): ManagedSpec {
  return compact({
    name: t.name,
    description: t.description,
    members:
      t.members === undefined
        ? undefined
        : sortedUnique((t.members ?? []).map((m) => userEmail(m).toLowerCase())),
  });
}

function appUserBindingToManaged(r: CustomAppUserBinding): ManagedSpec {
  return {
    user: userEmail(r.user).toLowerCase(),
    app: r.app,
  };
}

function appTeamBindingToManaged(r: CustomAppTeamBinding): ManagedSpec {
  return {
    team: teamName(r.team),
    app: r.app,
  };
}

function controllerToManaged(c: Controller): ManagedSpec {
  return compact({
    handle: c.handle,
    name: c.name,
    description: c.description,
    host: c.host,
    port: c.port,
    isActive: c.isActive,
    network: c.network !== undefined ? networkName(c.network) : undefined,
    jmfConfig: c.jmfConfig,
    policy:
      c.policy === undefined
        ? undefined
        : {
            allowedIoPaths: sortedUnique(c.policy.allowedIoPaths),
            allowedExecBinaries: sortedUnique(c.policy.allowedExecBinaries),
          },
  });
}

function controllerTokenToManaged(t: ControllerToken): ManagedSpec {
  return compact({
    controller: controllerHandle(t.controller),
    name: t.name,
    description: t.description,
    expiresAt: t.expiresAt,
  });
}

function integrationInstallationToManaged(i: IntegrationInstallation): ManagedSpec {
  return compact({
    integration: i.integration,
    name: i.name,
    version: i.version,
    description: i.description,
    isActive: i.isActive,
    botUser: i.botUser !== undefined ? userEmail(i.botUser).toLowerCase() : undefined,
    config: i.config,
    bindings: i.bindings,
  });
}

function edgeAppInstallationToManaged(i: EdgeAppInstallation): ManagedSpec {
  return compact({
    controller: controllerHandle(i.controller),
    app: i.app,
    version: i.version,
    isActive: i.isActive,
    botUser: i.botUser !== undefined ? userEmail(i.botUser).toLowerCase() : undefined,
    // Variables can resolve `${config:NAME}` placeholders or hold
    // literals. We keep the declared values verbatim — secrets in
    // the literal form land in state until the variable-config
    // system handles them.
    variables: i.variables,
  });
}

// ── live-side projections ─────────────────────────────────────────────

type LiveUser = {
  email: string;
  name?: string | null;
  kind: User["kind"];
  externalId?: string | null;
};
function liveUserToManaged(u: LiveUser): ManagedSpec {
  return compact({
    email: u.email.trim().toLowerCase(),
    name: u.name ?? undefined,
    kind: u.kind,
    externalId: u.externalId ?? undefined,
  });
}

type LivePolicy = {
  handle: string;
  name: string;
  description?: string | null;
  document: { statements: IAMPolicy["statements"] };
};
function livePolicyToManaged(p: LivePolicy): ManagedSpec {
  return compact({
    handle: p.handle,
    name: p.name,
    description: p.description ?? undefined,
    statements: sortedStatements(p.document.statements ?? []),
  });
}

type LiveBinding = { userEmail: string; policyHandle: string };
function liveBindingToManaged(b: LiveBinding): ManagedSpec {
  return {
    user: b.userEmail.toLowerCase(),
    policy: b.policyHandle,
  };
}

type LiveNetwork = { name: string; description?: string | null };
function liveNetworkToManaged(n: LiveNetwork): ManagedSpec {
  return compact({
    name: n.name,
    description: n.description ?? undefined,
  });
}

type LiveDevice = {
  identifier: string;
  name?: string | null;
  description?: string | null;
  deviceType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  isActive?: boolean | null;
  network?: { name: string } | null;
  outboundProtocols?: unknown[] | null;
  inboundProtocols?: unknown[] | null;
};
function liveDeviceToManaged(d: LiveDevice): ManagedSpec {
  return compact({
    identifier: d.identifier,
    name: d.name ?? undefined,
    description: d.description ?? undefined,
    deviceType: d.deviceType ?? undefined,
    manufacturer: d.manufacturer ?? undefined,
    model: d.model ?? undefined,
    serialNumber: d.serialNumber ?? undefined,
    isActive: d.isActive ?? undefined,
    network: d.network?.name,
    outboundProtocols: d.outboundProtocols?.map((p) => stripProtocolSecrets(p as never)),
    inboundProtocols: d.inboundProtocols ?? undefined,
  });
}

type LiveTeam = {
  name: string;
  description?: string | null;
  members?: { email: string }[];
};
function liveTeamToManaged(t: LiveTeam): ManagedSpec {
  return compact({
    name: t.name,
    description: t.description ?? undefined,
    members:
      t.members === undefined
        ? undefined
        : sortedUnique(t.members.map((m) => m.email.toLowerCase())),
  });
}

type LiveAppUserBinding = { userEmail: string; appHandle: string };
function liveAppUserBindingToManaged(r: LiveAppUserBinding): ManagedSpec {
  return { user: r.userEmail.toLowerCase(), app: r.appHandle };
}

type LiveAppTeamBinding = { teamName: string; appHandle: string };
function liveAppTeamBindingToManaged(r: LiveAppTeamBinding): ManagedSpec {
  return { team: r.teamName, app: r.appHandle };
}

type LiveController = {
  handle: string;
  name?: string | null;
  description?: string | null;
  host?: string | null;
  port?: number | null;
  isActive?: boolean | null;
  network?: { name: string } | null;
  jmfConfig?: unknown;
  policy?: {
    allowedIoPaths: string[];
    allowedExecBinaries: string[];
  } | null;
};
function liveControllerToManaged(c: LiveController): ManagedSpec {
  return compact({
    handle: c.handle,
    name: c.name ?? undefined,
    description: c.description ?? undefined,
    host: c.host ?? undefined,
    port: c.port ?? undefined,
    isActive: c.isActive ?? undefined,
    network: c.network?.name,
    jmfConfig: c.jmfConfig,
    policy: c.policy
      ? {
          allowedIoPaths: sortedUnique(c.policy.allowedIoPaths),
          allowedExecBinaries: sortedUnique(c.policy.allowedExecBinaries),
        }
      : undefined,
  });
}

type LiveControllerToken = {
  controllerHandle: string;
  name: string;
  description?: string | null;
  expiresAt?: string | null;
};
function liveControllerTokenToManaged(t: LiveControllerToken): ManagedSpec {
  return compact({
    controller: t.controllerHandle,
    name: t.name,
    description: t.description ?? undefined,
    expiresAt: t.expiresAt ?? undefined,
  });
}

type LiveIntegrationInstallation = {
  integrationId: string;
  name: string;
  description?: string | null;
  version: string;
  status: "ACTIVE" | "PAUSED" | "ERROR" | "UPGRADING";
  botUserEmail?: string | null;
  config?: Record<string, unknown> | null;
  bindings?: Record<string, string> | null;
};
function liveIntegrationInstallationToManaged(i: LiveIntegrationInstallation): ManagedSpec {
  return compact({
    integration: i.integrationId,
    name: i.name,
    version: i.version,
    description: i.description ?? undefined,
    // Map runtime status back to declared isActive so a state-tracking
    // workspace can detect drift if the operator paused the install
    // out-of-band.
    isActive: i.status === "ACTIVE",
    botUser: i.botUserEmail ? i.botUserEmail.toLowerCase() : undefined,
    config: i.config ?? undefined,
    bindings: i.bindings ?? undefined,
  });
}

type LiveEdgeAppInstallation = {
  controllerHandle: string;
  appHandle: string;
  version: number;
  isActive?: boolean | null;
  botUserEmail?: string | null;
  variables?: Record<string, unknown> | null;
};
function liveEdgeAppInstallationToManaged(i: LiveEdgeAppInstallation): ManagedSpec {
  return compact({
    controller: i.controllerHandle,
    app: i.appHandle,
    version: i.version,
    isActive: i.isActive ?? undefined,
    botUser: i.botUserEmail ? i.botUserEmail.toLowerCase() : undefined,
    variables: i.variables ?? undefined,
  });
}

// ── helpers ───────────────────────────────────────────────────────────

const SECRET_KEYS = new Set([
  "password",
  "basicCredentials",
  "bearerTokens",
  "secret",
  "secrets",
  "privateKey",
  "snmpAuthPassword",
  "snmpPrivPassword",
]);

function stripProtocolSecrets<T extends Record<string, unknown>>(p: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (SECRET_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Drop `undefined` values from an object so absent vs.
 * explicit-undefined keys compare equal under deepEqual.
 */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function sortedUnique(arr: string[]): string[] {
  return [...new Set(arr)].sort();
}

function sortedStatements(
  statements: IAMPolicy["statements"],
): IAMPolicy["statements"] {
  // Sort each statement's actions/resources arrays to canonicalise,
  // then sort statements themselves by their stringified form.
  const normalised = statements.map((s) => ({
    effect: s.effect,
    actions: [...s.actions].sort(),
    resources: [...s.resources].sort(),
  }));
  return normalised.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b)),
  );
}
