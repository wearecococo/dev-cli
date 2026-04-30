import { readFileSync } from "node:fs";
import { createClient } from "../graphql/client.ts";
import {
  validateLuaScript,
  type FieldError,
} from "../graphql/operations.ts";
import type { GraphQLClient } from "../graphql/client.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { walkIntegrationFiles } from "../project.ts";
import { loadLocal } from "./_shared.ts";

export type LintFinding = { path: string; errors: FieldError[] };

/** Filter a path → abs map down to .lua files. */
export function findLuaFiles(files: Map<string, string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [path, abs] of files) {
    if (path.endsWith(".lua")) out.set(path, abs);
  }
  return out;
}

/**
 * Validate every .lua file via validateLuaScript. Returns one entry per file
 * that has errors; files with no errors are omitted. Calls run in parallel.
 */
export async function lintLuaFiles(
  client: GraphQLClient,
  luaFiles: Map<string, string>,
): Promise<LintFinding[]> {
  const checks = Array.from(luaFiles, async ([path, abs]): Promise<LintFinding | null> => {
    const script = readFileSync(abs, "utf8");
    const result = await validateLuaScript(client, script);
    if (result.success) return null;
    return { path, errors: result.errors };
  });
  const results = await Promise.all(checks);
  return results.filter((r): r is LintFinding => r !== null);
}

export function reportLintFindings(findings: LintFinding[]): void {
  for (const f of findings) {
    console.error(`${f.path}:`);
    for (const e of f.errors) {
      console.error(`  ${e.path}: ${e.message}`);
    }
  }
}

export async function runLint(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { folder } = loadLocal(folderArg);
  const client = createClient(loadConfig(overrides));

  const luaFiles = findLuaFiles(walkIntegrationFiles(folder));
  if (luaFiles.size === 0) {
    console.log("No .lua files found.");
    return;
  }

  const findings = await lintLuaFiles(client, luaFiles);
  if (findings.length === 0) {
    console.log(`${luaFiles.size} .lua file(s) checked: all valid.`);
    return;
  }

  reportLintFindings(findings);
  console.error(`\n${findings.length} of ${luaFiles.size} file(s) failed validation.`);
  process.exit(1);
}
