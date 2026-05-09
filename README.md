# @wearecococo/dev-cli

Author cococo platform **integrations** and **custom apps** locally —
TypeScript manifests, real Lua files, server-side validation, and a tight
push / lint / publish loop.

## Contents

- [Quick start](#quick-start)
- [Install](#install)
- [Configuration](#configuration)
- [Authoring an integration](#authoring-an-integration)
- [Authoring a custom app](#authoring-a-custom-app)
- [Daily workflow](#daily-workflow)
- [Migrating v1 integrations](#migrating-v1-integrations)
- [Reference](#reference)
- [Notes & limitations](#notes--limitations)
- [Hacking on the CLI itself](#hacking-on-the-cli-itself)

## Quick start

In any Bun project (has a `package.json`):

```sh
# Install + configure
bun add -d "@wearecococo/dev-cli@github:wearecococo/dev-cli#main"
export COCOCO_ENDPOINT=https://your-tenant.example.com/graphql
export COCOCO_TOKEN=your-bearer-token

# Author an integration
bunx cococo init com.acme.orders
bunx cococo push orders
bunx cococo publish orders

# …or a custom app
bunx cococo init job-board --type app
bunx cococo push job-board
bunx cococo publish job-board
```

That's the whole loop: edit files, push, publish.

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

Two env vars (Bun loads `.env` automatically):

```sh
COCOCO_ENDPOINT=https://your-tenant.example.com/graphql
COCOCO_TOKEN=your-bearer-token
```

Override per-invocation with `--endpoint` / `--token`.

## Authoring an integration

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

## Authoring a custom app

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

## Daily workflow

These commands work the same way for both integrations and custom apps —
they dispatch by inspecting the manifest in the folder. Pass a folder
name (resolved under `integrations/` *or* `custom_apps/`), a path, or
omit the arg from inside the folder.

```sh
bunx cococo status orders               # diff local vs remote, read-only
bunx cococo lint orders                 # validate every Lua chunk
bunx cococo lint orders --strict        # warnings as errors (CI mode)
bunx cococo push orders                 # mirror local → remote (runs lint first)
bunx cococo publish orders              # validate + publish
bunx cococo pull com.acme.orders        # download remote draft
bunx cococo pull job-board --type app   # download custom-app working copy
bunx cococo list                        # all integrations + apps on the server
```

### Lua validation

`cococo lint` calls the platform's Lua validator on every chunk in your
folder:

- **Files** — every `.lua` file walked.
- **Inline snippets** — every `` lua`...` `` template literal on a TS
  manifest.
- **Role-aware** — `app/**` and the custom-app `server.lua` validate
  under `CUSTOM_APP`; everything else under `INTEGRATION`. The role
  determines which `ctx.*` APIs are visible.

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
└── custom_apps/
    └── <handle>/                          # one folder per custom app
        ├── manifest.ts
        ├── template.vue
        ├── script.js
        └── server.lua                     # optional
```

### Commands

| Command | Purpose |
|---|---|
| `cococo init <id>` | Scaffold an integration under `integrations/<short-name>/` |
| `cococo init <handle> --type app` | Scaffold a custom app under `custom_apps/<handle>/` |
| `cococo push [folder] [--strict]` | Mirror local → remote (runs lint first) |
| `cococo status [folder]` | Diff local vs remote (read-only) |
| `cococo lint [folder] [--strict]` | Validate every Lua chunk via the server |
| `cococo validate [folder]` | Server-validate the remote draft (integrations only) |
| `cococo publish [folder]` | Integrations: DRAFT → ACTIVE. Apps: snapshot + publish |
| `cococo pull <id\|handle> [--type app] [-f]` | Download remote into a local folder |
| `cococo list` | List all integrations and custom apps on the server |
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
