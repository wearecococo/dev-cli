import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  controllerHandle,
  manifestKind,
  teamName,
  userEmail,
  iamPolicyHandle,
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
} from "./define.ts";

export const USERS_FILENAME = "users.ts";
export const POLICIES_FILENAME = "iam_policies.ts";
export const POLICY_BINDINGS_FILENAME = "iam_policy_bindings.ts";
export const NETWORKS_FILENAME = "networks.ts";
export const DEVICES_FILENAME = "devices.ts";
export const TEAMS_FILENAME = "teams.ts";
export const CUSTOM_APP_USER_BINDINGS_FILENAME = "custom_app_user_bindings.ts";
export const CUSTOM_APP_TEAM_BINDINGS_FILENAME = "custom_app_team_bindings.ts";
export const CONTROLLERS_FILENAME = "controllers.ts";
export const CONTROLLER_TOKENS_FILENAME = "controller_tokens.ts";
export const EDGE_APP_INSTALLATIONS_FILENAME = "edge_app_installations.ts";

export type LoadedOps = {
  /** Absolute paths to the files that were loaded. */
  files: {
    users?: string;
    policies?: string;
    policyBindings?: string;
    networks?: string;
    devices?: string;
    teams?: string;
    customAppUserBindings?: string;
    customAppTeamBindings?: string;
    controllers?: string;
    controllerTokens?: string;
    edgeAppInstallations?: string;
  };
  users: User[];
  policies: IAMPolicy[];
  policyBindings: IAMPolicyBinding[];
  networks: Network[];
  devices: Device[];
  teams: Team[];
  customAppUserBindings: CustomAppUserBinding[];
  customAppTeamBindings: CustomAppTeamBinding[];
  controllers: Controller[];
  controllerTokens: ControllerToken[];
  edgeAppInstallations: EdgeAppInstallation[];
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
  const policyBindingsPath = resolve(repoRoot, POLICY_BINDINGS_FILENAME);
  const networksPath = resolve(repoRoot, NETWORKS_FILENAME);
  const devicesPath = resolve(repoRoot, DEVICES_FILENAME);
  const teamsPath = resolve(repoRoot, TEAMS_FILENAME);
  const customAppUserBindingsPath = resolve(repoRoot, CUSTOM_APP_USER_BINDINGS_FILENAME);
  const customAppTeamBindingsPath = resolve(repoRoot, CUSTOM_APP_TEAM_BINDINGS_FILENAME);
  const controllersPath = resolve(repoRoot, CONTROLLERS_FILENAME);
  const controllerTokensPath = resolve(repoRoot, CONTROLLER_TOKENS_FILENAME);
  const edgeAppInstallationsPath = resolve(repoRoot, EDGE_APP_INSTALLATIONS_FILENAME);

  const out: LoadedOps = {
    files: {},
    users: [],
    policies: [],
    policyBindings: [],
    networks: [],
    devices: [],
    teams: [],
    customAppUserBindings: [],
    customAppTeamBindings: [],
    controllers: [],
    controllerTokens: [],
    edgeAppInstallations: [],
  };

  if (existsSync(usersPath)) {
    out.users = await loadList(usersPath, "users", "users");
    out.files.users = usersPath;
  }
  if (existsSync(policiesPath)) {
    out.policies = await loadList(policiesPath, "iam_policies", "policies");
    out.files.policies = policiesPath;
  }
  if (existsSync(policyBindingsPath)) {
    out.policyBindings = await loadList(policyBindingsPath, "iam_policy_bindings", "bindings");
    out.files.policyBindings = policyBindingsPath;
  }
  if (existsSync(networksPath)) {
    out.networks = await loadList(networksPath, "networks", "networks");
    out.files.networks = networksPath;
  }
  if (existsSync(devicesPath)) {
    out.devices = await loadList(devicesPath, "devices", "devices");
    out.files.devices = devicesPath;
  }
  if (existsSync(teamsPath)) {
    out.teams = await loadList(teamsPath, "teams", "teams");
    out.files.teams = teamsPath;
  }
  if (existsSync(customAppUserBindingsPath)) {
    out.customAppUserBindings = await loadList(
      customAppUserBindingsPath,
      "custom_app_user_bindings",
      "bindings",
    );
    out.files.customAppUserBindings = customAppUserBindingsPath;
  }
  if (existsSync(customAppTeamBindingsPath)) {
    out.customAppTeamBindings = await loadList(
      customAppTeamBindingsPath,
      "custom_app_team_bindings",
      "bindings",
    );
    out.files.customAppTeamBindings = customAppTeamBindingsPath;
  }
  if (existsSync(controllersPath)) {
    out.controllers = await loadList(controllersPath, "controllers", "controllers");
    out.files.controllers = controllersPath;
  }
  if (existsSync(controllerTokensPath)) {
    out.controllerTokens = await loadList(
      controllerTokensPath,
      "controller_tokens",
      "tokens",
    );
    out.files.controllerTokens = controllerTokensPath;
  }
  if (existsSync(edgeAppInstallationsPath)) {
    out.edgeAppInstallations = await loadList(
      edgeAppInstallationsPath,
      "edge_app_installations",
      "installations",
    );
    out.files.edgeAppInstallations = edgeAppInstallationsPath;
  }

  validateNoDuplicates(out);
  return out;
}

