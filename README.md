# @wearecococo/dev-cli

A small CLI for authoring **integration builder** integrations (script_actor
runtime) against the cococo platform's GraphQL API. Keep your integrations as
plain folders on disk — a `manifest.ts` (or legacy `manifest.yaml`) plus the
Lua handlers it references — and use this tool to push/validate/publish
drafts.

The canonical manifest format is **TypeScript**:

```ts
// integrations/orders/manifest.ts
import { defineIntegration, lua, luaFile } from "@wearecococo/dev-cli/define";

export default defineIntegration({
  id: "com.acme.orders",
  version: "0.1.0",
  engineVersion: 2,
  sdkVersion: "1.0",
  runtimeMode: "script_actor",
  resources: [],
  permissions: [],

  // Inline one-liners use the `lua` tag (LuaSource-branded, dedented).
  initSource: lua`
    local config = ...
    ctx.log.info("starting against " .. config.api_url)
  `,

  // Anything longer lives in its own .lua file, referenced via luaFile().
  timers: [
    { name: "tick", every: "1m", source: luaFile("./handlers/timers/tick.lua") },
  ],

  subscriptions: [
    {
      topic: "jobs.created",
      source: luaFile("./handlers/subscriptions/jobs.created.lua"),
    },
  ],

  libraries: {
    http_helpers: luaFile("./libraries/http_helpers.lua"),
  },
});
```

You get TypeScript completion + diagnostics for the manifest at edit time,
and the platform validation runs as a backstop. Both engine versions of the
integration runtime are supported:

- **v2** (default) — handler bodies live as separate Lua files referenced via
  `luaFile()` (or short ones inline via `lua\`...\``). Optional
  `initSource` / `shutdownSource` / `upgradeSource` lifecycle hooks plus a
  `libraries` map loaded via `ctx.script.load(name)`. No entry script.
- **v1** (legacy, still supported) — `entryScript` populates a global
  `exports` table; the runtime dispatches via `exports.<hook>` lookup.

`manifest.yaml` continues to work for folders that haven't migrated, and you
can opt into it explicitly with `--format yaml` on `init` and `pull`. See
"YAML manifests" below for the snake_case shape.

This is a stop-gap for developer workflow while the full Terraform provider is
built. It only manages **drafts**; instances, runs, and config live elsewhere.

## Install

The CLI isn't on npm — it's consumed straight from GitHub. Bun resolves
`github:` specs natively; the only prerequisite for end users is having Bun
installed.

> Pin to a tag or commit (`#v0.1.0`, `#abc1234`) instead of `#main` for
> reproducible installs.

### Per-project (recommended)

Add to your integrations monorepo's `package.json`:

```json
{
  "devDependencies": {
    "@wearecococo/dev-cli": "github:wearecococo/dev-cli#main"
  }
}
```

Then:

```sh
bun install
bunx cococo --help              # picks up node_modules/.bin/cococo
```

`bun install` will also pull `commander` and `yaml` transitively — no extra
dependencies for the consuming repo.

### One-shot (no install)

```sh
bunx github:wearecococo/dev-cli cococo init com.acme.my-integration
```

Useful for trying the CLI without committing to a `package.json` entry.

### Local development of the CLI itself

If you're hacking on this repo:

```sh
bun install
bun link             # exposes `cococo` on PATH using src/index.ts directly
cococo --help
```

`bun unlink` to remove.

## Configuration

The CLI reads two env vars (Bun loads `.env` automatically):

```sh
COCOCO_ENDPOINT=https://api.example.com/graphql
COCOCO_TOKEN=your-bearer-token
```

Both can be overridden per-invocation with `--endpoint` and `--token`.

## Project layout

The CLI is run from the root of *your* integrations monorepo. It expects:

```
<your-repo>/
└── integrations/
    └── <name>/
        ├── manifest.ts                (canonical) OR manifest.yaml (legacy)
        ├── handlers/                  (v2 — Lua bodies referenced by luaFile)
        │   ├── timers/<name>.lua
        │   └── subscriptions/<topic>.lua
        ├── lifecycle/                 (v2 — init/shutdown/upgrade hooks)
        │   ├── init.lua
        │   ├── shutdown.lua
        │   └── upgrade.lua
        ├── libraries/<name>.lua       (v2 — entries in the libraries map)
        ├── scripts/
        │   ├── main.lua               (v1 entry script)
        │   └── ...                    (v2 helpers reachable via ctx.script.load)
        ├── app/                       (optional — embedded custom app)
        │   ├── index.html
        │   ├── script.js
        │   └── server.lua
        ├── config_schema.json         (optional)
        ├── policy.yaml                (optional)
        └── workflows/*.yaml           (optional)
```

