#!/usr/bin/env bun
import { Command } from "commander";
import { runInit } from "./commands/init.ts";
import { runList } from "./commands/list.ts";
import { runLint, runLintAll } from "./commands/lint.ts";
import { runStatus } from "./commands/status.ts";
import { runPush, runPushAll } from "./commands/push.ts";
import { runValidate, runValidateAll } from "./commands/validate.ts";
import { runPublish, runPublishAll } from "./commands/publish.ts";
import { runDeprecate } from "./commands/deprecate.ts";
import { runApply } from "./commands/apply.ts";
import { runDelete, type DeleteKind } from "./commands/delete.ts";
import { runBootstrap, runClaudeMd } from "./commands/bootstrap.ts";
import { runDump, type DumpKind } from "./commands/dump.ts";
import { runPull } from "./commands/pull.ts";
import { runMigrate } from "./commands/migrate.ts";
import { runSetupMcp } from "./commands/setup-mcp.ts";
import { runMcpSwagger } from "./commands/mcp.ts";
import { runMcpAdd } from "./commands/mcp-add.ts";

const program = new Command();

program
  .name("cococo")
  .description("Author cococo integration drafts from a local monorepo.")
  .option("--endpoint <url>", "GraphQL endpoint (overrides COCOCO_ENDPOINT)")
  .option("--token <token>", "Bearer token (overrides COCOCO_TOKEN)");

const apiOpts = () => {
  const o = program.opts<{ endpoint?: string; token?: string }>();
  return { endpoint: o.endpoint, token: o.token };
};

program
  .command("bootstrap [folder]")
  .description(
    "Scaffold a fresh cococo workspace: package.json, .env.example, .gitignore, " +
      "tsconfig.json, commented-out ops stubs at the repo root, and CLAUDE.md. " +
      "Run before 'init' to set up a new project. Pass --pull to also dump the " +
      "tenant's existing ops state into the workspace (requires COCOCO_ENDPOINT/TOKEN).",
  )
  .option("--no-claude-md", "Skip writing CLAUDE.md")
  .option("-f, --force", "Overwrite files that already exist", false)
  .option(
    "--pull",
    "After scaffolding, run 'cococo dump all' to populate ops files from the server",
    false,
  )
  .action(
    async (
      folder: string | undefined,
      opts: { claudeMd: boolean; force: boolean; pull: boolean },
    ) => {
      await runBootstrap(folder, {
        claudeMd: opts.claudeMd,
        force: opts.force,
        pull: opts.pull,
        apiOverrides: apiOpts(),
      });
    },
  );

program
  .command("dump <kind>")
  .description(
    "Download tenant ops state from the server into a local file. Kinds: " +
      "users, policies, bindings, networks, devices, teams, custom-app-user-bindings, " +
      "custom-app-team-bindings, controllers, edge-app-installations, all. Tokens are " +
      "excluded — connect bundles can't be re-fetched. Write-only secrets " +
      "(device passwords, etc.) emit ${config:NAME} placeholders.",
  )
  .option("-f, --force", "Overwrite existing files", false)
  .action(async (kind: string, opts: { force: boolean }) => {
    const allowed: DumpKind[] = [
      "users",
      "policies",
      "iam-policy-bindings",
      "networks",
      "devices",
      "teams",
      "custom-app-user-bindings",
      "custom-app-team-bindings",
      "controllers",
      "edge-app-installations",
      "all",
    ];
    if (!allowed.includes(kind as DumpKind)) {
      throw new Error(
        `cococo dump: unknown kind '${kind}'. Use ${allowed.join(" | ")}.`,
      );
    }
    await runDump(kind as DumpKind, { force: opts.force }, apiOpts());
  });

program
  .command("claude-md [folder]")
  .description(
    "Add (or refresh) a CLAUDE.md project guide so Claude Code understands " +
      "this repo's conventions. Run after 'bootstrap' if you skipped it, or " +
      "after a CLI upgrade to refresh the guide.",
  )
  .option("-f, --force", "Overwrite an existing CLAUDE.md", false)
  .action(async (folder: string | undefined, opts: { force: boolean }) => {
    await runClaudeMd(folder, { force: opts.force });
  });

program
  .command("init <idOrHandle>")
  .description(
    "Scaffold a new integration or custom app under integrations/<short-name>/ or " +
      "custom_apps/<handle>/. Defaults to a TypeScript manifest at engineVersion 2.",
  )
  .option(
    "-t, --type <integration|app|edge>",
    "Kind of thing to scaffold",
    "integration",
  )
  .option("-v, --version <version>", "Initial semantic version (integrations only)", "0.1.0")
  .option(
    "-e, --engine-version <n>",
    "Integration engine version to scaffold (1 or 2; integrations only)",
    "2",
  )
  .option("-f, --format <ts|yaml>", "Manifest format (integrations only)", "ts")
  .option(
    "-k, --app-kind <kind>",
    "Custom-app kind (PAGE | DASHBOARD | KIOSK | JOB_VIEW; apps only)",
    "PAGE",
  )
  .action(
    async (
      idOrHandle: string,
      opts: {
        type: string;
        version: string;
        engineVersion: string;
        format: string;
        appKind: string;
      },
    ) => {
      const type = parseType(opts.type);
      const engineVersion = parseEngineVersion(opts.engineVersion);
      const format = parseFormat(opts.format);
      const appKind = type === "app" ? parseAppKind(opts.appKind) : undefined;
      await runInit(idOrHandle, {
        version: opts.version,
        engineVersion,
        format,
        type,
        appKind,
      });
    },
  );

