import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveIntegrationFolder } from "../project.ts";
import {
  MANIFEST_FILENAME,
  manifestEngineVersion,
  parseManifest,
} from "../manifest.ts";
import { extractManifestSources } from "../sources.ts";
import { printManifestTs } from "../printer.ts";
import { MANIFEST_TS_FILENAME } from "../loader.ts";
import { assertDevCliResolvable } from "../dev-cli-resolution.ts";
import { runLint } from "./lint.ts";
import type { ConfigOverrides } from "../config.ts";

const TIMER_PLACEHOLDER = `-- TODO: migrated handler — populated by 'cococo migrate'
local name, config = ...
`;

const SUBSCRIPTION_PLACEHOLDER = `-- TODO: migrated handler — populated by 'cococo migrate'
local event, config = ...
`;

export type Skeleton = {
  /** Absolute path of the v1 source folder. */
  sourcePath: string;
  /** Absolute path of the freshly-created v2 sibling folder. */
  targetPath: string;
  /** Old → new version (bumped). */
  oldVersion: string;
  newVersion: string;
  /** Number of placeholder handler files written. */
  placeholderCount: number;
  /** Prompt to feed `claude -p` to fill in the placeholder bodies. */
  prompt: string;
};

/**
 * Pre-flight + bundle-copy + skeleton step of `cococo migrate`.
 *
 * Split out from `runMigrate` so it's testable without depending on
 * Claude Code being installed locally. After this function returns, the
 * v2 sibling folder is on disk with a TS manifest skeleton, materialised
 * placeholder handler files, and all bundle artefacts copied across.
 * Only the Lua handler *bodies* are still TODO stubs.
 */
export function prepareV2Skeleton(folderArg: string | undefined): Skeleton {
  // The v2 folder will get a `manifest.ts` that imports from
  // `@wearecococo/dev-cli/define`. If that's not installed in the
  // consumer repo, push will later crash on dynamic-import — fail fast
  // here with the install hint.
  assertDevCliResolvable(process.cwd());

  const source = resolveIntegrationFolder(folderArg);
  const sourceManifestPath = join(source.path, MANIFEST_FILENAME);
  if (!existsSync(sourceManifestPath)) {
    throw new Error(
      `${source.path} doesn't have a ${MANIFEST_FILENAME} — nothing to migrate. ` +
        `'cococo migrate' converts v1 YAML integrations to v2 TS.`,
    );
  }

  const sourceMain = join(source.path, "scripts", "main.lua");
  if (!existsSync(sourceMain)) {
    throw new Error(
      `${source.path} doesn't have scripts/main.lua — there's no v1 entry script ` +
        `to migrate.`,
    );
  }

  const manifest = parseManifest(readFileSync(sourceManifestPath, "utf8"));
  if (manifestEngineVersion(manifest) !== 1) {
    throw new Error(
      `${source.path}/${MANIFEST_FILENAME} is engine_version 2 — already migrated.`,
    );
  }

  const targetPath = `${source.path}_v2`;
  if (existsSync(targetPath)) {
    throw new Error(
      `${targetPath} already exists. Remove it first, or migrate to a fresh location.`,
    );
  }

  // Mirror the source folder, omitting the two artefacts that are getting
  // rewritten by the migration: manifest.yaml and scripts/main.lua. Other
  // scripts/<name>.lua files stay put — v2 still resolves them via
  // ctx.script.load(name) as a legacy fallback.
  cpSync(source.path, targetPath, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(source.path.length).replace(/^[/\\]/, "");
      if (rel === MANIFEST_FILENAME) return false;
      if (rel === "scripts/main.lua") return false;
      return true;
    },
  });

  const newVersion = bumpMinor(manifest.version);
  const skeleton = buildSkeleton(manifest, newVersion);
  writeFileSync(join(targetPath, MANIFEST_TS_FILENAME), printManifestTs(skeleton));

  // Materialise placeholder handler files so the skeleton is lint-ready
  // before Claude rewrites them. extractManifestSources gives us the
  // path → content map straight from the wire manifest.
  const { files: placeholderFiles } = extractManifestSources(skeleton);
  for (const [path, content] of placeholderFiles) {
    const abs = join(targetPath, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const mainLua = readFileSync(sourceMain, "utf8");
  const prompt = buildPrompt({ targetPath, manifest, newVersion, mainLua });

  return {
    sourcePath: source.path,
    targetPath,
    oldVersion: manifest.version,
    newVersion,
    placeholderCount: placeholderFiles.size,
    prompt,
  };
}

export async function runMigrate(
  folderArg: string | undefined,
  overrides: ConfigOverrides,
): Promise<void> {
  const { sourcePath, targetPath, oldVersion, newVersion, placeholderCount, prompt } =
    prepareV2Skeleton(folderArg);

  console.log(
    `Skeleton ready at integrations/${basename(targetPath)}/ ` +
      `(version ${oldVersion} → ${newVersion}, ${placeholderCount} handler placeholder(s)).`,
  );

  void sourcePath; // (only used for logging in some paths; reserved for future use)

  console.log(`Running 'claude -p' to migrate handler bodies…\n`);
  const result = spawnSync(
    "claude",
    [
      "-p",
      "--add-dir",
      targetPath,
      "--tools",
      "Read,Edit,Write,Bash",
      "--permission-mode",
      "acceptEdits",
    ],
    {
      input: prompt,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );

  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    printClaudeFallback(targetPath, prompt);
    return;
  }
  if (result.status !== 0) {
    throw new Error(
      `claude -p exited with code ${result.status}. The skeleton at ${targetPath} ` +
        `is intact — fix the handlers manually or re-run 'cococo migrate' after ` +
        `removing it.`,
    );
  }

  // ── Post-validate ────────────────────────────────────────────────────
  console.log(`\nLinting migrated Lua…`);
  await runLint(targetPath, {}, overrides);

  console.log(
    `\nMigrated to integrations/${basename(targetPath)}/. Review the diff, ` +
      `then run 'cococo push integrations/${basename(targetPath)}' to push the ` +
      `v2 draft (now at version ${newVersion}). The original v1 folder is ` +
      `untouched — delete it once you're happy.`,
  );
  void sourcePath;
}

/**
 * Bump a semver version's minor and reset patch.
 * `0.1.0` → `0.2.0`, `1.4.7` → `1.5.0`. Pre-release / build metadata is
 * dropped (standard semver behaviour for a minor bump).
 */
export function bumpMinor(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) {
    throw new Error(
      `Cannot bump unparseable version '${version}'. Expected semver MAJOR.MINOR.PATCH.`,
    );
  }
  const major = parseInt(m[1]!, 10);
  const minor = parseInt(m[2]!, 10);
  return `${major}.${minor + 1}.0`;
}