### v2 manifest source files

In v2, the inline `source` strings on each timer/subscription, the
`init_source`/`shutdown_source`/`upgrade_source` lifecycle hooks, and the
`libraries` map are kept as ordinary `.lua` files on disk so you can edit
them with syntax highlighting, run `cococo lint` on them, and get clean
`git` diffs.

| Manifest field            | On-disk convention                       |
|---------------------------|------------------------------------------|
| `initSource`              | `lifecycle/init.lua`                     |
| `shutdownSource`          | `lifecycle/shutdown.lua`                 |
| `upgradeSource`           | `lifecycle/upgrade.lua`                  |
| `timers[i].source`        | `handlers/timers/<timer.name>.lua`       |
| `subscriptions[i].source` | `handlers/subscriptions/<topic>.lua`     |
| `libraries[name]`         | `libraries/<name>.lua`                   |

How files are linked to manifest fields depends on the format:

- **TS manifest** — references are explicit via `luaFile("./...")`. The path
  can be anywhere in the integration folder; the conventions above are just
  what `cococo init` and `cococo pull` use when they generate things.
- **YAML manifest** — references are implicit by convention. Push looks up
  `handlers/timers/<name>.lua` for each timer entry, etc. Stray files (no
  matching manifest entry) cause push to refuse, and timer names /
  subscription topics must be unique.

In both formats, files under `handlers/`, `lifecycle/`, and `libraries/` are
**never** uploaded as bundle files — the server's `IntegrationBundle` doesn't
know about those paths. They only travel inside the manifest payload.

### Embedded custom apps

An integration can ship a custom app (Vue template + client script + optional
Lua RPC handlers) by dropping files under `app/`:

- `app/index.html` — Vue template rendered in the iframe.
- `app/script.js` — client-side script.
- `app/server.lua` — optional Lua RPC handlers, attached to a global
  `exports` table the same way `scripts/main.lua` is.

No manifest declaration is needed. `cococo push` uploads them as part of the
draft bundle and `cococo pull` writes them back into `app/`.

### YAML manifests (legacy / opt-out)

`manifest.yaml` mirrors the platform's `IntegrationManifest` shape (snake_case
on disk and on the wire). The CLI adds one local-only key — `engine_version`
— so the folder round-trips between push and pull. A folder with both
`manifest.ts` and `manifest.yaml` is rejected; pick one.

**v2:**

```yaml
id: com.acme.my-integration
version: 0.1.0
engine_version: 2
sdk_version: "1.0"
runtime_mode: script_actor
description: Optional human-readable summary.
resources: []
permissions: []
subscriptions:
  - topic: jobs.created
timers:
  - name: tick
    every: 1m
```

…with the Lua bodies as separate files at the conventional paths
(`handlers/timers/tick.lua` etc — see the table above).

**v1:**

```yaml
id: com.acme.my-integration
version: 0.1.0
engine_version: 1
sdk_version: "1.0"
runtime_mode: script_actor
entry_script: main.lua
description: Optional human-readable summary.
resources: []
permissions: []
subscriptions:
  - topic: jobs.created
timers:
  - name: tick
    every: 1m
```

Use `cococo init <integrationId> --format yaml` for a YAML scaffold, and
`--engine-version 1` for the v1 entry-script shape.

## Commands

All commands accept either a folder name (resolved against `./integrations/`),
a path, or no argument (uses cwd if it has a `manifest.ts` or `manifest.yaml`).

