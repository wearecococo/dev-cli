/**
 * State-tracking types for the managed-apply path.
 *
 * The state file records, per managed resource: the resource's
 * natural identity and the spec last successfully applied. Plan
 * compares (declared, lastApplied, live) to produce a diff; apply
 * executes the diff and rewrites state.
 *
 * Identities use natural keys (email, handle, name, etc.) — never
 * server-generated IDs — so a state file is portable across tenants.
 */

export type ResourceKind =
  | "user"
  | "iam_policy"
  | "iam_policy_binding"
  | "network"
  | "device"
  | "team"
  | "custom_app_user_binding"
  | "custom_app_team_binding"
  | "controller"
  | "controller_token"
  | "edge_app_installation";

export type ResourceIdentity =
  | { kind: "user"; email: string }
  | { kind: "iam_policy"; handle: string }
  | { kind: "iam_policy_binding"; email: string; policyHandle: string }
  | { kind: "network"; name: string }
  | { kind: "device"; identifier: string }
  | { kind: "team"; name: string }
  | { kind: "custom_app_user_binding"; email: string; appHandle: string }
  | { kind: "custom_app_team_binding"; teamName: string; appHandle: string }
  | { kind: "controller"; handle: string }
  | { kind: "controller_token"; controllerHandle: string; name: string }
  | { kind: "edge_app_installation"; controllerHandle: string; appHandle: string };

export type ManagedResource = {
  identity: ResourceIdentity;
  /**
   * Full spec as last applied, JSON-serialisable. Write-only fields
   * (device passwords etc.) are stripped before storage — those are
   * managed by the future variable-config system.
   */
  lastAppliedSpec: Record<string, unknown>;
  /** ISO8601. */
  lastAppliedAt: string;
};

export type StateFile = {
  schemaVersion: 1;
  /** ISO8601 of the most recent successful apply, or null if state is empty. */
  lastAppliedAt: string | null;
  resources: ManagedResource[];
};

export const STATE_SCHEMA_VERSION = 1 as const;

/**
 * Stable string key for an identity. Used to index resources for diff
 * comparison and as the sort key in plan output.
 *
 * Format: `<kind>:<part1>[:<part2>]`. Email addresses and handles are
 * lowercased here to stop case-only mismatches between declarations
 * and server responses from being treated as drift.
 */
export function identityKey(identity: ResourceIdentity): string {
  switch (identity.kind) {
    case "user":
      return `user:${norm(identity.email)}`;
    case "iam_policy":
      return `iam_policy:${norm(identity.handle)}`;
    case "iam_policy_binding":
      return `iam_policy_binding:${norm(identity.email)}:${norm(identity.policyHandle)}`;
    case "network":
      return `network:${norm(identity.name)}`;
    case "device":
      return `device:${norm(identity.identifier)}`;
    case "team":
      return `team:${norm(identity.name)}`;
    case "custom_app_user_binding":
      return `custom_app_user_binding:${norm(identity.email)}:${norm(identity.appHandle)}`;
    case "custom_app_team_binding":
      return `custom_app_team_binding:${norm(identity.teamName)}:${norm(identity.appHandle)}`;
    case "controller":
      return `controller:${norm(identity.handle)}`;
    case "controller_token":
      return `controller_token:${norm(identity.controllerHandle)}:${norm(identity.name)}`;
    case "edge_app_installation":
      // (controller, app) — version intentionally not part of the key,
      // because install-upgrade replaces older versions in place.
      return `edge_app_installation:${norm(identity.controllerHandle)}:${norm(identity.appHandle)}`;
  }
}

/**
 * Display label for an identity. Shown in plan output and diagnostic
 * messages — not used as a lookup key.
 */
export function identityLabel(identity: ResourceIdentity): string {
  switch (identity.kind) {
    case "user":
      return identity.email;
    case "iam_policy":
      return identity.handle;
    case "iam_policy_binding":
      return `${identity.email} → ${identity.policyHandle}`;
    case "network":
      return identity.name;
    case "device":
      return identity.identifier;
    case "team":
      return identity.name;
    case "custom_app_user_binding":
      return `${identity.email} → ${identity.appHandle}`;
    case "custom_app_team_binding":
      return `${identity.teamName} → ${identity.appHandle}`;
    case "controller":
      return identity.handle;
    case "controller_token":
      return `${identity.controllerHandle}/${identity.name}`;
    case "edge_app_installation":
      return `${identity.controllerHandle}/${identity.appHandle}`;
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Order in which kinds are created/updated. Reverse for deletes —
 * dependencies (e.g. iam_policy_bindings) come down before the things
 * they reference (users, policies).
 */
export const KIND_FORWARD_ORDER: ResourceKind[] = [
  "iam_policy",
  "user",
  "iam_policy_binding",
  "network",
  "device",
  "team",
  "custom_app_user_binding",
  "custom_app_team_binding",
  "controller",
  "controller_token",
  "edge_app_installation",
];