/**
 * Build a v2 wire manifest from a v1 manifest plus a bumped version.
 * Each timer / subscription gets a placeholder source — the printer then
 * emits a `luaFile()` ref for every non-empty source, and
 * `extractManifestSources` materialises the placeholder content to disk.
 */
function buildSkeleton(v1: Record<string, unknown>, newVersion: string): any {
  const skeleton: Record<string, unknown> = {
    id: v1.id,
    version: newVersion,
    engine_version: 2,
    sdk_version: v1.sdk_version ?? "1.0",
    runtime_mode: v1.runtime_mode ?? "script_actor",
    resources: v1.resources ?? [],
    permissions: v1.permissions ?? [],
  };
  if (typeof v1.description === "string") skeleton.description = v1.description;

  const v1Timers = Array.isArray(v1.timers) ? v1.timers : [];
  skeleton.timers = (v1Timers as Array<Record<string, unknown>>).map((t) => ({
    ...t,
    source: TIMER_PLACEHOLDER,
  }));

  const v1Subs = Array.isArray(v1.subscriptions) ? v1.subscriptions : [];
  skeleton.subscriptions = (v1Subs as Array<Record<string, unknown>>).map((s) => ({
    ...s,
    source: SUBSCRIPTION_PLACEHOLDER,
  }));

  return skeleton;
}

