import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { SwaggerSpec } from "../mcp/swagger-server.ts";

export type McpAddOptions = {
  name?: string;
  scope?: "local" | "project" | "user";
  client?: string;
};

const SUPPORTED_CLIENTS = ["claude"] as const;
type Client = (typeof SUPPORTED_CLIENTS)[number];

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function deriveSwaggerName(spec: SwaggerSpec, specPath: string): string {
  const title = spec.info?.title;
  if (typeof title === "string" && title.trim()) {
    const slug = slugify(title);
    if (slug) return slug;
  }
  const stem = basename(specPath).replace(/\.(json|ya?ml)$/i, "");
  return slugify(stem) || "swagger";
}

export function buildClaudeAddArgs(opts: {
  name: string;
  scope?: McpAddOptions["scope"];
  specPath: string;
}): string[] {
  const args = ["mcp", "add", "--transport", "stdio"];
  if (opts.scope) args.push("--scope", opts.scope);
  args.push(opts.name, "--", "bunx", "cococo", "mcp", "swagger", opts.specPath);
  return args;
}

export async function runMcpAdd(
  specPath: string,
  opts: McpAddOptions,
): Promise<void> {
  const client = opts.client ?? "claude";
  if (!SUPPORTED_CLIENTS.includes(client as Client)) {
    throw new Error(
      `Unsupported MCP client '${client}'. Supported: ${SUPPORTED_CLIENTS.join(", ")}`,
    );
  }

  const abs = resolve(process.cwd(), specPath);
  const raw = readFileSync(abs, "utf8");
  const parsed = abs.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`Spec at ${abs} did not parse to an object.`);
  }
  const spec = parsed as SwaggerSpec;
  if (!spec.openapi && !spec.swagger) {
    throw new Error(
      `Spec at ${abs} has no 'openapi' or 'swagger' version field — is it really an OpenAPI/Swagger doc?`,
    );
  }

  const name = opts.name ?? deriveSwaggerName(spec, abs);
  const args = buildClaudeAddArgs({ name, scope: opts.scope, specPath: abs });
  const res = spawnSync("claude", args, { stdio: "inherit" });

  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    printFallback(name, abs, opts.scope);
    return;
  }
  if (res.status !== 0) {
    throw new Error(`claude mcp add exited with code ${res.status}`);
  }
  console.log(
    `Registered MCP server '${name}' → bunx cococo mcp swagger ${abs}`,
  );
}

function printFallback(
  name: string,
  specPath: string,
  scope: McpAddOptions["scope"],
): void {
  const scopeFlag = scope ? ` --scope ${scope}` : "";
  console.error(
    "The 'claude' CLI is not on PATH. Install Claude Code, then run:\n\n" +
      `  claude mcp add --transport stdio${scopeFlag} ${name} \\\n` +
      `    -- bunx cococo mcp swagger ${specPath}\n`,
  );
}