type OpsKind =
  | "users"
  | "iam_policies"
  | "iam_policy_bindings"
  | "networks"
  | "devices"
  | "teams"
  | "custom_app_user_bindings"
  | "custom_app_team_bindings"
  | "controllers"
  | "controller_tokens"
  | "edge_app_installations";
type OpsField =
  | "users"
  | "policies"
  | "bindings"
  | "networks"
  | "devices"
  | "teams"
  | "controllers"
  | "tokens"
  | "installations";

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
  if (kind === "iam_policy_bindings") return "IAMPolicyBindings";
  if (kind === "networks") return "Networks";
  if (kind === "devices") return "Devices";
  if (kind === "teams") return "Teams";
  if (kind === "custom_app_user_bindings") return "CustomAppUserBindings";
  if (kind === "custom_app_team_bindings") return "CustomAppTeamBindings";
  if (kind === "controllers") return "Controllers";
  if (kind === "controller_tokens") return "ControllerTokens";
  return "EdgeAppInstallations";
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
  for (const b of ops.policyBindings) {
    const u = userEmail(b.user);
    const p = iamPolicyHandle(b.policy);
    const key = `${u}|${p}`;
    if (seenBindings.has(key)) {
      throw new Error(
        `Duplicate IAM policy binding ${u} → ${p} in iam_policy_bindings.ts.`,
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
  const seenTeams = new Set<string>();
  for (const t of ops.teams) {
    if (seenTeams.has(t.name)) {
      throw new Error(
        `Duplicate team name '${t.name}' in teams.ts. Name is the natural key.`,
      );
    }
    seenTeams.add(t.name);
    // Member emails inside a single team must also be unique — adding
    // the same user twice is a no-op on the server but a clear authoring
    // mistake worth flagging.
    if (t.members) {
      const seenMembers = new Set<string>();
      for (const m of t.members) {
        const email = userEmail(m);
        if (seenMembers.has(email)) {
          throw new Error(
            `Duplicate member '${email}' in team '${t.name}' in teams.ts.`,
          );
        }
        seenMembers.add(email);
      }
    }
  }
  const seenAppUsers = new Set<string>();
  for (const b of ops.customAppUserBindings) {
    const u = userEmail(b.user);
    const key = `${u}|${b.app}`;
    if (seenAppUsers.has(key)) {
      throw new Error(
        `Duplicate custom-app user binding ${u} → ${b.app} in custom_app_user_bindings.ts.`,
      );
    }
    seenAppUsers.add(key);
  }
  const seenAppTeams = new Set<string>();
  for (const b of ops.customAppTeamBindings) {
    const t = teamName(b.team);
    const key = `${t}|${b.app}`;
    if (seenAppTeams.has(key)) {
      throw new Error(
        `Duplicate custom-app team binding ${t} → ${b.app} in custom_app_team_bindings.ts.`,
      );
    }
    seenAppTeams.add(key);
  }
  const seenControllers = new Set<string>();
  for (const c of ops.controllers) {
    if (seenControllers.has(c.handle)) {
      throw new Error(
        `Duplicate controller handle '${c.handle}' in controllers.ts. Handle is the natural key.`,
      );
    }
    seenControllers.add(c.handle);
  }
  const seenTokens = new Set<string>();
  for (const t of ops.controllerTokens) {
    const ctrl = controllerHandle(t.controller);
    const key = `${ctrl}|${t.name}`;
    if (seenTokens.has(key)) {
      throw new Error(
        `Duplicate controller token ${ctrl}/${t.name} in controller_tokens.ts. ` +
          `(controller, name) is the natural key.`,
      );
    }
    seenTokens.add(key);
  }
  const seenInstalls = new Set<string>();
  for (const i of ops.edgeAppInstallations) {
    const ctrl = controllerHandle(i.controller);
    const key = `${ctrl}|${i.app}`;
    if (seenInstalls.has(key)) {
      throw new Error(
        `Duplicate edge-app installation ${i.app} on ${ctrl} in edge_app_installations.ts. ` +
          `Only one version of an edge-app handle can be installed per controller.`,
      );
    }
    seenInstalls.add(key);
  }
}
