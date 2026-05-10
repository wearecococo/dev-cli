import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  deleteController,
  deleteDevice,
  deleteEdgeAppInstallation,
  deleteIAMPolicy,
  deleteNetwork,
  deleteTeam,
  deleteUser,
  deleteWorkflow,
  getWorkflowByName,
  detachCustomAppTeam,
  detachCustomAppUser,
  detachPolicy,
  getControllerByHandle,
  getCustomAppByHandle,
  getDeviceByIdentifier,
  getIAMPolicy,
  getNetworkByName,
  getTeamByName,
  getUserByEmail,
  listControllerTokens,
  listEdgeAppInstallations,
  removeTeamMember,
  resolveEdgeAppByHandleAndVersion,
  revokeControllerToken,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";

export type DeleteKind =
  | "user"
  | "policy"
  | "iam-policy-binding"
  | "network"
  | "device"
  | "team"
  | "team-member"
  | "custom-app-user-binding"
  | "custom-app-team-binding"
  | "controller"
  | "controller-token"
  | "edge-app-installation"
  | "workflow";

/**
 * Remove a tenant-IAM resource from the platform. The flat ops files
 * (users.ts / iam_policies.ts / iam_policy_bindings.ts) push additively, so this
 * is the only way to actually take something off the server. The local
 * file is NOT modified — the user has to remove the corresponding
 * entry by hand to keep the next apply consistent.
 */
export async function runDelete(
  kind: DeleteKind,
  args: string[],
  overrides: ConfigOverrides,
): Promise<void> {
  const client = createClient(loadConfig(overrides));
  if (kind === "user") {
    if (args.length !== 1) throw new Error(`cococo delete user <email> — got ${args.length} arg(s).`);
    await deleteUserByEmail(client, args[0]!);
    return;
  }
  if (kind === "policy") {
    if (args.length !== 1) throw new Error(`cococo delete policy <handle> — got ${args.length} arg(s).`);
    await deletePolicyByHandle(client, args[0]!);
    return;
  }
  if (kind === "iam-policy-binding") {
    if (args.length !== 2) {
      throw new Error(`cococo delete iam-policy-binding <email> <policy-handle> — got ${args.length} arg(s).`);
    }
    await deleteBinding(client, args[0]!, args[1]!);
    return;
  }
  if (kind === "network") {
    if (args.length !== 1) throw new Error(`cococo delete network <name> — got ${args.length} arg(s).`);
    await deleteNetworkByName(client, args[0]!);
    return;
  }
  if (kind === "device") {
    if (args.length !== 1) {
      throw new Error(`cococo delete device <identifier> — got ${args.length} arg(s).`);
    }
    await deleteDeviceByIdentifier(client, args[0]!);
    return;
  }
  if (kind === "team") {
    if (args.length !== 1) throw new Error(`cococo delete team <name> — got ${args.length} arg(s).`);
    await deleteTeamByName(client, args[0]!);
    return;
  }
  if (kind === "team-member") {
    if (args.length !== 2) {
      throw new Error(`cococo delete team-member <team-name> <email> — got ${args.length} arg(s).`);
    }
    await deleteTeamMember(client, args[0]!, args[1]!);
    return;
  }
  if (kind === "custom-app-user-binding") {
    if (args.length !== 2) {
      throw new Error(`cococo delete custom-app-user-binding <email> <app-handle> — got ${args.length} arg(s).`);
    }
    await deleteAppUser(client, args[0]!, args[1]!);
    return;
  }
  if (kind === "custom-app-team-binding") {
    if (args.length !== 2) {
      throw new Error(`cococo delete custom-app-team-binding <team-name> <app-handle> — got ${args.length} arg(s).`);
    }
    await deleteAppTeam(client, args[0]!, args[1]!);
    return;
  }
  if (kind === "controller") {
    if (args.length !== 1) {
      throw new Error(`cococo delete controller <handle> — got ${args.length} arg(s).`);
    }
    await deleteControllerByHandle(client, args[0]!);
    return;
  }
  if (kind === "controller-token") {
    if (args.length !== 2) {
      throw new Error(
        `cococo delete controller-token <controller-handle> <token-name> — got ${args.length} arg(s).`,
      );
    }
    await revokeTokenByName(client, args[0]!, args[1]!);
    return;
  }
  if (kind === "edge-app-installation") {
    if (args.length !== 3) {
      throw new Error(
        `cococo delete edge-app-installation <controller> <app> <version> — got ${args.length} arg(s).`,
      );
    }
    await deleteInstallation(client, args[0]!, args[1]!, parseInt(args[2]!, 10));
    return;
  }
  if (kind === "workflow") {
    if (args.length !== 1) {
      throw new Error(`cococo delete workflow <handle> — got ${args.length} arg(s).`);
    }
    await deleteWorkflowByHandle(client, args[0]!);
    return;
  }
  throw new Error(
    `cococo delete: unknown kind '${kind}'. Use user | policy | iam-policy-binding | ` +
      `network | device | team | team-member | custom-app-user-binding | ` +
      `custom-app-team-binding | controller | controller-token | edge-app-installation | workflow.`,
  );
}

