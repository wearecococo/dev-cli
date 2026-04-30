# @wearecococo/dev-cli

A small CLI for authoring **integration builder** integrations (script_actor
runtime) against the cococo platform's GraphQL API. Keep your integrations as
plain folders on disk — `manifest.yaml` plus `scripts/*.lua` — and use this
tool to push/validate/publish drafts.

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
        ├── manifest.yaml
        ├── scripts/
        │   ├── main.lua
        │   └── ...
        ├── app/                 (optional — embedded custom app)
        │   ├── index.html
        │   ├── script.js
        │   └── server.lua
        ├── config_schema.json   (optional)
        ├── policy.yaml          (optional)
        └── workflows/*.yaml     (optional)
```

### Embedded custom apps

An integration can ship a custom app (Vue template + client script + optional
Lua RPC handlers) by dropping files under `app/`:

- `app/index.html` — Vue template rendered in the iframe.
- `app/script.js` — client-side script.
- `app/server.lua` — optional Lua RPC handlers, attached to a global
  `exports` table the same way `scripts/main.lua` is.

No manifest declaration is needed. `cococo push` uploads them as part of the
draft bundle and `cococo pull` writes them back into `app/`.

`manifest.yaml` mirrors the platform's `IntegrationManifest` shape:

```yaml
id: com.acme.my-integration
version: 0.1.0
sdkVersion: 1.0.0
runtimeMode: script_actor
entryScript: scripts/main.lua
description: Optional human-readable summary.
resources: []
permissions: []
subscriptions:
  - topic: jobs.created
timers:
  - name: tick
    every: 1m
```

## Commands

All commands accept either a folder name (resolved against `./integrations/`),
a path, or no argument (uses cwd if it has a `manifest.yaml`).

| Command | What it does |
|---|---|
| `cococo init <integrationId> [-v 0.1.0]` | Scaffold `./integrations/<short-name>/` with a minimal manifest and `scripts/main.lua` stub. No network call. |
| `cococo list` | List all integration definitions on the server, grouped by `integrationId`, showing draft + active versions. |
| `cococo status [folder]` | Show the diff between local files and the matching remote draft. Read-only. |
| `cococo push [folder]` | Mirror local → remote draft. Creates the draft if needed. Uploads added/changed files and **deletes remote files that no longer exist locally**. Refuses if the version is already `ACTIVE` or `DEPRECATED`. |
| `cococo lint [folder]` | Validate every `.lua` file in the folder via the server's Lua syntax checker. Runs in parallel; reports per-file errors. |
| `cococo validate [folder]` | Run server validation against the remote draft. Exits non-zero on errors. |
| `cococo publish [folder]` | Validate then publish. Flips DRAFT → ACTIVE. |
| `cococo pull <integrationId> [-v X] [-f]` | Materialize a remote draft into `./integrations/<short-name>/`. Use `-f` to overwrite a non-empty folder. |
| `cococo setup-mcp claude [-n name] [-u url] [-s scope]` | Register the cococo MCP endpoint with Claude Code. Derives the URL from `COCOCO_ENDPOINT` (`/graphql` → `/mcp`) and uses `COCOCO_TOKEN` for auth. Shells out to `claude mcp add`; prints fallback instructions if the `claude` CLI isn't installed. |
| `cococo mcp swagger <path>` | Run a stdio MCP server that exposes read-only discovery tools (`get_info`, `list_operations`, `search_operations`, `get_operation`, `list_tags`, `get_schema`) over a local OpenAPI/Swagger 2.0 or 3.x spec (`.json` or `.yaml`). `$ref`s are resolved on demand with cycle detection. Useful when authoring an integration that targets a third-party API — point Claude Code at the spec so it can discover endpoints and schemas without you pasting them in. |
| `cococo mcp add <path> [-n name] [-s scope]` | Convenience wrapper that registers the swagger MCP server with Claude Code in one step. Parses the spec, derives a name from `info.title` (override with `-n`), resolves the path to absolute, and runs `claude mcp add --transport stdio … -- bunx cococo mcp swagger <path>`. Prints fallback instructions if the `claude` CLI isn't installed. |

## Worked example

```sh
# In your integrations monorepo:
bunx cococo init com.acme.demo
# → integrations/demo/manifest.yaml + scripts/main.lua

# Edit scripts/main.lua and add a timer to manifest.yaml.
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
