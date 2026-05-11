import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "../graphql/client.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { loadOps } from "../ops.ts";
import { LocalFileStateBackend } from "../state/local-backend.ts";
import { fetchLiveSnapshot } from "../state/live-fetch.ts";
import {
  identityKey,
  identityLabel,
  type ManagedResource,
  type ResourceIdentity,
  type StateFile,
} from "../state/types.ts";
import {
  controllerHandle,
  iamPolicyHandle,
  teamName,
  userEmail,
} from "../define.ts";
import { managedSpecFromDeclared, type ManagedSpec } from "../state/managed-specs.ts";
import { promptYes } from "../prompt.ts";

export type StateImportOptions = {
  yes: boolean;
  force: boolean;
};

/**
 * Bootstrap state.json from the live tenant. For every locally declared
 * resource that exists on the server, record an entry whose
 * `lastAppliedSpec` is the *server's current view* of that resource —
 * the workspace then "adopts" those resources. Subsequent `cococo plan`
 * reflects diffs between the declared specs and the imported state.
 *
 * Resources declared locally but absent from the server land as
 * `+ create` on the next `cococo plan` / `cococo apply`. Resources
 * present on the server but not declared are *not* adopted — listed
 * for visibility only.
 */
export async function runStateImport(
  opts: StateImportOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const cwd = process.cwd();
  const statePath = resolve(cwd, ".cococo/state.json");
  if (existsSync(statePath) && !opts.force) {
    console.error(
      `cococo state import: state file already exists at .cococo/state.json. ` +
        `Re-run with --force to overwrite (you'll lose the existing state).`,
    );
    process.exit(1);
  }

  const backend = new LocalFileStateBackend(cwd);
  const ops = await loadOps(cwd);
  const client = createClient(loadConfig(overrides));
  const live = await fetchLiveSnapshot(client, ops, null);

  const declared = collectDeclared(ops);
  const adopted: ManagedResource[] = [];
  const willBeCreated: ResourceIdentity[] = [];

  for (const { identity, spec } of declared) {
    const key = identityKey(identity);
    const liveSpec = live.get(key);
    if (liveSpec) {
      adopted.push({
        identity,
        // Adopt the *server's view* — that's the truth at import time.
        // The next `cococo plan` will diff declared against this.
        lastAppliedSpec: liveSpec,
        lastAppliedAt: new Date().toISOString(),
      });
    } else {
      willBeCreated.push(identity);
      // Avoid using `spec` here; just informational. Suppress unused
      // lint by leaving it referenced in a void.
      void spec;
    }
  }

  console.log(`State import preview:\n`);
  if (adopted.length > 0) {
    console.log(`  Adopting ${adopted.length} existing resource(s) into managed state:`);
    for (const r of adopted) {
      console.log(`    = ${r.identity.kind.padEnd(28)} ${identityLabel(r.identity)}`);
    }
  } else {
    console.log(`  (no existing resources match declarations)`);
  }
  if (willBeCreated.length > 0) {
    console.log(
      `\n  ${willBeCreated.length} declared resource(s) don't exist on the server — they'll be created on next apply:`,
    );
    for (const id of willBeCreated) {
      console.log(`    + ${id.kind.padEnd(28)} ${identityLabel(id)}`);
    }
  }

  const onServerOnly = countOrphans(live, [...declared.map((d) => d.identity)]);
  if (onServerOnly > 0) {
    console.log(
      `\n  ${onServerOnly} resource(s) exist on the server but aren't declared locally — left unmanaged.`,
    );
  }

  if (adopted.length === 0 && willBeCreated.length === 0) {
    console.log(`\nNothing to import.`);
    return;
  }

  console.log("");
  if (!opts.yes) {
    const ok = await promptYes(`Adopt these resources?`);
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  const state: StateFile = {
    schemaVersion: 1,
    lastAppliedAt: adopted.length > 0 ? new Date().toISOString() : null,
    resources: adopted,
  };
  await backend.write(state);
  console.log(`Wrote .cococo/state.json (${adopted.length} adopted resource(s)).`);
  if (willBeCreated.length > 0) {
    console.log(`Run 'cococo apply' to create the ${willBeCreated.length} declared-but-not-yet-on-server resource(s).`);
  }
  if (adopted.length > 0) {
    console.log("");
    console.log(
      `Tip: your local config files may not exactly match the live tenant's view of the ` +
        `adopted resources (different field ordering, missing optional fields, etc.). ` +
        `Run 'cococo dump all -f' to refresh the config files from the server, then ` +
        `'cococo plan' to see the remaining declared-vs-server drift.`,
    );
  }
}

function countOrphans(
  live: Map<string, ManagedSpec>,
  declaredIdentities: ResourceIdentity[],
): number {
  const declaredKeys = new Set(declaredIdentities.map((i) => identityKey(i)));
  let n = 0;
  for (const k of live.keys()) {
    if (!declaredKeys.has(k)) n++;
  }
  return n;
}

function collectDeclared(
  ops: Awaited<ReturnType<typeof loadOps>>,
): Array<{ identity: ResourceIdentity; spec: ManagedSpec }> {
  const out: Array<{ identity: ResourceIdentity; spec: ManagedSpec }> = [];
  for (const p of ops.policies) {
    out.push({
      identity: { kind: "iam_policy", handle: p.handle },
      spec: managedSpecFromDeclared("iam_policy", p),
    });
  }
  for (const u of ops.users) {
    out.push({
      identity: { kind: "user", email: u.email },
      spec: managedSpecFromDeclared("user", u),
    });
  }
  for (const b of ops.policyBindings) {
    out.push({
      identity: {
        kind: "iam_policy_binding",
        email: userEmail(b.user),
        policyHandle: iamPolicyHandle(b.policy),
      },
      spec: managedSpecFromDeclared("iam_policy_binding", b),
    });
  }
  for (const n of ops.networks) {
    out.push({
      identity: { kind: "network", name: n.name },
      spec: managedSpecFromDeclared("network", n),
    });
  }
  for (const d of ops.devices) {
    out.push({
      identity: { kind: "device", identifier: d.identifier },
      spec: managedSpecFromDeclared("device", d),
    });
  }
  for (const t of ops.teams) {
    out.push({
      identity: { kind: "team", name: t.name },
      spec: managedSpecFromDeclared("team", t),
    });
  }
  for (const r of ops.customAppUserBindings) {
    out.push({
      identity: {
        kind: "custom_app_user_binding",
        email: userEmail(r.user),
        appHandle: r.app,
      },
      spec: managedSpecFromDeclared("custom_app_user_binding", r),
    });
  }
  for (const r of ops.customAppTeamBindings) {
    out.push({
      identity: {
        kind: "custom_app_team_binding",
        teamName: teamName(r.team),
        appHandle: r.app,
      },
      spec: managedSpecFromDeclared("custom_app_team_binding", r),
    });
  }
  for (const c of ops.controllers) {
    out.push({
      identity: { kind: "controller", handle: c.handle },
      spec: managedSpecFromDeclared("controller", c),
    });
  }
  for (const tk of ops.controllerTokens) {
    out.push({
      identity: {
        kind: "controller_token",
        controllerHandle: controllerHandle(tk.controller),
        name: tk.name,
      },
      spec: managedSpecFromDeclared("controller_token", tk),
    });
  }
  for (const i of ops.edgeAppInstallations) {
    out.push({
      identity: {
        kind: "edge_app_installation",
        controllerHandle: controllerHandle(i.controller),
        appHandle: i.app,
      },
      spec: managedSpecFromDeclared("edge_app_installation", i),
    });
  }
  return out;
}