| Command | What it does |
|---|---|
| `cococo init <integrationId> [-v 0.1.0] [-e 2] [--format ts\|yaml]` | Scaffold `./integrations/<short-name>/` with a minimal v2 `manifest.ts` and a starter `handlers/timers/heartbeat.lua`. `-e 1` switches to the v1 entry-script + `scripts/main.lua` shape; `--format yaml` emits a YAML manifest. No network call. |
| `cococo list` | List all integration definitions on the server, grouped by `integrationId`, showing draft + active versions. |
| `cococo status [folder]` | Show the diff between local files and the matching remote draft. Read-only. |
| `cococo push [folder] [--strict]` | Mirror local → remote draft. Creates the draft if needed. Uploads added/changed files and **deletes remote files that no longer exist locally**. Refuses if the version is already `ACTIVE` or `DEPRECATED`. Runs the same Lua validation pass as `cococo lint` first; `--strict` fails the push on warnings. |
| `cococo lint [folder] [--strict]` | Validate every Lua chunk in the folder via the server. Covers `.lua` files (scripts, app, handlers, lifecycle, libraries) **and** inline `` lua`...` `` snippets on a TS manifest. Role-aware: `app/**` runs under `CUSTOM_APP`, everything else under `INTEGRATION`. Diagnostics include line/column and severity (`ERROR` / `WARNING`). Warnings are reported but non-fatal unless `--strict`. |
| `cococo validate [folder]` | Run server validation against the remote draft. Exits non-zero on errors. |
| `cococo publish [folder]` | Validate then publish. Flips DRAFT → ACTIVE. |
| `cococo pull <integrationId> [-v X] [-f] [--format ts\|yaml]` | Materialize a remote draft into `./integrations/<short-name>/`. Writes `manifest.ts` by default (with all v2 sources materialised via `luaFile()`); `--format yaml` writes `manifest.yaml` instead. Use `-f` to overwrite a non-empty folder. |
| `cococo migrate [folder]` | Fork a v1 YAML integration into a v2 TS sibling at `<folder>_v2/`. Auto-bumps the minor version, copies bundle artefacts, writes a v2 `manifest.ts` skeleton with placeholder handler files, then shells out to `claude -p` to refactor `scripts/main.lua` into per-handler Lua files. The original v1 folder is left untouched — review the diff in the new folder, then push when ready. Requires Claude Code on PATH; without it, the skeleton is still emitted and a self-contained prompt is dropped at `<folder>_v2/.cococo-migrate-prompt.txt` for manual use. |
| `cococo setup-mcp claude [-n name] [-u url] [-s scope]` | Register the cococo MCP endpoint with Claude Code. Derives the URL from `COCOCO_ENDPOINT` (`/graphql` → `/mcp`) and uses `COCOCO_TOKEN` for auth. Shells out to `claude mcp add`; prints fallback instructions if the `claude` CLI isn't installed. |
| `cococo mcp swagger <path>` | Run a stdio MCP server that exposes read-only discovery tools (`get_info`, `list_operations`, `search_operations`, `get_operation`, `list_tags`, `get_schema`) over a local OpenAPI/Swagger 2.0 or 3.x spec (`.json` or `.yaml`). `$ref`s are resolved on demand with cycle detection. Useful when authoring an integration that targets a third-party API — point Claude Code at the spec so it can discover endpoints and schemas without you pasting them in. |
| `cococo mcp add <path> [-n name] [-s scope]` | Convenience wrapper that registers the swagger MCP server with Claude Code in one step. Parses the spec, derives a name from `info.title` (override with `-n`), resolves the path to absolute, and runs `claude mcp add --transport stdio … -- bunx cococo mcp swagger <path>`. Prints fallback instructions if the `claude` CLI isn't installed. |

## Worked example

```sh
# In your integrations monorepo:
bunx cococo init com.acme.demo
# → integrations/demo/manifest.ts + handlers/timers/heartbeat.lua

# Edit handlers/timers/heartbeat.lua, add more timers / subscriptions / lifecycle
# files as needed, and reference them from manifest.ts via luaFile().
bunx cococo push demo
# → custom.demo@0.1.0 (draft igd_…)
#     +1 added, ~0 changed, -0 deleted

bunx cococo status demo
# → no changes

bunx cococo validate demo
# → custom.demo@0.1.0: valid.

bunx cococo publish demo
# → custom.demo@0.1.0: ACTIVE

# Bump version in manifest.yaml to 0.1.1, then push again.
bunx cococo push demo
# → new draft igd_… created
```

## Tests

```sh
bun test              # unit tests only (fast, no network)
bun run test:integration   # full lifecycle against a real tenant — requires
                           # COCOCO_ENDPOINT + COCOCO_TOKEN, gated on
                           # COCOCO_INTEGRATION_TEST=1.
```

The integration test creates a unique `custom.cli-test-<ts>` integration per
run and exercises init/push/status/validate/publish/pull. Run it against a
disposable platform — drafts can't be deleted via the public API.

## Notes / limitations

- **Drafts only.** The CLI never touches integration *instances* or config
  bindings — those are managed elsewhere (UI / Terraform).
- **Version is the rename.** Published versions are immutable; bump
  `manifest.yaml`'s `version` to start a new draft.
- **No watch/dev mode.** Push manually after edits. (Planned for a follow-up.)
- **No local Lua syntax check.** Use the platform's `validate` for now.
