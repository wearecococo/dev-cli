import { spawnSync } from "node:child_process";
import { loadConfig, type ConfigOverrides } from "../config.ts";

export type SetupMcpOptions = {
  name: string;
  url?: string;
  scope?: "local" | "project" | "user";
};

const SUPPORTED_CLIENTS = ["claude"] as const;
type Client = (typeof SUPPORTED_CLIENTS)[number];

export async function runSetupMcp(
  client: string,
  opts: SetupMcpOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  if (!SUPPORTED_CLIENTS.includes(client as Client)) {
    throw new Error(
      `Unsupported MCP client '${client}'. Supported: ${SUPPORTED_CLIENTS.join(", ")}`,
    );
  }
  const cfg = loadConfig(overrides);
  const url = opts.url ?? deriveMcpUrl(cfg.endpoint);

  const args = ["mcp", "add", "--transport", "http"];
  if (opts.scope) args.push("--scope", opts.scope);
  args.push(opts.name, url, "--header", `Authorization: Bearer ${cfg.token}`);

  const res = spawnSync("claude", args, { stdio: "inherit" });

  if (res.error && (res.error as NodeJS.ErrnoException).code === "ENOENT") {
    printFallback(opts.name, url, cfg.token, opts.scope);
    return;
  }
  if (res.status !== 0) {
    throw new Error(`claude mcp add exited with code ${res.status}`);
  }
  console.log(`Registered MCP server '${opts.name}' → ${url}`);
}

export function deriveMcpUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.pathname.endsWith("/graphql")) {
    url.pathname = url.pathname.slice(0, -"/graphql".length) + "/mcp";
  } else {
    url.pathname = url.pathname.replace(/\/$/, "") + "/mcp";
  }
  return url.toString();
}

function printFallback(
  name: string,
  url: string,
  token: string,
  scope: SetupMcpOptions["scope"],
): void {
  const scopeFlag = scope ? ` --scope ${scope}` : "";
  console.error(
    "The 'claude' CLI is not on PATH. Install Claude Code, then run:\n\n" +
      `  claude mcp add --transport http${scopeFlag} ${name} ${url} \\\n` +
      `    --header "Authorization: Bearer ${token}"\n`,
  );
}
