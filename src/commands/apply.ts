import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  attachPolicy,
  createIAMPolicy,
  getIAMPolicy,
  getUserByEmail,
  listUserPolicies,
  updateIAMPolicy,
  upsertUser,
  type IAMDocument,
  type IAMPolicyState,
  type UserState,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { loadOps, type LoadedOps } from "../ops.ts";
import type { BindingSpec, IAMPolicySpec, UserSpec } from "../define.ts";

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
  if (
    ops.files.users === undefined &&
    ops.files.policies === undefined &&
    ops.files.bindings === undefined
  ) {
    console.log(
      `No ops files found in ${process.cwd()}. Expected one of: users.ts, iam_policies.ts, bindings.ts.`,
    );
    return;
  }

  const client = createClient(loadConfig(overrides));
  const policiesById = await applyPolicies(client, ops.policies);
  const usersByEmail = await applyUsers(client, ops.users);
  await applyBindings(client, ops.bindings, usersByEmail, policiesById, ops);

  reportSummary(ops);
}

async function applyPolicies(
  client: GraphQLClient,
  policies: IAMPolicySpec[],
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
  users: UserSpec[],
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
  bindings: BindingSpec[],
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

function reportSummary(ops: LoadedOps): void {
  const parts: string[] = [];
  if (ops.users.length > 0) parts.push(`${ops.users.length} user(s)`);
  if (ops.policies.length > 0) parts.push(`${ops.policies.length} polic${ops.policies.length === 1 ? "y" : "ies"}`);
  if (ops.bindings.length > 0) parts.push(`${ops.bindings.length} binding(s)`);
  console.log(`Applied ${parts.join(", ")}.`);
}
