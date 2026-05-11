import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CLAUDE_MD_TEMPLATE } from "../templates/claude-md.ts";
import { runDump } from "./dump.ts";
import type { ConfigOverrides } from "../config.ts";

export type BootstrapOptions = {
  /** When false, skip writing CLAUDE.md. Default true. */
  claudeMd?: boolean;
  /** When true, overwrite files that already exist. Default false. */
  force?: boolean;
  /** When true, run `cococo dump all` after scaffolding. */
  pull?: boolean;
  /** API overrides (endpoint/token) used when pull is true. */
  apiOverrides?: ConfigOverrides;
};

/**
 * Scaffold a fresh cococo workspace at `folderArg` (defaults to cwd).
 * Writes:
 *
 *  - package.json with @wearecococo/dev-cli as a devDependency
 *  - .env.example, .gitignore, tsconfig.json
 *  - 11 commented-out ops stubs at the repo root (ready to uncomment)
 *  - CLAUDE.md (when --claude-md, default on)
 *
 * No artifact folders are created here — that's still
 * `cococo init <handle> --type ...`. Bootstrap is project-level only.
 *
 * Existing files are preserved unless `--force` is set, so re-running
 * in a partially-set-up repo is safe.
 */
export async function runBootstrap(
  folderArg: string | undefined,
  opts: BootstrapOptions,
): Promise<void> {
  const target = resolve(process.cwd(), folderArg ?? ".");
  const force = opts.force ?? false;
  const writeClaudeMd = opts.claudeMd ?? true;

  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
  }

  const created: string[] = [];
  const skipped: string[] = [];

  const write = (relPath: string, content: string): void => {
    const abs = resolve(target, relPath);
    if (existsSync(abs) && !force) {
      skipped.push(relPath);
      return;
    }
    writeFileSync(abs, content);
    created.push(relPath);
  };

  write("package.json", PACKAGE_JSON_TEMPLATE);
  write(".env.example", ENV_EXAMPLE);
  write(".gitignore", GITIGNORE);
  write("tsconfig.json", TSCONFIG);

  for (const [filename, body] of OPS_STUBS) write(filename, body);

  if (writeClaudeMd) write("CLAUDE.md", CLAUDE_MD_TEMPLATE);

  console.log(`Bootstrapped ${target}`);
  if (created.length > 0) {
    console.log("  created:");
    for (const f of created) console.log(`    + ${f}`);
  }
  if (skipped.length > 0) {
    console.log("  skipped (already existed; use --force to overwrite):");
    for (const f of skipped) console.log(`    = ${f}`);
  }

  if (opts.pull) {
    console.log("");
    console.log("Pulling tenant state from server (--pull)…");
    // Force=true so the just-scaffolded empty stubs get replaced with
    // real data. Bootstrap users explicitly opted into this.
    await runDump("all", { force: true, cwd: target }, opts.apiOverrides ?? {});
  }

  console.log("");
  console.log("Next steps:");
  if (opts.pull) {
    console.log("  1. bun install");
    console.log("  2. Review the dumped ops files; replace any ${config:...} placeholders");
    console.log("  3. bunx cococo setup-mcp claude   # optional: register MCP for Claude Code");
    console.log("  4. bunx cococo init <handle> --type integration|app|edge|workflow   # scaffold an artifact");
  } else {
    console.log("  1. cp .env.example .env  # then fill in COCOCO_ENDPOINT and COCOCO_TOKEN");
    console.log("  2. bun install");
    console.log("  3. bunx cococo setup-mcp claude   # optional: register MCP for Claude Code");
    console.log("  4. bunx cococo init <handle> --type integration|app|edge|workflow   # scaffold an artifact");
  }
}

/**
 * `cococo claude-md [folder]` — drop CLAUDE.md into an existing
 * project (or refresh it via `--force`). Useful when bootstrapping
 * was skipped or run before this command existed.
 */
export async function runClaudeMd(
  folderArg: string | undefined,
  opts: { force?: boolean },
): Promise<void> {
  const target = resolve(process.cwd(), folderArg ?? ".");
  const dest = resolve(target, "CLAUDE.md");
  if (existsSync(dest) && !opts.force) {
    console.error(`CLAUDE.md already exists at ${dest}. Use --force to overwrite.`);
    process.exit(1);
  }
  if (!existsSync(target)) mkdirSync(target, { recursive: true });
  writeFileSync(dest, CLAUDE_MD_TEMPLATE);
  console.log(`Wrote ${dest}`);
}

const PACKAGE_JSON_TEMPLATE = `{
  "name": "cococo-workspace",
  "private": true,
  "type": "module",
  "scripts": {
    "push": "cococo push",
    "lint": "cococo lint",
    "apply": "cococo apply"
  },
  "devDependencies": {
    "@wearecococo/dev-cli": "github:wearecococo/dev-cli#main"
  }
}
`;

