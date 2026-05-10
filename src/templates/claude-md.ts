/**
 * The CLAUDE.md template emitted by `cococo bootstrap` and
 * `cococo claude-md`. Kept as a TS string export rather than a
 * sibling .md file so package consumers get it via the CLI without
 * extra files-to-include rules in package.json.
 *
 * The content is opinionated: it tells Claude Code what's in the repo,
 * which command to use when, and where the GraphQL schema docs are.
 * Edit when the CLI surface changes — these instructions outlive any
 * specific Claude session.
 */

export const CLAUDE_MD_TEMPLATE = `# Working with this repo (notes for Claude Code)

This is a **cococo platform** repo — authored locally, applied to a
tenant via the \`@wearecococo/dev-cli\` CLI (\`bunx cococo …\`).

## What's in here

Four kinds of *artifacts* (each in its own folder, with a
\`manifest.ts\` and any Lua/HTML files):

\`\`\`
integrations/<short-name>/        # background workers + handlers
custom_apps/<handle>/             # user-facing pages/dashboards
edge_apps/<handle>/               # apps that run on a controller
workflows/<handle>/               # node-and-edge DAGs (cron / event / webhook / device-MQTT triggers)
\`\`\`

Plus *tenant configuration* as flat per-kind files at the **repo
root** (additive — won't delete anything you don't declare):

\`\`\`
users.ts                          # who can sign in
iam_policies.ts                   # what they can do
iam_policy_bindings.ts            # which user has which policy

networks.ts                       # logical groupings of devices/controllers
devices.ts                        # IoT devices

teams.ts                          # who's on which team (with inline members)
custom_app_user_bindings.ts       # which user can see which custom app
custom_app_team_bindings.ts       # which team can see which custom app

controllers.ts                    # bridge boxes (with inline IO/exec policy)
controller_tokens.ts              # auth bundles for the bridge
edge_app_installations.ts         # pin (controller, edge-app, version)
\`\`\`

Each one default-exports the result of a \`defineX(…)\` helper from
\`@wearecococo/dev-cli/define\`. Skim that module for the exact shape
of every spec before authoring — it's hand-typed and authoritative.

## Core commands

\`\`\`sh
bunx cococo init <id|handle> [--type integration|app|edge|workflow]    # scaffold an artifact folder
bunx cococo push <folder|--all> [--strict]                    # mirror local → remote (lints first)
bunx cococo lint <folder|--all> [--strict]                    # validate Lua via the server
bunx cococo validate <folder|--all>                           # server-validate the remote draft
bunx cococo publish <folder|--all>                            # ship: DRAFT → PUBLISHED (workflows: flip active version pointer)
bunx cococo deprecate <folder>                                # retire PUBLISHED → DEPRECATED (integrations + edge apps)
bunx cococo pull <id|handle> [--type app|edge|workflow] [-f]  # download remote → local
bunx cococo apply                                             # apply tenant ops files
bunx cococo delete <kind> <args>                              # remove a tenant ops resource
bunx cococo dump <kind|all>                                   # pull server state into local ops files
bunx cococo list                                              # what's on the server
\`\`\`

\`--all\` walks \`integrations/\`, \`custom_apps/\`, \`edge_apps/\`, and \`workflows/\`.
**push** and **publish** stop on the first failure (server-mutating);
**lint** and **validate** keep going and aggregate (read-only).

\`cococo --help\` and \`cococo <cmd> --help\` cover every flag.

## When to use what

- **Adding/changing an artifact** (integration / custom app / edge
  app): edit the folder, run \`push\`, then \`publish\` when ready.
- **Inviting someone, granting access, defining a team, registering a
  controller, installing an edge app on it:** edit the relevant ops
  file at the repo root, run \`apply\`.
- **Removing a tenant ops resource:** \`delete\` (apply is additive
  by design).
- **Bootstrapping a controller for the first time:** declare it in
  \`controllers.ts\`, declare a token in \`controller_tokens.ts\`,
  run \`apply\` — the connect bundle prints once on creation. Save it
  (it's never returned again).
- **Upgrading an edge-app install on a controller:** bump \`version\`
  in \`edge_app_installations.ts\` and re-apply. The CLI detects the
  older install and calls \`upgradeEdgeAppInstallation\` for you.

## Apply: additive vs state-tracking

\`cococo apply\` runs in one of two modes depending on whether
\`.cococo/state.json\` exists:

- **Additive** (default, no state file): declared rows upsert,
  undeclared rows untouched, removals require \`cococo delete\`.
- **State-tracking** (after \`cococo state import\`): removing a row
  from a config file deletes it server-side on next apply. Use
  \`cococo plan\` to preview, \`cococo apply --allow-destroy\` to
  permit deletions, \`--yes\` to skip the confirmation prompt.

State-tracking only manages resources you've explicitly adopted
(\`state import\` matches declarations against the live tenant). Rows
created in the dashboard or by other workspaces stay unmanaged.

### Apply semantics — three flavors

Most rows are **additive** (declared rows get upserted, undeclared
ones left alone). A few aren't:

| Resource | Semantics |
|---|---|
| Most rows (users, policies, networks, devices, teams, controllers, app bindings, etc.) | Additive |
| Team \`members\` (inline) | Reconciled within each declared team |
| Controller \`policy\` (inline) | Reconciled — both allowlists wholesale-replaced |
| Controller tokens | Create-only with existence check; connect bundle prints once |
| Edge-app installations | Smart upsert — exact match / upgrade / create |

When in doubt, re-read the README's "Apply semantics" tables — they
spell it out per resource.

## Looking up GraphQL schema details

The cococo MCP server is connected (set up via
\`cococo setup-mcp claude\`). Use it instead of guessing field names:

- \`mcp__cococo__describe_type\` — get a type definition
- \`mcp__cococo__search_schema_queries\` / \`_mutations\` / \`_types\`
  / \`_fields\` — semantic search

Every spec field in this repo maps onto a GraphQL input — the MCP is
the canonical reference.

## Gotchas

- **Edge-app installations require a PUBLISHED row.** Apply rejects
  installs that point at DRAFT. Run \`cococo publish <edge-app>\` first.
- **Controller policy default-denies.** A controller with no
  \`policy\` block has empty allowlists, which the bridge treats as
  "reject everything". Declare a policy when an edge app needs IO or
  exec.
- **Custom-app refs in \`custom_app_user_bindings.ts\` / \`custom_app_team_bindings.ts\`
  point at custom-app handles.** The custom app must exist on the
  server first (\`cococo push <handle>\`); apply doesn't create apps.
- **Controller tokens are one-shot.** The connect bundle is returned
  once on creation and never again. If you lose it, \`cococo delete
  controller-token …\` to revoke and re-apply to mint a new one.
- **Secrets in protocol configs are write-only.** Use literal values
  for quick setup or \`\${config:NAME}\` template strings to defer to
  per-installation tenant config (the platform substitutes at runtime).

## Typical workflows

**Add a new edge app and ship it to a controller:**
1. \`cococo init door-monitor --type edge\` — scaffold
2. Edit \`edge_apps/door-monitor/manifest.ts\` and the handler files
3. \`cococo push door-monitor\` — mirror to draft
4. \`cococo publish door-monitor\` — DRAFT → PUBLISHED v1
5. Add to \`edge_app_installations.ts\`:
   \`{ controller: "press-01", app: "door-monitor", version: 1 }\`
6. \`cococo apply\` — installs on the controller

**Add a scheduled workflow:**
1. \`cococo init nightly-rollup --type workflow\` — scaffold
2. Edit \`workflows/nightly-rollup/manifest.ts\` — fill in nodes /
   edges / triggers. Node \`config\` is **typed** for the standard
   node types — picking \`type: "http_request"\` (etc.) narrows
   \`config\` and gives autocomplete. Compose nodes via
   \`defineNode({...})\` if you want to share them across workflows.
3. \`cococo lint nightly-rollup\` — server-validates the definition
4. \`cococo push nightly-rollup\` — creates / updates the workflow row
   and snapshots a new version
5. \`cococo publish nightly-rollup\` — flips the active version pointer

If TS complains about a node \`type\` it doesn't know, your tenant has
drifted from the shipped baseline — run \`cococo update\` to refresh
workspace overrides under \`.cococo/generated/\`.

**Onboard a new operator:**
1. Add to \`users.ts\`: \`{ email: "bob@acme.com", kind: "HUMAN" }\`
2. Add to \`iam_policy_bindings.ts\`: \`{ user: "bob@acme.com", policy: "press-operator" }\`
3. Optionally add to a team in \`teams.ts\` \`members\` list
4. \`cococo apply\`

**Rotate a controller token:**
1. \`cococo delete controller-token press-01 primary\` — revoke server-side
2. \`cococo apply\` — mints a new token for the still-declared
   \`(controller: "press-01", name: "primary")\` row, prints the
   connect bundle once
3. Update the bridge config with the new bundle

## Repo conventions

- TypeScript manifests are v2-only. Legacy v1 integrations stay on
  \`manifest.yaml\` (engine_version: 1) until migrated.
- Prefer \`luaFile("./path.lua")\` references over inline
  \`lua\\\`…\\\`\` blocks for anything longer than a one-liner.
- Use \`\${config:NAME}\` template strings for any value that should be
  resolved per-installation (passwords, tokens, paths). The platform
  resolves them at runtime; the CLI never sees the resolved values.

When you're unsure, run \`bunx cococo --help\`, read the README, or
ask the MCP server for the schema.
`;