async function deleteWorkflowByHandle(client: GraphQLClient, handle: string): Promise<void> {
  const workflow = await getWorkflowByName(client, handle);
  if (!workflow) {
    console.log(`No workflow found with handle '${handle}'.`);
    return;
  }
  await deleteWorkflow(client, workflow.id);
  console.log(`Deleted workflow ${handle} (${workflow.id}).`);
  console.log(`  Remember to remove the local workflows/${handle}/ folder if you keep it in git.`);
}

async function deleteUserByEmail(client: GraphQLClient, email: string): Promise<void> {
  const user = await getUserByEmail(client, email);
  if (!user) {
    console.log(`No user found with email '${email}'.`);
    return;
  }
  await deleteUser(client, user.id);
  console.log(`Deleted user ${email} (${user.id}).`);
  console.log(`  Remember to remove the entry from users.ts to keep apply consistent.`);
}

async function deletePolicyByHandle(client: GraphQLClient, handle: string): Promise<void> {
  const policy = await getIAMPolicy(client, handle);
  if (!policy) {
    console.log(`No policy found with handle '${handle}'.`);
    return;
  }
  await deleteIAMPolicy(client, policy.id);
  console.log(`Deleted policy ${handle} (${policy.id}).`);
  console.log(`  Remember to remove the entry from iam_policies.ts to keep apply consistent.`);
}

async function deleteNetworkByName(client: GraphQLClient, name: string): Promise<void> {
  const network = await getNetworkByName(client, name);
  if (!network) {
    console.log(`No network found with name '${name}'.`);
    return;
  }
  await deleteNetwork(client, network.id);
  console.log(`Deleted network ${name} (${network.id}).`);
  console.log(`  Remember to remove the entry from networks.ts to keep apply consistent.`);
}

async function deleteDeviceByIdentifier(client: GraphQLClient, identifier: string): Promise<void> {
  const device = await getDeviceByIdentifier(client, identifier);
  if (!device) {
    console.log(`No device found with identifier '${identifier}'.`);
    return;
  }
  await deleteDevice(client, device.id);
  console.log(`Deleted device ${identifier} (${device.id}).`);
  console.log(`  Remember to remove the entry from devices.ts to keep apply consistent.`);
}

async function deleteBinding(
  client: GraphQLClient,
  email: string,
  policyHandle: string,
): Promise<void> {
  const user = await getUserByEmail(client, email);
  if (!user) {
    throw new Error(`No user found with email '${email}'.`);
  }
  const policy = await getIAMPolicy(client, policyHandle);
  if (!policy) {
    throw new Error(`No policy found with handle '${policyHandle}'.`);
  }
  await detachPolicy(client, { userId: user.id, policyId: policy.id });
  console.log(`Detached policy ${policyHandle} from ${email}.`);
  console.log(`  Remember to remove the entry from iam_policy_bindings.ts to keep apply consistent.`);
}

async function deleteTeamByName(client: GraphQLClient, name: string): Promise<void> {
  const team = await getTeamByName(client, name);
  if (!team) {
    console.log(`No team found with name '${name}'.`);
    return;
  }
  await deleteTeam(client, team.id);
  console.log(`Deleted team ${name} (${team.id}).`);
  console.log(`  Remember to remove the entry from teams.ts to keep apply consistent.`);
}

