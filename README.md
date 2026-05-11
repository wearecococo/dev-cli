# @wearecococo/dev-cli

Manage your cococo tenant from a git repo. Declarative tenant config —
**users, IAM policies, teams, networks, devices, controllers, edge-app
installations** — alongside the full lifecycle of your platform
extensions — **integrations, custom apps, edge apps, workflows**. One CLI, one
repo, one `apply` loop.

If you've used Terraform, Pulumi, or `kubectl apply` for tenant
configuration, this is that, scoped to a cococo tenant. If you're new
to GitOps: edit TypeScript files, run a command, watch the changes land
on your tenant.

## Contents

- [What this CLI manages](#what-this-cli-manages)
- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Getting your tenant credentials](#getting-your-tenant-credentials)
- [Install](#install)
- [Configuration](#configuration)
- [First-time setup walkthrough](#first-time-setup-walkthrough)
- [Tenant config](#tenant-config)
  - [Users + IAM policies](#users--iam-policies)
  - [Teams + custom-app assignments](#teams--custom-app-assignments)
  - [Networks + devices](#networks--devices)
  - [Controllers, tokens, edge-app installations](#controllers-tokens-edge-app-installations)
- [Building extensions](#building-extensions)
  - [Authoring an integration](#authoring-an-integration)
  - [Authoring a custom app](#authoring-a-custom-app)
  - [Authoring an edge app](#authoring-an-edge-app)
  - [Authoring a workflow](#authoring-a-workflow)
- [Daily workflow](#daily-workflow)
- [Migrating v1 integrations](#migrating-v1-integrations)
- [Reference](#reference)
- [Notes & limitations](#notes--limitations)
- [Hacking on the CLI itself](#hacking-on-the-cli-itself)

## What this CLI manages

**Tenant config** — declarative state of your cococo account. Lives as
flat per-kind files at the repo root, applied with `cococo apply`:

| File | What's in it |
|---|---|
| `users.ts` | People who can sign in to your tenant |
| `iam_policies.ts` | What actions each role is allowed to take |
| `iam_policy_bindings.ts` | Which user has which policy |
| `teams.ts` | Groupings of users for collaboration + bulk app assignment |
| `custom_app_user_bindings.ts` | Which user can see which custom app (kiosk mode) |
| `custom_app_team_bindings.ts` | Which team can see which custom app |
| `networks.ts` | Logical groupings of controllers + devices |
| `devices.ts` | IoT devices and their protocol configs |
| `controllers.ts` | Bridge boxes (with inline IO/exec policy) |
| `controller_tokens.ts` | Auth bundles for the bridge |
| `edge_app_installations.ts` | Pin a specific edge-app version to a controller |

**Platform extensions** — the things you build *on top of* cococo.
Each one is its own folder, pushed individually with `cococo push` and
released with `cococo publish`:

| Folder | What's in it |
|---|---|
| `integrations/<name>/` | Background workers — timers, subscriptions, lifecycle hooks, helper libraries |
| `custom_apps/<handle>/` | User-facing pages, dashboards, kiosks (Vue + JS + optional Lua RPC) |
| `edge_apps/<handle>/` | Apps that run on a controller — handlers, libraries, MQTT/OPC UA/SNMP/Modbus/HTTP I/O |
| `workflows/<handle>/` | Visual node-and-edge workflows — declarative DAGs with scheduled / event / webhook / device-MQTT / edge-app triggers |

You don't have to use both halves. A print-shop ops team that just
wants users + controllers + edge-app installs uses only the tenant-config
files. A platform team building extensions ships them through the
artifact folders. Most real deployments do both, from the same repo.

### How this relates to the dashboard

The dashboard is the read-write interface humans use day to day. This
CLI is the same surface, exposed as version-controlled files. Anything
you can do here, you can also do in the dashboard, and vice versa —
they edit the same database. `cococo dump all` pulls dashboard changes
into your repo; `cococo apply` pushes repo changes to the tenant. Use
whichever fits the change you're making.

## How it works

Two top-level commands cover the apply side:

- **`cococo apply`** — reads tenant-config files at the repo root and
  pushes them to your tenant. Mostly **additive**: `apply` upserts what
  you've declared and never deletes things you haven't. A few exceptions
  reconcile (declared list = canonical set) and one is create-only —
  see the [apply semantics](#apply-semantics) table below.
- **`cococo push <folder>`** — uploads a single artifact (integration,
  custom app, or edge app) to its remote draft. **`cococo publish`**
  then ships the draft to PUBLISHED. `cococo push --all` walks every
  artifact folder.

Two for the pull side:

- **`cococo dump <kind|all>`** — write tenant-config state from the
  server into local ops files. Round-trips through `apply` cleanly.
- **`cococo pull <id|handle>`** — download a specific artifact's
  draft into a local folder.

To remove things: **`cococo delete <kind> <args>`** for tenant
resources, **`cococo deprecate <folder>`** for published artifacts.
Local files are *never* edited by `delete` — drop the entry yourself
afterwards to keep apply consistent.

### Apply semantics

| Resource | Semantics |
|---|---|
| Most rows (users, policies, networks, devices, controllers, app bindings, etc.) | **Additive** — declared rows upsert; undeclared rows untouched |
| Team `members` (inline list) | **Reconciled** — the inline list is the canonical set for that team |
| Controller `policy` (inline) | **Reconciled** — both allowlists wholesale-replaced |
| Controller tokens | **Create-only with existence check** — non-revoked `(controller, name)` skips; missing ones get minted, connect bundle prints once |
| Edge-app installations | **Smart upsert** — exact-version match updates variables; older version of the same handle on the same controller triggers `upgrade`; otherwise creates fresh |

When in doubt, `cococo dump all -f` shows you what's actually on the
server vs. what you've declared.

### State-tracking apply (opt-in)

`cococo apply` defaults to the additive model above. For workflows
where the repo *is* the source of truth (i.e. removing a row from a
config file should delete it server-side), opt into the state-tracking
mode by running `cococo state import` once:

```sh
bunx cococo state import       # adopt current tenant config into managed state
bunx cococo plan               # preview the next apply (read-only)
bunx cococo apply              # creates/updates only; refuses if any deletes are planned
bunx cococo apply --allow-destroy   # required to execute deletions
```

`state import` writes `.cococo/state.json` (committed to git) recording
which resources this workspace manages and the spec last successfully
applied to each. Once that file exists, `cococo apply` switches into
state-tracking mode automatically.

| Behaviour | Additive (default) | State-tracking |
|---|---|---|
| Add a row to a config file | Creates on next apply | Creates on next apply |
| Edit an existing row | Updates on next apply | Updates on next apply |
| Remove a row from a config file | **Untouched on server** — use `cococo delete` | **Deleted on server** (under `--allow-destroy`) |
| Resources created in dashboard / by other repos | Ignored | Ignored — state only manages what you've adopted |
| Plan preview | n/a — apply is the preview | `cococo plan` shows the diff before mutating |

**Safety gates for deletes.** `cococo apply` refuses to run when the
plan contains deletions unless you pass `--allow-destroy`. If both
`--allow-destroy` and any deletes are present, the confirmation prompt
requires typing the literal word `yes` (not just `y/N`). For
unattended CI, pass `--yes` to skip the prompt.

**Drift detection.** If the server has been modified outside this
repo (e.g. someone edited a user via the dashboard), the plan flags
the affected rows as `~ user alice@acme.com (server modified)`. Apply
re-converges the server to your declared spec.

**Write-only fields.** Device passwords, edge-app variable secrets,
and other write-only spec fields are stripped from `.cococo/state.json`
— they're managed by the future variable-config system. As a result,
plans currently show those fields as "always changed" until that
system ships. Use `${config:NAME}` placeholders for production
secrets so they don't end up in committed state at all.

**Partial-apply recovery.** If `cococo apply` throws mid-execute
(network blip, server-side validation), state is written with whatever
already succeeded *before* the error is re-thrown. Re-running picks
up exactly where the previous attempt left off — successful creates
aren't redone (so e.g. `controller_token` won't mint duplicates).

**Auxiliary `cococo state` subcommands.**

- `cococo state list-unmanaged` — surface resources on the server
  this workspace isn't managing. Bindings, controller tokens, and
  edge-app installations aren't enumerated (per-parent traversal).
- `cococo state forget <kind> <args>` — stop tracking a resource in
  state without deleting it server-side. Mirrors the `cococo delete`
  vocabulary. Remove the corresponding entry from your config file
  too, otherwise the next apply re-adopts it.
- `cococo state refresh` — re-pull `lastAppliedSpec` from the live
  tenant for every tracked resource. Use after manual server edits
  to re-sync state without applying any local changes.

### Edge cases worth knowing

**Identity comparisons are case-insensitive.** Declarations using
mixed case (`Alice@Acme.com`) get treated the same as lowercased ones
(`alice@acme.com`). Duplicate identities — including case-only
variants — are rejected at parse time with a clear error pointing
at both declarations.

**Renaming a natural key is delete + create.** Changing a user's
email or a policy's handle locally produces `delete old`, `create new`
on the next plan — there's no in-place rename. For policies in
particular, this momentarily breaks any bindings that reference the
old handle. Use `cococo state forget` if you want to hand off an
existing resource to a different identity instead.

**`cococo dump` and state.** Running `cococo dump all -f` rewrites
local config files from the live tenant. Plan after dump will show
zero diff for matched resources, but any drift between dumped files
and state's `lastAppliedSpec` is invisible to plan. Run `cococo state
refresh` after dump if you want state to reflect what's actually on
the server.

**Lock recovery.** A held lock at `.cococo/state.lock` whose owning
process is dead (e.g. someone killed the apply mid-flight) is taken
over automatically by the next apply — no manual cleanup needed. A
lock older than 5 minutes is considered stale and forcibly taken;
override the threshold with `COCOCO_LOCK_TIMEOUT_MS=<n>` in pathological
CI environments.

## Quick start

Sixty seconds from zero to a workspace mirroring your tenant:

```sh
# 1. Get your tenant's GraphQL endpoint URL + an API token.
#    See "Getting your tenant credentials" below if you don't have these.
export COCOCO_ENDPOINT=https://your-tenant.cococo.dev/graphql
export COCOCO_TOKEN=your-bearer-token

# 2. Scaffold a workspace and pull your existing tenant state.
bunx github:wearecococo/dev-cli bootstrap --pull
cd acme-tenant
bun install

# 3. Look at what landed in the repo.
ls *.ts                   # one file per resource kind
cat users.ts              # your existing users (if any)
cat controllers.ts        # your existing controllers (if any)

# 4. Make a small change — e.g. add a new user to users.ts:
#       { email: "newhire@acme.com", name: "New Hire", kind: "HUMAN" }
#    Then re-apply:
bunx cococo apply
# →   user + newhire@acme.com (New Hire)
#     Applied 1 user(s).
```

That's the loop — edit, apply.

For an empty tenant (just signed up, nothing on the server yet), drop
the `--pull` flag and uncomment entries in the generated stubs to
declare your initial state. The [first-time setup
walkthrough](#first-time-setup-walkthrough) below covers that path
end-to-end.

> **Using Claude Code?** Bootstrap also writes a `CLAUDE.md` at the
> repo root that gives the agent a strong mental model of the
> conventions in this CLI. Combined with `cococo setup-mcp claude`
> (which exposes the GraphQL schema as MCP tools), Claude Code can
> author + apply changes for you with full schema awareness.

## Getting your tenant credentials

Two pieces:

- **`COCOCO_ENDPOINT`** — your tenant's GraphQL endpoint, typically of
  the shape `https://<your-tenant>.cococo.dev/graphql`. If you're
  signed in to the dashboard, it's the API base URL exposed under
  **Settings → API**.
- **`COCOCO_TOKEN`** — a bearer token authorizing the CLI to act on
  your behalf. Mint one in the dashboard under **Settings → API
  tokens** (or have an admin mint one for you).

Tokens carry the permissions of their owner — make sure your account
has the IAM permissions for whatever the CLI is going to do. A
read-only token can `dump` and `list`, but not `apply` or `push`.

> **Token safety.** Tokens grant API access — treat them like
> passwords. The bootstrap scaffold gitignores `.env` by default; don't
> commit tokens to your repo.

## Install

The CLI is consumed straight from GitHub. Pin to a tag or commit instead
of `#main` for reproducibility:

```json
// package.json
{
  "devDependencies": {
    "@wearecococo/dev-cli": "github:wearecococo/dev-cli#v0.1.0"
  }
}
```

`bun install` pulls `commander` and `yaml` along with it. Run via
`bunx cococo …` (or `node_modules/.bin/cococo`).

For one-shot use without installing:

```sh
bunx github:wearecococo/dev-cli cococo init com.acme.demo
```

## Configuration

Two env vars, loaded automatically from `.env` by Bun:

```sh
COCOCO_ENDPOINT=https://your-tenant.example.com/graphql
COCOCO_TOKEN=your-bearer-token
```

Override per-invocation with `--endpoint` / `--token`. The bootstrap
scaffold writes a `.env.example` and gitignores `.env` for you.

## First-time setup walkthrough

You've signed up to cococo and want to get your print shop running.
Here's a complete day-one setup: invite an operator, register a
controller, and install an edge app on it.

### Step 1: Bootstrap

```sh
export COCOCO_ENDPOINT=https://acme.cococo.dev/graphql
export COCOCO_TOKEN=...

bunx github:wearecococo/dev-cli cococo bootstrap acme-tenant
cd acme-tenant
cp .env.example .env       # save your env vars for next time
bun install
```

You now have stubs for every kind of tenant resource at the repo root,
plus a `CLAUDE.md` the agent can read for context.

### Step 2: Invite your first operator

Edit `users.ts`:

```ts
import { defineUsers } from "@wearecococo/dev-cli/define";
export default defineUsers([
  { email: "alice@acme.com", name: "Alice Operator", kind: "HUMAN" },
]);
```

Edit `iam_policies.ts`:

```ts
import { defineIAMPolicies } from "@wearecococo/dev-cli/define";
export default defineIAMPolicies([
  {
    handle: "press-operator",
    name: "Press Operator",
    statements: [
      { effect: "ALLOW", actions: ["job:read", "job:transition"], resources: ["*"] },
    ],
  },
]);
```

Edit `iam_policy_bindings.ts`:

```ts
import { defineIAMPolicyBindings } from "@wearecococo/dev-cli/define";
export default defineIAMPolicyBindings([
  { user: "alice@acme.com", policy: "press-operator" },
]);
```

Apply:

```sh
bunx cococo apply
# →   policy + press-operator (Press Operator)
#     user + alice@acme.com (Alice Operator)
#     binding + alice@acme.com → press-operator
```

Alice can now sign in to your tenant with the permissions defined by
`press-operator`.

### Step 3: Register a controller

A controller is a physical or virtual box running the cococo bridge.
To register it you need three things:

1. The controller row itself (handle, host, optional policy)
2. An auth token so the bridge can connect (the CLI mints this)
3. An installation pinning an edge-app version to it (Step 4)

Edit `networks.ts`:

```ts
import { defineNetworks } from "@wearecococo/dev-cli/define";
export default defineNetworks([
  { name: "press-floor", description: "Production floor" },
]);
```

Edit `controllers.ts`:

```ts
import { defineControllers } from "@wearecococo/dev-cli/define";
export default defineControllers([
  {
    handle: "press-01",
    network: "press-floor",
    name: "Press Floor Controller",
    host: "192.168.1.10",
    port: 8443,
    policy: {
      // What the bridge is allowed to read/exec on this controller.
      // Empty list = deny all.
      allowedIoPaths: ["/var/log/door"],
      allowedExecBinaries: ["/usr/bin/ping"],
    },
  },
]);
```

Edit `controller_tokens.ts`:

```ts
import { defineControllerTokens } from "@wearecococo/dev-cli/define";
export default defineControllerTokens([
  { controller: "press-01", name: "primary" },
]);
```

Apply:

```sh
bunx cococo apply
# →   network + press-floor
#     controller + press-01
#       policy + io=1 exec=1
#     token + press-01/primary
#       Connect bundle (save this — never shown again):
#       eyJhbGciOiJSUzI1NiIs...
```

⚠ **Save the connect bundle now.** It's printed once and never
again — the platform doesn't store it. Paste it into the bridge config
on the controller, or pipe to your secret manager. To rotate later:
`cococo delete controller-token press-01 primary` then re-apply.

### Step 4: Install an edge app

This step assumes a `door-monitor` edge app has been authored and
published. If you're starting completely from scratch, see [Authoring
an edge app](#authoring-an-edge-app) below — `cococo init door-monitor
--type edge`, edit handlers, then `cococo push door-monitor && cococo
publish door-monitor`.

Once it's published, edit `edge_app_installations.ts`:

```ts
import { defineEdgeAppInstallations } from "@wearecococo/dev-cli/define";
export default defineEdgeAppInstallations([
  {
    controller: "press-01",
    app: "door-monitor",
    version: 1,
    variables: { LOG_PATH: "/var/log/door" },
  },
]);
```

Apply:

```sh
bunx cococo apply
# →   install + press-01/door-monitor@v1
```

The bridge picks up the new install on its next config push and starts
running the edge app's handlers.

### Recap

After this walkthrough you have:

- A signed-in user with role-based permissions
- A registered controller with an auth token and an installed edge app
- Everything reproducible from the repo

Subsequent changes follow the same loop. Bump the edge-app version in
`edge_app_installations.ts`, re-apply, the bridge upgrades. Add a new
user to `users.ts`, re-apply, they sign in. Out-of-band changes (a
teammate edited something via the dashboard) come back into the repo
with `cococo dump all -f`.

## Tenant config

Tenant configuration lives at the repo root as flat per-kind files.
The bootstrap scaffold generates commented-out stubs for every kind so
you can see the shape and uncomment what you need.

### Users + IAM policies

Three files at the repo root:

```
users.ts                    # who can sign in
iam_policies.ts             # what they can do
iam_policy_bindings.ts      # who has which policy
```

Each one default-exports the result of a `defineX(…)` helper:

```ts
// users.ts
import { defineUsers } from "@wearecococo/dev-cli/define";
export default defineUsers([
  { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
  { email: "bot@acme.com",   name: "Webhook Bot", kind: "BOT", externalId: "svc_001" },
]);
```

```ts
// iam_policies.ts
import { defineIAMPolicies } from "@wearecococo/dev-cli/define";
export default defineIAMPolicies([
  {
    handle: "press-operator",
    name: "Press Operator",
    description: "Run jobs on the press floor",
    statements: [
      { effect: "ALLOW", actions: ["job:read", "job:transition"], resources: ["*"] },
    ],
  },
]);
```

```ts
// iam_policy_bindings.ts
import { defineIAMPolicyBindings } from "@wearecococo/dev-cli/define";
export default defineIAMPolicyBindings([
  { user: "alice@acme.com", policy: "press-operator" },
]);
```

> **Typed refs.** Both `user` and `policy` accept either a string (the
> natural key) or the actual `User` / `IAMPolicy` object. Export your
> users by name and import them here for compile-time typo safety:
>
> ```ts
> // users.ts
> export const alice = { email: "alice@acme.com", name: "Alice", kind: "HUMAN" } as const;
> export default defineUsers([alice]);
>
> // iam_policy_bindings.ts
> import { alice } from "./users.ts";
> import { pressOperator } from "./iam_policies.ts";
> export default defineIAMPolicyBindings([{ user: alice, policy: pressOperator }]);
> ```
>
> The same applies to every cross-resource reference — team members,
> device networks, controller networks, custom-app-binding users/teams,
> installation controllers and bot users. Pass strings when the
> referenced thing only lives on the server, pass typed objects when
> you've declared it locally.

Apply additively:

```sh
bunx cococo apply
# →   policy + press-operator (Press Operator)
#     user + alice@acme.com (Alice)
#     binding + alice@acme.com → press-operator
#     Applied 1 user(s), 1 policy, 1 binding(s).
```

`apply` upserts what's declared and **never deletes** — re-running with
a missing entry leaves the server alone. Remove entries explicitly:

```sh
bunx cococo delete user alice@acme.com
bunx cococo delete policy press-operator
bunx cococo delete iam-policy-binding alice@acme.com press-operator
```

Local files are not edited by `delete` — drop the entry yourself to
keep the next `apply` consistent.

**Resolution rules.** Email is the natural key for users (unique per
tenant); `handle` is a stable custom ID for policies. Bindings reference
by these natural keys, and the loader rejects bindings that point at
entities not declared locally **and** not present on the server.

### Teams + custom-app assignments

Teams group users for collaboration and bulk app assignment. Custom
apps can be assigned to individual users (kiosk mode) or to teams
(non-kiosk visibility filtering on dashboards). Three flat files at
the repo root:

```
teams.ts                            # who's on which team (with inline members)
custom_app_user_bindings.ts         # which user can see which app
custom_app_team_bindings.ts         # which team can see which app
```

```ts
// teams.ts
import { defineTeams } from "@wearecococo/dev-cli/define";
export default defineTeams([
  {
    name: "press-operators",
    description: "Press floor crew",
    members: ["alice@acme.com", "bob@acme.com"],
  },
  { name: "shipping" },           // declare team but skip member reconcile
]);
```

```ts
// custom_app_user_bindings.ts
import { defineCustomAppUserBindings } from "@wearecococo/dev-cli/define";
export default defineCustomAppUserBindings([
  { user: "alice@acme.com", app: "job-board" },
]);
```

```ts
// custom_app_team_bindings.ts
import { defineCustomAppTeamBindings } from "@wearecococo/dev-cli/define";
export default defineCustomAppTeamBindings([
  { team: "press-operators", app: "press-dashboard" },
]);
```

Apply runs in dependency order — users → teams → app bindings — so
member emails and team-name refs resolve before they're needed:

```sh
bunx cococo apply
# →   team + press-operators
#       member + alice@acme.com
#       member + bob@acme.com
#     team + shipping
#     app-user + alice@acme.com → job-board
#     app-team + press-operators → press-dashboard
```

**Two semantics, one command.** Most ops kinds are *additive at the
row level* (declared rows get attached, others left alone). Team
`members` are different: the inline list is the *canonical* membership
for that declared team — if you remove someone from `members`, the
next apply detaches them from that team. The team row itself is still
additive: undeclared teams in `teams.ts` are not deleted from the
server.

| Kind | Apply semantics |
|---|---|
| Team row | Additive — undeclared teams left alone |
| Team `members` | Reconciled within each declared team |
| `CustomAppUserBinding` row | Additive |
| `CustomAppTeamBinding` row | Additive |

**Removals.** `cococo delete team <name>`,
`cococo delete team-member <team> <email>`,
`cococo delete custom-app-user-binding <email> <app>`,
`cococo delete custom-app-team-binding <team> <app>`. Local files are
not edited — drop the entry yourself afterwards.

**Custom-app refs.** `app` references in `custom_app_user_bindings.ts`
and `custom_app_team_bindings.ts` are custom-app handles (matching
`custom_apps/<handle>/manifest.ts`). The app must already exist on the
server (`cococo push <handle>` first); apply doesn't create apps.

### Networks + devices

Networks group IoT controllers, devices, and databases. Devices are
the leaf resources — they belong to a network (optional) and carry
inbound + outbound protocol configs. Same flat-file pattern:

```
networks.ts         # defineNetworks([...])
devices.ts          # defineDevices([...])
```

```ts
// networks.ts
import { defineNetworks } from "@wearecococo/dev-cli/define";
export default defineNetworks([
  { name: "press-floor", description: "Production floor" },
  { name: "office" },
]);
```

```ts
// devices.ts
import { defineDevices } from "@wearecococo/dev-cli/define";
export default defineDevices([
  {
    identifier: "press-01",
    network: "press-floor",     // ref to networks.ts by name
    name: "Heidelberg Press",
    manufacturer: "Heidelberg",
    outboundProtocols: [
      {
        kind: "HTTP",
        url: "https://press-01.local/api",
        authMode: "BASIC",
        username: "ops",
        password: "${config:PRESS_01_HTTP_PASSWORD}",
      },
      {
        kind: "SQL",
        adapter: "POSTGRESQL",
        host: "press-01.local",
        port: 5432,
        databaseName: "metrics",
        username: "reader",
      },
    ],
    inboundProtocols: [
      { kind: "MQTT", topic: "press/01/telemetry" },
      { kind: "HTTP", webhookPath: "/hooks/press-01" },
    ],
  },
]);
```

Apply pushes them in dependency order (policies → users → bindings →
networks → devices):

```sh
bunx cococo apply
# →   network + press-floor
#     network + office
#     device  + press-01 → press-floor
```

**Discriminated protocol unions.** Each `outboundProtocols[*]` entry is
a discriminated union over `kind` — only the fields that apply to that
protocol typecheck:

| Kind | Required | Optional |
|---|---|---|
| `HTTP` | `url` | `authMode`, `username`, `password`, `label` |
| `JMF`  | `url` | `label` |
| `MQTT` | `url`, `topic` | `authMode`, `username`, `password`, `label` |
| `SQL`  | `adapter` | `host`, `port`, `databaseName`, `username`, `password`, `connectionString`, `url` (SQLite path), `label` |

`inboundProtocols[*]` likewise:

| Kind | Required |
|---|---|
| `MQTT` | `topic` |
| `HTTP` | `webhookPath` |

A typo or wrong-field combination is a compile error, not a server reject.

**Secrets.** `password` and `connectionString` are write-only on the
server — `dump` substitutes `${config:NAME}` placeholders for them.
Use literal values for quick setup, or `${config:NAME}` template
strings to defer the value to per-installation tenant config.

**Removals.** `cococo apply` is additive. Use
`cococo delete network <name>` or `cococo delete device <identifier>`
to take rows off the server, then drop the local entry to keep the
next apply consistent.

### Controllers, tokens, edge-app installations

Edge apps run on **controllers** (the boxes hosting the bridge). To
actually install an edge app on a controller, you need three things in
sequence:

1. The controller exists, with an IO/exec policy that allows what the
   edge app needs to do.
2. A token has been minted so the bridge can authenticate.
3. An installation pinning a specific edge-app version to that
   controller, with per-installation `variables`.

Three flat files at the repo root cover all of it:

```
controllers.ts                 # defineControllers([...]) — with inline policy
controller_tokens.ts           # defineControllerTokens([...])
edge_app_installations.ts      # defineEdgeAppInstallations([...])
```

```ts
// controllers.ts
import { defineControllers } from "@wearecococo/dev-cli/define";
export default defineControllers([
  {
    handle: "press-01",
    network: "press-floor",
    name: "Press Floor Controller",
    host: "192.168.1.10",
    port: 8443,
    policy: {
      // Both lists are reconciled wholesale — what's listed is
      // exactly what the bridge gets. Empty list = deny all.
      allowedIoPaths: ["/var/log/door"],
      allowedExecBinaries: ["/usr/bin/ping"],
    },
  },
]);
```

```ts
// controller_tokens.ts
import { defineControllerTokens } from "@wearecococo/dev-cli/define";
export default defineControllerTokens([
  { controller: "press-01", name: "primary" },
  { controller: "press-01", name: "backup", description: "Standby" },
]);
```

```ts
// edge_app_installations.ts
import { defineEdgeAppInstallations } from "@wearecococo/dev-cli/define";
export default defineEdgeAppInstallations([
  {
    controller: "press-01",
    app: "door-monitor",          // edge-app handle
    version: 3,                    // pin to a specific PUBLISHED version
    botUser: "bot@acme.com",       // for bridge.graphql calls
    variables: {
      LOG_PATH: "/var/log/door",
    },
  },
]);
```

Apply chains the whole sequence in dependency order (controllers →
tokens → installations):

```sh
bunx cococo apply
# →   controller + press-01
#       policy + io=1 exec=1
#     token + press-01/primary
#       Connect bundle (save this — never shown again):
#       eyJhbGciOiJSUzI1NiIs…
#     install + press-01/door-monitor@v3
```

| Resource | Apply semantics |
|---|---|
| Controller row | Additive |
| Controller `policy` (inline) | Reconciled — both lists wholesale-replaced from the spec |
| Controller token | **Create-only with existence check** — non-revoked tokens with the same `(controller, name)` skip; missing ones get minted, and the connect bundle prints once |
| Edge-app installation | Smart upsert — exact-version match updates variables; older version of the same handle on the same controller triggers `upgrade`; otherwise creates fresh |

**The connect bundle is one-shot.** When apply mints a new token, it
prints a Base64-encoded JSON connect bundle to stdout. The platform
never returns it again — pipe to a secret manager, paste into the
bridge config, then move on:

```sh
bunx cococo apply | tee apply.log
# extract the bundle from apply.log, save somewhere durable
```

**Edge-app version pinning.** `version` is an integer matching a
PUBLISHED row of the edge app on the server. Apply rejects
installations that target DRAFT rows (those aren't shippable). To
upgrade an existing install, bump `version` in
`edge_app_installations.ts` and re-apply — the loop detects the
older-version install on the same controller and calls
`upgradeEdgeAppInstallation`, preserving the install's id and any
non-overwritten state.

**Removals.** `cococo delete controller <handle>`,
`cococo delete controller-token <controller> <name>` (revoke), and
`cococo delete edge-app-installation <controller> <app> <version>`.
Local files aren't edited — drop the entry afterwards.

## Building extensions

Extensions are the things you build on top of cococo — the
**integrations**, **custom apps**, and **edge apps** referenced from
the tenant-config files. Each lives in its own folder, with a
`manifest.ts` plus any associated source files.

### Authoring an integration

`cococo init <reverse-domain-id>` scaffolds a folder under
`integrations/<short-name>/`:

```
integrations/orders/
├── manifest.ts
└── handlers/
    └── timers/
        └── heartbeat.lua
```

The `manifest.ts` is just TypeScript — you get completion and
diagnostics on every field as you type:

```ts
import { defineIntegration, lua, luaFile } from "@wearecococo/dev-cli/define";

export default defineIntegration({
  id: "com.acme.orders",
  version: "0.1.0",
  sdkVersion: "1.0",
  runtimeMode: "script_actor",
  resources: [],
  permissions: [],

  // Short Lua snippets inline:
  initSource: lua`
    local config = ...
    ctx.log.info("starting against " .. config.api_url)
  `,

  // Anything longer in its own .lua file (path is relative to manifest.ts):
  timers: [
    { name: "tick", every: "1m", source: luaFile("./handlers/timers/tick.lua") },
  ],
  subscriptions: [
    { topic: "jobs.created", source: luaFile("./handlers/subscriptions/jobs.created.lua") },
  ],

  // Reusable helpers loaded at runtime via `ctx.script.load("name")`:
  libraries: {
    http_helpers: luaFile("./libraries/http_helpers.lua"),
  },
});
```

`luaFile()` paths can point anywhere in the folder, but the scaffold and
`cococo pull` use these conventions:

| Manifest field            | On-disk file                            |
|---------------------------|-----------------------------------------|
| `initSource`              | `lifecycle/init.lua`                    |
| `shutdownSource`          | `lifecycle/shutdown.lua`                |
| `upgradeSource`           | `lifecycle/upgrade.lua`                 |
| `timers[*].source`        | `handlers/timers/<name>.lua`            |
| `subscriptions[*].source` | `handlers/subscriptions/<topic>.lua`    |
| `libraries.<name>`        | `libraries/<name>.lua`                  |

Files under `handlers/`, `lifecycle/`, and `libraries/` ship inside the
manifest payload; they're not separate bundle uploads. Anything else you
add in the folder (`scripts/`, `app/`, `workflows/`, `config_schema.json`,
`policy.yaml`) travels as a bundle file.

Push it:

```sh
bunx cococo push orders
```

### Authoring a custom app

Custom apps live under `custom_apps/<handle>/` peer to `integrations/`,
with the same TypeScript-first shape but only three "source slots": a
Vue template, a client script, and an optional Lua RPC server.

```sh
bunx cococo init job-board --type app
```

Scaffolds:

```
custom_apps/job-board/
├── manifest.ts
├── template.vue       # Vue HTML rendered in the iframe
├── script.js          # client-side JS
└── server.lua         # optional Lua RPC handlers
```

```ts
import { defineCustomApp, file, luaFile } from "@wearecococo/dev-cli/define";

export default defineCustomApp({
  handle: "job-board",
  name: "Job Board",
  kind: "PAGE",                            // PAGE | DASHBOARD | KIOSK | JOB_VIEW
  template: file("./template.vue"),
  script: file("./script.js"),
  serverApi: luaFile("./server.lua"),      // omit if no RPC handlers
});
```

`file()` reads any text file (HTML, JS, JSON); `luaFile()` is for Lua
specifically — `cococo lint` validates it under the `CUSTOM_APP` role.

Custom apps don't use semver. The platform stores a single working copy
keyed by handle, plus immutable version snapshots:

```sh
bunx cococo push job-board       # upserts the working copy
bunx cococo publish job-board    # snapshots + publishes in one step
# → job-board: published v3 (cap_xyz)
```

### Authoring an edge app

Edge apps are tenant-scoped templates that get installed on **controllers**
in the print shop — local hardware running the cococo bridge. They're
identified by handle, follow a **DRAFT → PUBLISHED → DEPRECATED**
lifecycle, and version with monotonic Ints managed by the platform.

```sh
bunx cococo init door-monitor --type edge
```

Scaffolds:

```
edge_apps/door-monitor/
├── manifest.ts
└── handlers/
    └── heartbeat.lua
```

The manifest is TypeScript with shape-checked triggers and handler refs:

```ts
import { defineEdgeApp, lua, luaFile } from "@wearecococo/dev-cli/define";

export default defineEdgeApp({
  handle: "door-monitor",
  name: "Door Monitor",
  description: "Watches a folder for door events",
  logLevel: "INFO",

  // Map of handler name → Lua source.
  handlers: {
    onDoor: luaFile("./handlers/onDoor.lua"),
    heartbeat: luaFile("./handlers/heartbeat.lua"),
  },

  // Triggers reference handlers by name. Two compile-time guarantees:
  //   1. `handler` is constrained to a key of `handlers` (no typos).
  //   2. The shape required for each `kind` is enforced (CRON wants
  //      `schedule`; FILE_CREATED wants `path`; etc).
  triggers: [
    { kind: "CRON",         name: "tick",    handler: "heartbeat",
      schedule: "*/5 * * * *" },
    { kind: "FILE_CREATED", name: "doorEvt", handler: "onDoor",
      path: "/var/log/door", pattern: "*.evt" },
  ],

  // Reusable Lua loaded by handlers via `bridge.loadLib(name)`.
  libraries: {
    formatters: luaFile("./libraries/formatters.lua"),
  },

  // Lua entry for `local.edgeApp.invoke` cloud calls.
  onMessage: lua`
    local payload = ...
    bridge.log.info("invoked: " .. payload.kind)
  `,
});
```

Trigger kinds: `CRON` (scheduled), `TAIL` (per-line file tail),
`FILE_CREATED` / `FILE_DELETED` (file-watch with optional glob).

Push upserts the DRAFT (one DRAFT per `(tenant, handle)`):

```sh
bunx cococo push door-monitor
```

Publish flips the DRAFT → PUBLISHED and auto-deprecates the prior
PUBLISHED:

```sh
bunx cococo publish door-monitor
# → door-monitor: published v3 (eaa_xyz). Prior PUBLISHED auto-deprecated.
```

Lua handlers / libraries / `onMessage` validate under the **`EDGE_APP`**
role automatically — `bridge.*` APIs are visible, `ctx.integration.*`
is not.

#### External I/O config

Edge apps can declare external connections to MQTT brokers, OPC UA
endpoints, SNMP devices, Modbus ports, exec commands, and HTTP inbound
routes. Each has its own array on the manifest:

```ts
export default defineEdgeApp({
  handle: "press-monitor",
  name: "Press Monitor",
  handlers: { onTemp: luaFile("./handlers/onTemp.lua") },
  triggers: [],

  mqttBrokers: [
    {
      name: "site",
      url: "mqtt://broker.site:1883",
      // ${config:NAME} resolves per-installation; never log it.
      password: "${config:MQTT_PASSWORD}",
      subscriptions: [{ topic: "press/+/temp", handler: "onTemp" }],
    },
  ],

  opcuaEndpoints: [
    {
      name: "press",
      endpoint: "opc.tcp://press:4840",
      subscriptions: [{ nodeId: "ns=2;s=PressTemp", handler: "onTemp" }],
      auth: { mode: "USERNAME", username: "monitor", password: "${config:OPC_PWD}" },
      security: { policy: "NONE", mode: "NONE" },
    },
  ],

  modbusPorts: [
    {
      transport: "TCP",
      name: "plc1",
      host: "10.0.0.1",
      slaves: [{ name: "main", unitId: 1, pollGroups: [/* ... */] }],
    },
  ],

  httpRoutes: [
    {
      method: "POST",
      path: "/webhook",
      handler: "onTemp",
      auth: { mode: "BEARER", bearerTokens: ["${config:HOOK_TOKEN}"] },
    },
  ],

  // …plus snmpDevices, execCommands as needed.
});
```

The TS shapes are **discriminated unions** — the compiler enforces:

- `auth.mode === "USERNAME"` requires `username` + `password` (OPC UA)
- `auth.mode === "BASIC"` requires `basicCredentials`, `BEARER` requires `bearerTokens` (HTTP routes)
- `transport: "TCP"` requires `host`, `transport: "RTU"` requires `serialPath` + serial fields (Modbus)
- `version: "V2C"` uses `community`, `version: "V3"` requires the `v3` block (SNMP)
- And every `handler` field — across MQTT subscriptions, OPC UA subscriptions, SNMP poll groups, Modbus poll groups, HTTP routes — is constrained to a key of `handlers`

Secret-bearing string fields (passwords, PEMs, bearer tokens, SNMP keys)
accept literal values **or** `${config:NAME}` templates that resolve to
per-installation variables — the CLI never sees the resolved values, so
secrets stay on the controller side.

See the platform docs for the full per-protocol field reference.

### Authoring a workflow

Workflows are declarative node-and-edge DAGs that run in the cloud.
Unlike integrations, you don't write the per-step code — each node is a
typed step (HTTP call, Lua transform, branch, delay, etc.) configured
through its `config` object, and the platform's per-node JSON Schema is
the source of truth for what's valid.

A workflow has a mutable row plus immutable version snapshots: `push`
creates a new version, `publish` flips the active pointer to the latest
version. Triggers (cron, event, webhook, device MQTT, edge-app event)
live on the workflow row and reconcile by `(workflow, name)`.

```sh
bunx cococo init nightly-rollup --type workflow
```

Scaffolds:

```
workflows/nightly-rollup/
└── manifest.ts
```

The manifest is TypeScript:

```ts
import { defineWorkflow, luaFile } from "@wearecococo/dev-cli/define";

export default defineWorkflow({
  handle: "nightly-rollup",
  displayName: "Nightly Rollup",
  description: "Aggregates daily metrics overnight.",
  isActive: true,

  variables: [
    { name: "lookbackDays", type: "number", defaultValue: 7 },
  ],

  // Nodes: stable id + type + opaque config. Server-validated against
  // the per-node JSON Schema. Code-bearing slots (e.g. a lua_script
  // node's `source`) accept luaFile() refs and are inlined on push.
  nodes: [
    { id: "start", name: "Start", type: "trigger", config: {} },
    {
      id: "transform",
      name: "Transform",
      type: "lua_script",
      config: { source: luaFile("./scripts/transform.lua") },
    },
  ],
  edges: [
    { id: "e1", from: "start", to: "transform" },
  ],

  // Triggers — discriminated on `kind`:
  //   { kind: "scheduled",   cronExpression, overlapPolicy, timezone? }
  //   { kind: "event",       topic, filter?, dataQuery? }
  //   { kind: "webhook",     path, method, authRequired }
  //   { kind: "deviceMqtt",  topic, deviceId?, filter? }
  //   { kind: "edgeAppEvent", topic?, controllerId?, edgeAppHandle? }
  triggers: [
    {
      name: "nightly",
      config: {
        kind: "scheduled",
        cronExpression: "0 2 * * *",
        overlapPolicy: "SKIP",
        timezone: "UTC",
      },
    },
  ],
});
```

`cococo lint nightly-rollup` server-validates the definition against
the platform's JSON Schema before pushing. `cococo push nightly-rollup`
runs the same validation, creates or updates the workflow row, snapshots
a new version, and reconciles triggers. `cococo publish nightly-rollup`
flips the active version pointer to the latest snapshot.

`cococo pull nightly-rollup --type workflow` materialises the active
version + triggers from the server back into a local manifest. Removed
locally? `cococo delete workflow nightly-rollup` drops the row on the
server.

### Typed node configs

Picking a `node.type` literal narrows `config` to the registered shape
— `defineWorkflow({ nodes: [{ type: "http_request", config: {...} }] })`
gets autocomplete and compile-time errors on missing required fields,
wrong enum values, and unknown keys. Same typing applies to
standalone `defineNode({...})` objects, so you can build a node
library and insert nodes into multiple workflows.

```ts
import { defineNode, defineWorkflow, luaFile } from "@wearecococo/dev-cli/define";

const fetchOrders = defineNode({
  id: "fetch", name: "Fetch orders", type: "http_request",
  config: { deviceId: "dev_xyz", method: "GET", path: "/orders" },
});

const transform = defineNode({
  id: "transform", name: "Transform", type: "script",
  // `inline` accepts a string OR a luaFile() ref; the loader inlines
  // the file content on push.
  config: { inline: luaFile("./scripts/transform.lua") },
});

export default defineWorkflow({
  handle: "nightly-rollup",
  nodes: [fetchOrders, transform],
  edges: [{ id: "e1", from: "fetch", to: "transform" }],
});
```

The CLI ships a baseline registry covering all current node types —
`cococo update` is only needed if your tenant has drifted from the
baseline (newer server, tenant-specific custom nodes). When that
happens, run `cococo update` to write workspace overrides into
`.cococo/generated/node-types.d.ts`; add `cococo update --check` to
your CI to catch stale workspace files.

## Daily workflow

Once the workspace is set up, day-to-day work looks like:

```sh
# Tenant-config changes
bunx cococo dump all -f                     # pull what's currently on the server
# …edit users.ts / controllers.ts / etc.
bunx cococo apply                           # push your changes

# Artifact changes (one folder)
bunx cococo status orders                   # diff local vs remote, read-only
bunx cococo lint orders                     # validate every Lua chunk
bunx cococo lint orders --strict            # warnings as errors (CI mode)
bunx cococo push orders                     # mirror local → remote (runs lint first)
bunx cococo publish orders                  # validate + publish

# Artifact changes across the whole repo
bunx cococo lint --all                      # aggregate findings, exit non-zero on any error
bunx cococo validate --all                  # server-validate every integration draft
bunx cococo push --all                      # push every artifact (stops on first failure)
bunx cococo publish --all                   # publish every artifact (stops on first failure)

# Pulling artifacts
bunx cococo pull com.acme.orders            # download integration draft
bunx cococo pull job-board --type app       # download custom-app working copy
bunx cococo pull door-monitor --type edge   # download edge-app DRAFT

# Visibility
bunx cococo list                            # all integrations + apps + edge apps
```

`--all` walks `integrations/`, `custom_apps/`, and `edge_apps/`. **push**
and **publish** stop on the first failure (server-mutating); **lint**
and **validate** keep going and aggregate (read-only).

### Lua validation

`cococo lint` calls the platform's Lua validator on every chunk in your
folder:

- **Files** — every `.lua` file walked.
- **Inline snippets** — every `` lua`...` `` template literal on a TS
  manifest.
- **Role-aware** —
  - `INTEGRATION`: integration handlers, libraries, lifecycle hooks,
    `scripts/*.lua` helpers.
  - `CUSTOM_APP`: integration `app/**` and custom-app `server.lua`.
  - `EDGE_APP`: everything in an `edge_apps/<handle>/` folder
    (handlers, libraries, `onMessage`).

  The role determines which `ctx.*` / `bridge.*` APIs are visible.

Diagnostics carry line, column, severity, and Luau error code:

```
handlers/timers/tick.lua:5:12        ERROR    unknown ctx.bogus.api  [LU0042]
manifest.ts:initSource:3:5           WARNING  unused local "x"
app/server.lua:8:1                   ERROR    ctx.integration not available in CUSTOM_APP role
```

`cococo push` runs the same pass first; `--strict` fails on warnings.

## Migrating v1 integrations

If you have an existing `manifest.yaml` + `scripts/main.lua` integration
on `engineVersion: 1`, `cococo migrate` forks it into a v2 TypeScript
sibling — Claude Code refactors the entry script into per-handler files:

```sh
bunx cococo migrate orders
# → integrations/orders_v2/  (version 0.1.0 → 0.2.0)
```

What happens:

1. **Fork** — copies bundle artefacts (config schema, policy, workflows,
   `app/`, `scripts/<other>.lua` helpers) to `integrations/orders_v2/`,
   omitting `manifest.yaml` and `scripts/main.lua`.
2. **Skeleton** — writes a v2 `manifest.ts` with placeholder handler
   files for each timer / subscription declared in the v1 manifest.
3. **Refactor** — shells out to `claude -p` with a structured prompt;
   Claude rewrites `scripts/main.lua` into per-handler files, lifts
   shared helpers into `libraries/`, and adds `initSource` /
   `shutdownSource` if the v1 script had them.
4. **Lint** — validates the result via `cococo lint`.

The original v1 folder is untouched. Review the diff in `_v2/`, then
`rm -rf` the old folder and rename when you're happy. If `claude` isn't
on PATH, you get the skeleton plus a self-contained prompt at
`_v2/.cococo-migrate-prompt.txt` to run manually.

## Reference

### Project layout

```
<your-repo>/
├── integrations/
│   └── <name>/                            # one folder per integration
│       ├── manifest.ts                    # canonical
│       ├── handlers/                      # luaFile() targets — manifest payload
│       │   ├── timers/<name>.lua
│       │   └── subscriptions/<topic>.lua
│       ├── lifecycle/                     # luaFile() targets — manifest payload
│       │   ├── init.lua
│       │   ├── shutdown.lua
│       │   └── upgrade.lua
│       ├── libraries/<name>.lua           # luaFile() targets — manifest payload
│       ├── scripts/<other>.lua            # bundle scripts (ctx.script.load helpers)
│       ├── app/                           # optional embedded sub-app (bundle)
│       ├── config_schema.json             # optional
│       ├── policy.yaml                    # optional
│       └── workflows/*.yaml               # optional
├── custom_apps/
│   └── <handle>/                          # one folder per custom app
│       ├── manifest.ts
│       ├── template.vue
│       ├── script.js
│       └── server.lua                     # optional
└── edge_apps/
    └── <handle>/                          # one folder per edge app
        ├── manifest.ts
        ├── handlers/<name>.lua
        ├── libraries/<name>.lua           # optional
        └── onMessage.lua                  # optional

# Tenant config lives at the repo root as flat per-kind files:
users.ts                                   # defineUsers([...])
iam_policies.ts                            # defineIAMPolicies([...])
iam_policy_bindings.ts                     # defineIAMPolicyBindings([...])
networks.ts                                # defineNetworks([...])
devices.ts                                 # defineDevices([...])
teams.ts                                   # defineTeams([...])
custom_app_user_bindings.ts                # defineCustomAppUserBindings([...])
custom_app_team_bindings.ts                # defineCustomAppTeamBindings([...])
controllers.ts                             # defineControllers([...])
controller_tokens.ts                       # defineControllerTokens([...])
edge_app_installations.ts                  # defineEdgeAppInstallations([...])

# Plus, written by `cococo bootstrap`:
.env.example                               # COCOCO_ENDPOINT/TOKEN template
.gitignore                                 # ignores .env, node_modules, dist
tsconfig.json
package.json
CLAUDE.md                                  # context for Claude Code (delete if not using)
```

### Commands

| Command | Purpose |
|---|---|
| `cococo bootstrap [folder] [--pull]` | Scaffold a fresh workspace: package.json, .env.example, tsconfig, ops stubs, CLAUDE.md. `--no-claude-md` to skip the project guide. `--pull` also dumps existing tenant state into the ops files |
| `cococo claude-md [folder]` | Add (or `--force` refresh) the CLAUDE.md project guide in an existing workspace |
| `cococo dump <kind\|all> [-f]` | Download tenant ops state from the server into local files. Kinds: `users`, `policies`, `iam-policy-bindings`, `networks`, `devices`, `teams`, `custom-app-user-bindings`, `custom-app-team-bindings`, `controllers`, `edge-app-installations`, `all`. Tokens excluded; write-only secrets emit `${config:NAME}` placeholders |
| `cococo init <id>` | Scaffold an integration under `integrations/<short-name>/` |
| `cococo init <handle> --type app` | Scaffold a custom app under `custom_apps/<handle>/` |
| `cococo init <handle> --type edge` | Scaffold an edge app under `edge_apps/<handle>/` |
| `cococo init <handle> --type workflow` | Scaffold a workflow under `workflows/<handle>/` |
| `cococo push [folder\|--all] [--strict]` | Mirror local → remote (runs lint first). `--all` walks every artifact and stops on first failure |
| `cococo status [folder]` | Diff local vs remote (read-only) |
| `cococo lint [folder\|--all] [--strict]` | Validate every Lua chunk via the server. `--all` walks every artifact, aggregates findings, exits non-zero if any failed |
| `cococo validate [folder\|--all]` | Server-validate the remote draft (integrations only). `--all` validates every integration, aggregates results |
| `cococo publish [folder\|--all]` | Integrations: DRAFT → ACTIVE. Custom apps: snapshot working copy + publish. Edge apps: DRAFT → PUBLISHED (auto-deprecates prior PUBLISHED). `--all` publishes every artifact, stops on first failure |
| `cococo deprecate [folder]` | Retire the PUBLISHED definition. Integrations: ACTIVE → DEPRECATED. Edge apps: PUBLISHED → DEPRECATED. Existing installations keep working until upgraded. Custom apps don't apply |
| `cococo apply [--yes] [--allow-destroy]` | Apply tenant ops files at the repo root. Default mode is **additive** — declared rows upsert, undeclared rows untouched. With a `.cococo/state.json` (created by `cococo state import`), switches to **state-tracking** mode where removing a row from a config file deletes it server-side; deletes require `--allow-destroy` |
| `cococo plan [--json] [--verbose]` | Read-only preview of the next state-tracking apply. Requires a state file (run `cococo state import` first) |
| `cococo state import [--yes] [--force]` | Bootstrap `.cococo/state.json` from the live tenant. Adopts every declared resource that already exists on the server; declared-but-absent rows will be created on the next apply. Run once per workspace to opt into state-tracking |
| `cococo state list-unmanaged` | List resources on the server that aren't tracked in this workspace's state. Useful for adoption audits |
| `cococo state forget <kind> <args>` | Stop tracking a resource in state without deleting it server-side. Mirrors `cococo delete` kinds |
| `cococo state refresh` | Re-pull `lastAppliedSpec` from the live tenant for every tracked resource. Use after manual server edits to re-sync state |
| `cococo delete <kind> <args>` | Remove a tenant ops resource. Kinds: `user <email>`, `policy <handle>`, `iam-policy-binding <email> <policy>`, `network <name>`, `device <identifier>`, `team <name>`, `team-member <team> <email>`, `custom-app-user-binding <email> <app>`, `custom-app-team-binding <team> <app>`, `controller <handle>`, `controller-token <controller> <name>`, `edge-app-installation <controller> <app> <version>`, `workflow <handle>` |
| `cococo pull <id\|handle> [--type app\|edge\|workflow] [-f]` | Download remote into a local folder |
| `cococo list` | List integrations, custom apps, and edge apps on the server |
| `cococo update [--check] [--only <syncer>]` | Re-sync schema-driven generated types in `.cococo/generated/`. The shipped baseline covers the standard 30+ workflow node types out of the box; this command writes workspace overrides when your tenant has drifted (newer server, custom node configs). `--check` exits non-zero in CI when files are stale |
| `cococo migrate [folder]` | Fork a v1 YAML integration to a v2 TS sibling (uses Claude Code) |
| `cococo setup-mcp claude` | Register the cococo MCP endpoint with Claude Code |
| `cococo mcp swagger <path>` | Run a stdio MCP server over an OpenAPI spec |
| `cococo mcp add <path>` | Register the swagger MCP server with Claude Code |

`cococo --help` and `cococo <cmd> --help` list every flag.

### Engine versions

- **v2** is the default for new authoring of both integrations and custom
  apps. TS manifest, materialised handler files, `lua` / `luaFile()`
  helpers.
- **v1** integrations are still supported for existing folders via
  `manifest.yaml` (entry-script + global `exports` table). New drafts
  default to v2 — see [Migrating v1 integrations](#migrating-v1-integrations).
- **v1 custom apps** are not authored through this CLI; the platform
  defaults new apps to v2.

### YAML manifests (integrations only)

For existing v1 folders or anyone who prefers YAML, `manifest.yaml`
mirrors the platform's `IntegrationManifest` shape (snake_case). The CLI
adds one local-only key — `engine_version: 1 | 2` — so push/pull
round-trip cleanly. A folder can have **either** `manifest.ts` or
`manifest.yaml`, never both.

To opt into YAML:

```sh
bunx cococo init com.acme.foo --format yaml
bunx cococo pull com.acme.foo --format yaml
```

For v2 YAML, the source files at the conventional paths bind to manifest
entries by convention (e.g. `handlers/timers/tick.lua` → the timer named
`tick`). Stray files, duplicate timer names, and v2-only keys on a v1
manifest all fail loudly at push time.

### Embedded sub-apps inside integrations

An integration can ship its own widget under `app/`:

- `app/index.html` — Vue template
- `app/script.js` — client script
- `app/server.lua` — optional Lua RPC

These travel as part of the integration bundle (no separate manifest
declaration). Different from a top-level **custom app** — those are
reusable across the tenant, addressable by handle, and live under
`custom_apps/`.

## Notes & limitations

- **Drafts and working copies only.** This CLI doesn't touch integration
  *instances*, config bindings, or runtime state — those are managed
  elsewhere.
- **No watch / dev mode.** Push manually after edits. (Planned.)
- **Custom apps are v2-only here.** v1 custom apps exist on the platform
  but aren't authored through this CLI.
- **Connect bundles aren't recoverable.** When `apply` mints a new
  controller token, the bundle is printed once and never returned again.
  Save it before the next command runs, or you'll have to revoke and
  re-mint.

## Hacking on the CLI itself

```sh
git clone https://github.com/wearecococo/dev-cli
cd dev-cli
bun install
bun link             # exposes `cococo` on PATH from src/index.ts
bun test             # unit tests (no network)
bun run typecheck
COCOCO_INTEGRATION_TEST=1 bun run test:integration  # full lifecycle, real tenant
```

The integration test creates a `custom.cli-test-<ts>` integration per
run and walks init → push → status → validate → publish → pull. Run it
against a disposable tenant — drafts can't be deleted via the public
API, so each run leaks one definition.

`bun unlink` to remove the local link.
