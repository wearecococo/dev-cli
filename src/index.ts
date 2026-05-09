#!/usr/bin/env bun
import { Command } from "commander";
import { runInit } from "./commands/init.ts";
import { runList } from "./commands/list.ts";
import { runLint } from "./commands/lint.ts";
import { runStatus } from "./commands/status.ts";
import { runPush } from "./commands/push.ts";
import { runValidate } from "./commands/validate.ts";
import { runPublish } from "./commands/publish.ts";
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
  .command("init <integrationId>")
  .description(
    "Scaffold ./integrations/<short-name>/ with a starter manifest. Defaults to a TypeScript manifest at engineVersion 2.",
  )
  .option("-v, --version <version>", "Initial semantic version", "0.1.0")
  .option(
    "-e, --engine-version <n>",
    "Integration engine version to scaffold (1 or 2)",
    "2",
  )
  .option("-f, --format <ts|yaml>", "Manifest format", "ts")
  .action(
    async (
      integrationId: string,
      opts: { version: string; engineVersion: string; format: string },
    ) => {
      const engineVersion = parseEngineVersion(opts.engineVersion);
      const format = parseFormat(opts.format);
      await runInit(integrationId, {
        version: opts.version,
        engineVersion,
        format,
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
  .description("Mirror a local integration folder to its remote draft.")
  .option("--strict", "Fail on Lua warnings during the pre-push validation pass", false)
  .action(async (folder: string | undefined, opts: { strict: boolean }) => {
    await runPush(folder, { strict: opts.strict }, apiOpts());
  });

program
  .command("lint [folder]")
  .description(
    "Validate every Lua chunk in a local integration folder — files (scripts/, app/, " +
      "handlers/, lifecycle/, libraries/) and inline `lua\\`...\\`` snippets in a TS manifest. " +
      "Warnings are reported but non-fatal unless --strict.",
  )
  .option("--strict", "Fail on warnings as well as errors", false)
  .action(async (folder: string | undefined, opts: { strict: boolean }) => {
    await runLint(folder, { strict: opts.strict }, apiOpts());
  });

program
  .command("validate [folder]")
  .description("Server-validate the remote draft for a local integration folder.")
  .action(async (folder: string | undefined) => {
    await runValidate(folder, apiOpts());
  });

program
  .command("publish [folder]")
  .description("Validate and publish the remote draft for a local integration folder.")
  .action(async (folder: string | undefined) => {
    await runPublish(folder, apiOpts());
  });

program
  .command("pull <integrationId>")
  .description("Materialize a remote draft into ./integrations/<short-name>/.")
  .option("-v, --version <version>", "Specific draft version to pull (defaults to highest)")
  .option("-f, --force", "Overwrite if the target folder already exists", false)
  .option("--format <ts|yaml>", "Manifest format to emit", "ts")
  .action(
    async (
      integrationId: string,
      opts: { version?: string; force: boolean; format: string },
    ) => {
      const format = parseFormat(opts.format);
      await runPull(
        integrationId,
        { version: opts.version, force: opts.force, format },
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
