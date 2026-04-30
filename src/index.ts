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
import { runSetupMcp } from "./commands/setup-mcp.ts";

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
  .description("Scaffold ./integrations/<short-name>/ with a starter manifest and main.lua.")
  .option("-v, --version <version>", "Initial semantic version", "0.1.0")
  .action(async (integrationId: string, opts: { version: string }) => {
    await runInit(integrationId, { version: opts.version });
  });

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
  .action(async (folder: string | undefined) => {
    await runPush(folder, apiOpts());
  });

program
  .command("lint [folder]")
  .description("Validate every .lua file in a local integration folder via the server.")
  .action(async (folder: string | undefined) => {
    await runLint(folder, apiOpts());
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
  .action(
    async (
      integrationId: string,
      opts: { version?: string; force: boolean },
    ) => {
      await runPull(integrationId, opts, apiOpts());
    },
  );

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

try {
  await program.parseAsync(process.argv);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`error: ${msg}`);
  process.exit(1);
}
