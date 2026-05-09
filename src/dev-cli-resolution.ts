import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";

const PACKAGE_NAME = "@wearecococo/dev-cli";
const DEFINE_SUBPATH = `${PACKAGE_NAME}/define`;

/**
 * Throw a friendly error if `@wearecococo/dev-cli/define` cannot be
 * imported from `fromDir`. The check is run by `cococo init --format ts`
 * before scaffolding so the user finds out *now* — when they can fix it
 * with one `bun add` — rather than later, when the first `cococo push`
 * tries to dynamic-import their freshly-scaffolded manifest and crashes
 * with a stock module-resolution error.
 *
 * Two paths to "resolvable":
 *
 *  1. Bun can resolve the subpath. This catches `bun install` (in the
 *     consumer repo's `node_modules`), `bun link`, and self-resolution
 *     when the CLI is being run from the dev-cli repo itself.
 *  2. Walk up the directory chain looking for a `package.json` that
 *     lists `@wearecococo/dev-cli` in `dependencies`/`devDependencies`.
 *     This covers the "ran `cococo init` before `bun install`" case —
 *     deps declared but not yet installed — where the install command
 *     is staring the user in the face.
 *
 * Either path passes; both failing is the error case.
 */
export function assertDevCliResolvable(fromDir: string): void {
  if (canResolveDevCli(fromDir)) return;
  if (devCliDeclaredInPackageJson(fromDir)) return;

  throw new Error(
    `${PACKAGE_NAME} is not installed in ${fromDir}.\n\n` +
      `manifest.ts imports defineIntegration / lua / luaFile from this package, ` +
      `so it must be a (dev)dependency of your integrations monorepo for ` +
      `'cococo push' to load the manifest.\n\n` +
      `Install with:\n\n` +
      `  bun add -d ${PACKAGE_NAME}@github:wearecococo/dev-cli#main\n\n` +
      `…or pass '--format yaml' to scaffold a YAML manifest instead (no package required).`,
  );
}

function canResolveDevCli(fromDir: string): boolean {
  // Bun.resolveSync is available everywhere this CLI runs (Bun-only via
  // bin/index.ts). It mirrors Node-style resolution including walking
  // up node_modules and honouring `exports`, so this is the single
  // most truthful "will the import work?" check available.
  try {
    Bun.resolveSync(DEFINE_SUBPATH, fromDir);
    return true;
  } catch {
    return false;
  }
}

function devCliDeclaredInPackageJson(fromDir: string): boolean {
  let dir = fromDir;
  while (true) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          name?: string;
        };
        if (
          pkg.dependencies?.[PACKAGE_NAME] !== undefined ||
          pkg.devDependencies?.[PACKAGE_NAME] !== undefined
        ) {
          return true;
        }
        // The dev-cli package itself: self-resolution is fine for
        // anyone hacking on this repo directly.
        if (pkg.name === PACKAGE_NAME) return true;
      } catch {
        // Malformed package.json — keep walking up rather than abort.
      }
    }
    const parent = dirname(dir);
    if (parent === dir || parent === parse(dir).root) return false;
    dir = parent;
  }
}