function parseEngineVersion(raw: string): 1 | 2 {
  if (raw === "1") return 1;
  if (raw === "2") return 2;
  throw new Error(`--engine-version must be 1 or 2 (got ${raw}).`);
}

function parseFormat(raw: string): "ts" | "yaml" {
  if (raw === "ts" || raw === "yaml") return raw;
  throw new Error(`--format must be 'ts' or 'yaml' (got ${raw}).`);
}

function parseType(raw: string): "integration" | "app" | "edge" {
  if (raw === "integration" || raw === "app" || raw === "edge") return raw;
  throw new Error(`--type must be 'integration', 'app', or 'edge' (got ${raw}).`);
}

function parseAppKind(raw: string): "PAGE" | "DASHBOARD" | "KIOSK" | "JOB_VIEW" {
  if (raw === "PAGE" || raw === "DASHBOARD" || raw === "KIOSK" || raw === "JOB_VIEW") return raw;
  throw new Error(
    `--app-kind must be PAGE | DASHBOARD | KIOSK | JOB_VIEW (got ${raw}).`,
  );
}

program
  .command("list")
  .description("List all integration definitions on the server, grouped by integrationId.")
  .action(async () => {
    await runList(apiOpts());
  });

program
  .command("status [folder]")
  .description("Show the diff between a local integration folder and its remote draft.")
  .action(async (folder: string | undefined) => {
    await runStatus(folder, apiOpts());
  });

program
  .command("push [folder]")
  .description(
    "Mirror a local artifact folder to its remote draft. With --all, walks " +
      "integrations/, custom_apps/, and edge_apps/ and pushes each — stops on " +
      "first failure (push has server-side effects).",
  )
  .option("--strict", "Fail on Lua warnings during the pre-push validation pass", false)
  .option("--all", "Push every artifact under integrations/, custom_apps/, edge_apps/", false)
  .action(async (folder: string | undefined, opts: { strict: boolean; all: boolean }) => {
    if (opts.all) {
      if (folder) throw new Error("Pass either a folder OR --all, not both.");
      await runPushAll({ strict: opts.strict }, apiOpts());
      return;
    }
    await runPush(folder, { strict: opts.strict }, apiOpts());
  });

program
  .command("lint [folder]")
  .description(
    "Validate every Lua chunk in a local integration folder — files (scripts/, app/, " +
      "handlers/, lifecycle/, libraries/) and inline `lua\\`...\\`` snippets in a TS manifest. " +
      "Warnings are reported but non-fatal unless --strict. With --all, walks every artifact " +
      "and aggregates findings (read-only, so it keeps going past failures).",
  )
  .option("--strict", "Fail on warnings as well as errors", false)
  .option("--all", "Lint every artifact under integrations/, custom_apps/, edge_apps/", false)
  .action(async (folder: string | undefined, opts: { strict: boolean; all: boolean }) => {
    if (opts.all) {
      if (folder) throw new Error("Pass either a folder OR --all, not both.");
      await runLintAll({ strict: opts.strict }, apiOpts());
      return;
    }
    await runLint(folder, { strict: opts.strict }, apiOpts());
  });

program
  .command("validate [folder]")
  .description(
    "Server-validate the remote draft for a local integration folder. With --all, " +
      "validates every integration draft and aggregates results (read-only, so it " +
      "keeps going past failures). Custom apps and edge apps don't have a server " +
      "validate step; --all skips them.",
  )
  .option("--all", "Validate every integration under integrations/", false)
  .action(async (folder: string | undefined, opts: { all: boolean }) => {
    if (opts.all) {
      if (folder) throw new Error("Pass either a folder OR --all, not both.");
      await runValidateAll(apiOpts());
      return;
    }
    await runValidate(folder, apiOpts());
  });

program
  .command("publish [folder]")
  .description(
    "Validate and publish the remote draft for a local artifact folder. With --all, " +
      "publishes every artifact — stops on first failure (publish has server-side effects).",
  )
  .option("--all", "Publish every artifact under integrations/, custom_apps/, edge_apps/", false)
  .action(async (folder: string | undefined, opts: { all: boolean }) => {
    if (opts.all) {
      if (folder) throw new Error("Pass either a folder OR --all, not both.");
      await runPublishAll(apiOpts());
      return;
    }
    await runPublish(folder, apiOpts());
  });

