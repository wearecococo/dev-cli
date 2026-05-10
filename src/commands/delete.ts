import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  deleteIAMPolicy,
  deleteUser,
  detachPolicy,
  getIAMPolicy,
  getUserByEmail,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";

export type DeleteKind = "user" | "policy" | "binding";

/**
 * Remove a tenant-IAM resource from the platform. The flat ops files
 * (users.ts / iam_policies.ts / bindings.ts) push additively, so this
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
  if (kind === "binding") {
    if (args.length !== 2) {
      throw new Error(`cococo delete binding <email> <policy-handle> — got ${args.length} arg(s).`);
    }
    await deleteBinding(client, args[0]!, args[1]!);
    return;
  }
  throw new Error(`cococo delete: unknown kind '${kind}'. Use user | policy | binding.`);
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
  console.log(`  Remember to remove the entry from bindings.ts to keep apply consistent.`);
}