async function deleteTeamMember(
  client: GraphQLClient,
  teamName: string,
  email: string,
): Promise<void> {
  const team = await getTeamByName(client, teamName);
  if (!team) throw new Error(`No team found with name '${teamName}'.`);
  const user = await getUserByEmail(client, email);
  if (!user) throw new Error(`No user found with email '${email}'.`);
  await removeTeamMember(client, { teamId: team.id, userId: user.id });
  console.log(`Removed ${email} from team '${teamName}'.`);
  console.log(`  Remember to remove the entry from teams.ts to keep apply consistent.`);
}

async function deleteAppUser(
  client: GraphQLClient,
  email: string,
  appHandle: string,
): Promise<void> {
  const user = await getUserByEmail(client, email);
  if (!user) throw new Error(`No user found with email '${email}'.`);
  const app = await getCustomAppByHandle(client, appHandle);
  if (!app) throw new Error(`No custom app found with handle '${appHandle}'.`);
  await detachCustomAppUser(client, { customAppId: app.id, userId: user.id });
  console.log(`Detached user ${email} from custom app '${appHandle}'.`);
  console.log(`  Remember to remove the entry from custom_app_user_bindings.ts to keep apply consistent.`);
}

async function deleteAppTeam(
  client: GraphQLClient,
  teamName: string,
  appHandle: string,
): Promise<void> {
  const team = await getTeamByName(client, teamName);
  if (!team) throw new Error(`No team found with name '${teamName}'.`);
  const app = await getCustomAppByHandle(client, appHandle);
  if (!app) throw new Error(`No custom app found with handle '${appHandle}'.`);
  await detachCustomAppTeam(client, { customAppId: app.id, teamId: team.id });
  console.log(`Detached team '${teamName}' from custom app '${appHandle}'.`);
  console.log(`  Remember to remove the entry from custom_app_team_bindings.ts to keep apply consistent.`);
}

async function deleteControllerByHandle(client: GraphQLClient, handle: string): Promise<void> {
  const controller = await getControllerByHandle(client, handle);
  if (!controller) {
    console.log(`No controller found with handle '${handle}'.`);
    return;
  }
  await deleteController(client, controller.id);
  console.log(`Deleted controller ${handle} (${controller.id}).`);
  console.log(`  Remember to remove the entry from controllers.ts to keep apply consistent.`);
}

async function revokeTokenByName(
  client: GraphQLClient,
  controllerHandle: string,
  tokenName: string,
): Promise<void> {
  const controller = await getControllerByHandle(client, controllerHandle);
  if (!controller) throw new Error(`No controller found with handle '${controllerHandle}'.`);
  const matches = await listControllerTokens(client, {
    controllerId: controller.id,
    name: tokenName,
    isRevoked: false,
  });
  if (matches.length === 0) {
    console.log(`No active token '${tokenName}' on controller '${controllerHandle}'.`);
    return;
  }
  await revokeControllerToken(client, matches[0]!.id);
  console.log(`Revoked token '${tokenName}' on controller '${controllerHandle}'.`);
  console.log(`  Remember to remove the entry from controller_tokens.ts to keep apply consistent.`);
}

async function deleteInstallation(
  client: GraphQLClient,
  controllerHandle: string,
  appHandle: string,
  version: number,
): Promise<void> {
  const controller = await getControllerByHandle(client, controllerHandle);
  if (!controller) throw new Error(`No controller found with handle '${controllerHandle}'.`);
  const edgeApp = await resolveEdgeAppByHandleAndVersion(client, appHandle, version);
  if (!edgeApp) {
    throw new Error(`No edge app '${appHandle}' v${version} on the server.`);
  }
  const installs = await listEdgeAppInstallations(client, {
    controllerId: controller.id,
    edgeAppId: edgeApp.id,
  });
  if (installs.length === 0) {
    console.log(
      `No installation of '${appHandle}' v${version} on controller '${controllerHandle}'.`,
    );
    return;
  }
  await deleteEdgeAppInstallation(client, installs[0]!.id);
  console.log(`Deleted installation ${controllerHandle}/${appHandle}@v${version}.`);
  console.log(
    `  Remember to remove the entry from edge_app_installations.ts to keep apply consistent.`,
  );
}