program
  .command("apply")
  .description(
    "Apply tenant ops files at the repo root: users.ts, iam_policies.ts, iam_policy_bindings.ts, " +
      "networks.ts, devices.ts, teams.ts, custom_app_user_bindings.ts, custom_app_team_bindings.ts, " +
      "controllers.ts, controller_tokens.ts, edge_app_installations.ts. Mostly additive " +
      "(upserts what's declared, never deletes), with two reconciled exceptions: team " +
      "`members` and controller `policy` allowlists are wholesale-replaced from the " +
      "declared spec. Tokens are create-only with an existence check; the connect " +
      "bundle is printed once on creation. Use 'cococo delete' for row-level removals.",
  )
  .action(async () => {
    await runApply(apiOpts());
  });

program
  .command("delete <kind> [args...]")
  .description(
    "Delete a tenant ops resource on the server. Kinds: " +
      "user (<email>), policy (<handle>), iam-policy-binding (<email> <policy>), " +
      "network (<name>), device (<identifier>), team (<name>), " +
      "team-member (<team> <email>), custom-app-user-binding (<email> <app>), " +
      "custom-app-team-binding (<team> <app>), controller (<handle>), " +
      "controller-token (<controller> <name>), " +
      "edge-app-installation (<controller> <app> <version>). " +
      "Local ops files are NOT edited — remove the entry yourself to " +
      "keep the next apply consistent.",
  )
  .action(async (kind: string, args: string[]) => {
    const allowed = [
      "user",
      "policy",
      "iam-policy-binding",
      "network",
      "device",
      "team",
      "team-member",
      "custom-app-user-binding",
      "custom-app-team-binding",
      "controller",
      "controller-token",
      "edge-app-installation",
    ] as const;
    if (!allowed.includes(kind as (typeof allowed)[number])) {
      throw new Error(
        `cococo delete: unknown kind '${kind}'. Use ${allowed.join(" | ")}.`,
      );
    }
    await runDelete(kind as DeleteKind, args, apiOpts());
  });

program
  .command("deprecate [folder]")
  .description(
    "Deprecate the PUBLISHED definition for an integration or edge app. " +
      "Existing installations keep working until upgraded; new installations are blocked. " +
      "Custom apps don't have a deprecate concept.",
  )
  .action(async (folder: string | undefined) => {
    await runDeprecate(folder, apiOpts());
  });

program
  .command("pull <idOrHandle>")
  .description(
    "Materialize a remote integration draft into integrations/<short-name>/, " +
      "or a remote custom app's working copy into custom_apps/<handle>/.",
  )
  .option(
    "-t, --type <integration|app|edge>",
    "Kind of thing to pull",
    "integration",
  )
  .option("-v, --version <version>", "Specific draft version to pull (integrations only)")
  .option("-f, --force", "Overwrite if the target folder already exists", false)
  .option("--format <ts|yaml>", "Manifest format to emit (integrations only)", "ts")
  .action(
    async (
      idOrHandle: string,
      opts: { type: string; version?: string; force: boolean; format: string },
    ) => {
      const type = parseType(opts.type);
      const format = parseFormat(opts.format);
      await runPull(
        idOrHandle,
        { version: opts.version, force: opts.force, format, type },
        apiOpts(),
      );
    },
  );

program
  .command("migrate [folder]")
  .description(
    "Fork a v1 YAML integration into a v2 TS sibling folder (`<folder>_v2/`). " +
      "Auto-bumps the minor version, builds the v2 skeleton, then shells out " +
      "to `claude -p` to refactor the v1 entry script into per-handler files. " +
      "Original folder is untouched.",
  )
  .action(async (folder: string | undefined) => {
    await runMigrate(folder, apiOpts());
  });

program
  .command("setup-mcp <client>")
  .description("Register the cococo MCP endpoint with an LLM client (currently: claude).")
  .option("-n, --name <name>", "Name to register the server under", "cococo")
  .option("-u, --url <url>", "Override the MCP URL (otherwise derived from --endpoint)")
  .option("-s, --scope <scope>", "Scope to pass to the client (local | project | user)")
  .action(
    async (
      client: string,
      opts: { name: string; url?: string; scope?: "local" | "project" | "user" },
    ) => {
      await runSetupMcp(client, opts, apiOpts());
    },
  );

const mcp = program
  .command("mcp")
  .description("Local MCP servers for use with LLM clients.");

mcp
  .command("swagger <path>")
  .description(
    "Run a stdio MCP server that exposes read-only discovery tools over a local OpenAPI/Swagger spec (.json or .yaml).",
  )
  .action(async (specPath: string) => {
    await runMcpSwagger(specPath);
  });

mcp
  .command("add <path>")
  .description(
    "Register the swagger MCP server for a local spec with an LLM client (currently: claude).",
  )
  .option("-n, --name <name>", "Name to register the server under (default: derived from spec title)")
  .option("-s, --scope <scope>", "Scope to pass to the client (local | project | user)")
  .option("-c, --client <client>", "LLM client to register with", "claude")
  .action(
    async (
      specPath: string,
      opts: { name?: string; scope?: "local" | "project" | "user"; client: string },
    ) => {
      await runMcpAdd(specPath, opts);
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
}
