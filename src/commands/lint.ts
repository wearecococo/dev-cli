import { createClient, type GraphQLClient } from "../graphql/client.ts";
import {
  validateLua,
  type LuaDiagnostic,
  type LuaSeverity,
} from "../graphql/operations.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { resolveIntegrationFolder, walkIntegrationFiles } from "../project.ts";
import { loadManifest } from "../loader.ts";
import { collectLuaChecks, type LuaCheck } from "../lua-checks.ts";

export type LintOptions = {
  /**
   * Treat warnings as failures. Maps to `strict: true` on the validator
   * input — the API still reports the same diagnostics, but `success`
   * comes back false when any warning is present.
   */
  strict?: boolean;
};

export type LintFinding = {
  check: LuaCheck;
  diagnostics: LuaDiagnostic[];
};

export async function runLint(
  folderArg: string | undefined,
  opts: LintOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const findings = await runLintFindings(folderArg, opts, overrides);

  if (findings.length === 0) {
    console.log("Lua: all chunks valid.");
    return;
  }

  reportLintFindings(findings);

  const errorCount = findings.reduce(
    (n, f) => n + f.diagnostics.filter((d) => d.severity === "ERROR").length,
    0,
  );
  const warningCount = findings.reduce(
    (n, f) => n + f.diagnostics.filter((d) => d.severity === "WARNING").length,
    0,
  );

  console.error(
    `\n${pluralise(errorCount, "error")}, ${pluralise(warningCount, "warning")} ` +
      `across ${pluralise(findings.length, "chunk")}.`,
  );

  if (errorCount > 0 || (opts.strict && warningCount > 0)) {
    process.exit(1);
  }
}

/**
 * Headless variant — collects + runs the validator and returns the
 * findings without any console output or process.exit. Used by `push`
 * so the pre-push lint pass can throw an Error and be handled
 * uniformly with the rest of push's error model.
 */
export async function runLintFindings(
  folderArg: string | undefined,
  opts: LintOptions,
  overrides: ConfigOverrides,
): Promise<LintFinding[]> {
  const folder = resolveIntegrationFolder(folderArg);
  const loaded = await loadManifest(folder.path);
  const walked = walkIntegrationFiles(folder);
  const checks = collectLuaChecks({
    loaded,
    folderPath: folder.path,
    walkedFiles: walked,
  });
  if (checks.length === 0) return [];
  const client = createClient(loadConfig(overrides));
  return await validateChecks(client, checks, opts.strict ?? false);
}

async function validateChecks(
  client: GraphQLClient,
  checks: LuaCheck[],
  strict: boolean,
): Promise<LintFinding[]> {
  // Run in parallel — each check is a single GraphQL request and the
  // server validates them independently, so there's no benefit to
  // serialising. Bound the concurrency in future if it becomes an issue.
  const results = await Promise.all(
    checks.map(async (check) => {
      const result = await validateLua(client, {
        source: check.source,
        role: check.role,
        scriptName: check.scriptName,
        strict,
      });
      // The server returns its full diagnostic list regardless of
      // strict; `success` is what flips. We surface every diagnostic
      // we got — strict only changes the exit code, not the report.
      if (result.diagnostics.length === 0) return null;
      return { check, diagnostics: result.diagnostics } as LintFinding;
    }),
  );
  return results.filter((r): r is LintFinding => r !== null);
}

export function reportLintFindings(findings: LintFinding[]): void {
  for (const finding of findings) {
    const header = headerFor(finding.check);
    for (const d of finding.diagnostics) {
      console.error(`${header}:${d.line}:${d.column}  ${formatSeverity(d.severity)}  ${d.message}${formatCode(d.code)}`);
    }
  }
}

/**
 * The location prefix shown on each diagnostic line. For file-backed
 * checks this is the relative path; for tag-backed manifest sources
 * it's `manifest.ts:<field>` so the user can find the right
 * `lua\`...\`` snippet at a glance.
 */
function headerFor(check: LuaCheck): string {
  if (check.origin.kind === "file") return check.origin.relativePath;
  return `manifest.ts:${check.origin.field}`;
}

function formatSeverity(s: LuaSeverity): string {
  return s === "ERROR" ? "ERROR  " : "WARNING";
}

function formatCode(code: string | null | undefined): string {
  return code ? `  [${code}]` : "";
}

function pluralise(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