function buildPrompt(args: {
  targetPath: string;
  manifest: Record<string, unknown>;
  newVersion: string;
  mainLua: string;
}): string {
  const { targetPath, manifest, newVersion, mainLua } = args;
  const timers = Array.isArray(manifest.timers) ? manifest.timers : [];
  const subs = Array.isArray(manifest.subscriptions) ? manifest.subscriptions : [];

  const timerLines = (timers as Array<{ name: string }>)
    .map((t) => `  - timer '${t.name}' → handlers/timers/${t.name}.lua`)
    .join("\n");
  const subLines = (subs as Array<{ topic: string }>)
    .map((s) => `  - subscription '${s.topic}' → handlers/subscriptions/${s.topic}.lua`)
    .join("\n");

  return `You are migrating a v1 cococo integration to v2 in the folder:

  ${targetPath}

The integration's id is ${manifest.id}, version ${newVersion} (was ${manifest.version}).

A v2 skeleton has already been generated for you:
- manifest.ts (with engineVersion: 2 and luaFile() refs to each handler file below)
${timerLines || "  (no timers)"}
${subLines || "  (no subscriptions)"}

Each placeholder handler file currently contains a TODO stub. Your job is
to replace each stub with the corresponding code from the original v1
entry script (provided below).

## v1 → v2 mapping

v1 puts every hook on a global \`exports\` table on \`scripts/main.lua\`,
and the runtime dispatches via \`exports.<hook>\` lookup. v2 has no entry
script — each timer, subscription, and lifecycle hook is its own Lua chunk
declared inline on the manifest, materialised on disk under handlers/,
lifecycle/, and libraries/.

| v1                                          | v2                                                                          |
|---------------------------------------------|-----------------------------------------------------------------------------|
| \`exports.on_timer(ctx, timer)\` body, branched on \`timer.name\`  | one chunk per branch at \`handlers/timers/<name>.lua\`. Args: \`local name, config = ...\`. |
| \`exports.on_event(ctx, event)\` body, branched on \`event.topic\` | one chunk per branch at \`handlers/subscriptions/<topic>.lua\`. Args: \`local event, config = ...\`. |
| \`exports.init(ctx, config)\` body          | \`lifecycle/init.lua\` chunk. Args: \`local config = ...\`. Add \`initSource: luaFile("./lifecycle/init.lua")\` to manifest.ts. |
| \`exports.shutdown(ctx, config)\` body      | \`lifecycle/shutdown.lua\` chunk. Args: \`local config = ...\`. Add \`shutdownSource: luaFile("./lifecycle/shutdown.lua")\` to manifest.ts. |
| Top-level helpers used by **multiple** hooks | \`libraries/<name>.lua\` returning a module table. Load in handlers via \`local helpers = ctx.script.load("<name>")\`. Add a \`libraries: { <name>: luaFile("./libraries/<name>.lua") }\` entry to manifest.ts. |
| Top-level helpers used by **one** hook       | inline into that handler's chunk. |
| \`ctx.<api>\` calls                         | unchanged — same API surface in both engines. |

## Critical rules

1. **Each handler chunk is its own Lua chunk.** Top-level locals and
   functions in the v1 main.lua are NOT in scope inside the chunks. You
   MUST inline them or promote them to manifest.libraries.
2. **\`exports = {}\` and the \`exports.<hook>\` assignments themselves
   disappear** — there is no exports table in v2.
3. **Don't change behaviour.** Preserve every branch, log, comparison,
   and side effect from the original. This is a relocation, not a rewrite.
4. **Read manifest.ts first** to understand the imports and exact names
   of timers / subscriptions you're populating. Use the Edit tool to add
   \`initSource\` / \`shutdownSource\` / \`libraries\` fields if needed.

## v1 entry script (scripts/main.lua)

\`\`\`lua
${mainLua}
\`\`\`

## Steps

1. Read \`manifest.ts\` so you know the timer names, subscription topics,
   and existing imports.
2. For each placeholder file under \`handlers/timers/\` and
   \`handlers/subscriptions/\`, replace its contents with the corresponding
   branch body from the v1 script. Adjust the leading \`local\` line if
   you need access to the timer/event arg.
3. If the v1 script defines \`exports.init\` or \`exports.shutdown\`,
   create \`lifecycle/init.lua\` / \`lifecycle/shutdown.lua\` and add
   \`initSource\` / \`shutdownSource\` to manifest.ts.
4. Identify any top-level helper used by more than one hook. Move it to
   \`libraries/<descriptive-name>.lua\` (returning a module table), update
   call sites to \`local x = ctx.script.load("<descriptive-name>")\`, and
   add the \`libraries\` entry to manifest.ts.
5. Stop when every handler runs the same logic it ran in v1.

Don't write a summary — the calling CLI runs \`cococo lint\` automatically
once you exit.
`;
}

function printClaudeFallback(targetPath: string, prompt: string): void {
  const promptPath = resolve(targetPath, ".cococo-migrate-prompt.txt");
  writeFileSync(promptPath, prompt);
  console.error(
    `\nThe 'claude' CLI is not on PATH. The skeleton is ready at ${targetPath} ` +
      `but the handler bodies still contain TODO placeholders.\n\n` +
      `To finish migration, install Claude Code and run:\n\n` +
      `  cat ${promptPath} | claude -p \\\n` +
      `    --add-dir ${targetPath} \\\n` +
      `    --tools "Read,Edit,Write,Bash" \\\n` +
      `    --permission-mode acceptEdits\n\n` +
      `Or paste the prompt at ${promptPath} into Claude Code manually.`,
  );
}