const ENV_EXAMPLE = `# cococo platform credentials. Copy to .env and fill in.
# Bun loads .env automatically; the CLI reads these env vars.
COCOCO_ENDPOINT=https://your-tenant.example.com/graphql
COCOCO_TOKEN=your-bearer-token
`;

const GITIGNORE = `node_modules/
.env
.env.local
dist/
*.log
.DS_Store
`;

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "types": ["bun-types"]
  },
  // Pick up node_modules/.ts sources, .ts files at the repo root, and
  // the workspace-side codegen output written by 'cococo update'. The
  // CLI's shipped baseline node-type registry is auto-loaded via a
  // triple-slash reference inside @wearecococo/dev-cli/define, so it
  // doesn't need to be listed here.
  "include": ["**/*.ts", ".cococo/generated/**/*.d.ts"],
  "exclude": ["node_modules"]
}
`;

/**
 * Stubs for every ops file. Default exports are empty arrays so apply
 * is a no-op until the user uncomments entries — the file existing on
 * disk is what makes it discoverable in editor tooling.
 */
const OPS_STUBS: Array<[string, string]> = [
  [
    "users.ts",
    stub(
      "defineUsers",
      `// { email: "alice@acme.com", name: "Alice", kind: "HUMAN" },
  // { email: "bot@acme.com",   name: "Webhook Bot", kind: "BOT", externalId: "svc_001" },`,
    ),
  ],
  [
    "iam_policies.ts",
    stub(
      "defineIAMPolicies",
      `// {
  //   handle: "press-operator",
  //   name: "Press Operator",
  //   statements: [
  //     { effect: "ALLOW", actions: ["job:read", "job:transition"], resources: ["*"] },
  //   ],
  // },`,
    ),
  ],
  [
    "iam_policy_bindings.ts",
    stub(
      "defineIAMPolicyBindings",
      `// { user: "alice@acme.com", policy: "press-operator" },`,
    ),
  ],
  [
    "networks.ts",
    stub(
      "defineNetworks",
      `// { name: "press-floor", description: "Production floor" },`,
    ),
  ],
  [
    "devices.ts",
    stub(
      "defineDevices",
      `// {
  //   identifier: "press-01",
  //   network: "press-floor",
  //   manufacturer: "Heidelberg",
  //   outboundProtocols: [
  //     { kind: "HTTP", url: "https://press-01.local", authMode: "BASIC", username: "ops", password: "\${config:PRESS_01_HTTP_PASSWORD}" },
  //   ],
  //   inboundProtocols: [
  //     { kind: "MQTT", topic: "press/01/telemetry" },
  //   ],
  // },`,
    ),
  ],
  [
    "teams.ts",
    stub(
      "defineTeams",
      `// {
  //   name: "press-operators",
  //   description: "Press floor crew",
  //   members: ["alice@acme.com"],
  // },`,
    ),
  ],
  [
    "custom_app_user_bindings.ts",
    stub(
      "defineCustomAppUserBindings",
      `// { user: "alice@acme.com", app: "job-board" },`,
    ),
  ],
  [
    "custom_app_team_bindings.ts",
    stub(
      "defineCustomAppTeamBindings",
      `// { team: "press-operators", app: "press-dashboard" },`,
    ),
  ],
  [
    "controllers.ts",
    stub(
      "defineControllers",
      `// {
  //   handle: "press-01",
  //   network: "press-floor",
  //   host: "192.168.1.10",
  //   port: 8443,
  //   policy: {
  //     allowedIoPaths: ["/var/log/door"],
  //     allowedExecBinaries: ["/usr/bin/ping"],
  //   },
  // },`,
    ),
  ],
  [
    "controller_tokens.ts",
    stub(
      "defineControllerTokens",
      `// { controller: "press-01", name: "primary" },`,
    ),
  ],
  [
    "edge_app_installations.ts",
    stub(
      "defineEdgeAppInstallations",
      `// {
  //   controller: "press-01",
  //   app: "door-monitor",
  //   version: 1,
  //   variables: { LOG_PATH: "/var/log/door" },
  // },`,
    ),
  ],
  [
    "integration_installations.ts",
    stub(
      "defineIntegrationInstallations",
      `// {
  //   integration: "com.acme.orders",
  //   name: "production",                  // (integration, name) is the natural key
  //   version: "1.4.0",                    // pinned to a published definition
  //   config: { batchSize: 100 },          // matches the integration's config_schema.json
  //   bindings: { ordersDb: "press-erp" }, // maps resources[].id → tenant resource
  //   isActive: true,
  // },`,
    ),
  ],
];

function stub(fn: string, exampleBody: string): string {
  return `import { ${fn} } from "@wearecococo/dev-cli/define";

// Uncomment entries below to declare them, then run \`cococo apply\`.
// See README + CLAUDE.md for the full field list.
export default ${fn}([
  ${exampleBody}
]);
`;
}
