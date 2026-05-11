/**
 * Render a `Plan` for human and machine consumers. Terraform-style:
 * `+` create, `~` update, `-` destroy, optional `=` noop. Update lines
 * are followed by per-field diffs indented two spaces.
 *
 * Pure with respect to ANSI colour — colour codes are added by
 * `colorize` calls and can be stripped (via `noColor`) for tests and
 * non-TTY output.
 */

import {
  identityLabel,
  type ResourceIdentity,
} from "./types.ts";
import type { FieldDiff, Plan, PlanAction } from "./plan.ts";

export type RenderOptions = {
  /** Show noop entries in the output. */
  verbose?: boolean;
  /** Strip ANSI colour codes. */
  noColor?: boolean;
};

const C = {
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  gray: "\x1b[90m",
  bold: "\x1b[1m",
  reset: "\x1b[0m",
};

export function renderPlan(plan: Plan, opts: RenderOptions = {}): string {
  const out: string[] = [];
  const lines = (s: string) => out.push(s);
  const colour = (s: string, code: string) => (opts.noColor ? s : `${code}${s}${C.reset}`);

  lines(colour("Tenant config plan", C.bold));
  lines("==================");
  lines("");

  const counts = { create: 0, update: 0, destroy: 0, noop: 0 };
  let printed = 0;

  for (const action of plan.actions) {
    if (action.op === "noop") {
      counts.noop++;
      if (!opts.verbose) continue;
    } else {
      counts[action.op === "delete" ? "destroy" : action.op]++;
    }
    printed++;
    lines(formatAction(action, colour));
  }

  if (printed === 0) {
    lines(colour("(no changes)", C.gray));
  }

  lines("");
  lines(
    `Plan: ${counts.create} to create, ${counts.update} to update, ` +
      `${counts.destroy} to destroy${
        counts.noop > 0 ? `, ${counts.noop} unchanged` : ""
      }.`,
  );
  return out.join("\n") + "\n";
}

function formatAction(
  action: PlanAction,
  colour: (s: string, code: string) => string,
): string {
  const label = `${kindLabel(action.identity.kind)}  ${identityLabel(action.identity)}`;

  switch (action.op) {
    case "create":
      return colour(`  + ${label}`, C.green);
    case "update": {
      const head =
        colour(`  ~ ${label}`, C.yellow) +
        (action.serverModified ? colour("  (server modified)", C.gray) : "");
      const body = formatDiffLines(action.diff, colour);
      return body ? `${head}\n${body}` : head;
    }
    case "delete":
      return colour(`  - ${label}`, C.red);
    case "noop":
      return colour(`  = ${label}`, C.gray);
  }
}

function formatDiffLines(
  diff: FieldDiff[],
  colour: (s: string, code: string) => string,
): string {
  const lines: string[] = [];
  for (const d of diff) {
    // For collection-shaped fields, expand the diff with one + / - line
    // per element. For team `members`, controller `policy.allowedIoPaths`,
    // IAM `statements`, etc. — these are the things the user actually
    // wants to see at a glance.
    const expanded = tryExpandCollectionDiff(d, colour);
    if (expanded.length > 0) {
      lines.push(`      ${colour(d.path, C.bold)}:`);
      for (const e of expanded) lines.push(`        ${e}`);
      continue;
    }
    lines.push(
      `      ${colour(d.path, C.bold)}: ${formatVal(d.lastApplied)} → ${formatVal(d.declared)}`,
    );
  }
  return lines.join("\n");
}

/**
 * If a diff entry is for a collection-shaped field (`members`,
 * `allowedIoPaths`, `statements`, etc.), expand it as one + / - line
 * per element so the user can see what actually changed without
 * cross-referencing two opaque arrays.
 *
 * Returns an empty array if the field shouldn't be expanded — caller
 * falls back to the scalar-summary line.
 */
function tryExpandCollectionDiff(
  d: FieldDiff,
  colour: (s: string, code: string) => string,
): string[] {
  const lastArr = Array.isArray(d.lastApplied) ? d.lastApplied : null;
  const declaredArr = Array.isArray(d.declared) ? d.declared : null;
  if (lastArr || declaredArr) {
    return arrayDiffLines(lastArr ?? [], declaredArr ?? [], colour);
  }
  // Nested object with array fields underneath (e.g. controller `policy`).
  // Expand one level of nesting.
  if (
    d.lastApplied &&
    typeof d.lastApplied === "object" &&
    d.declared &&
    typeof d.declared === "object" &&
    !Array.isArray(d.lastApplied) &&
    !Array.isArray(d.declared)
  ) {
    const out: string[] = [];
    const keys = new Set<string>([
      ...Object.keys(d.lastApplied as object),
      ...Object.keys(d.declared as object),
    ]);
    for (const k of [...keys].sort()) {
      const lastV = (d.lastApplied as Record<string, unknown>)[k];
      const declaredV = (d.declared as Record<string, unknown>)[k];
      if (deepEqualSimple(lastV, declaredV)) continue;
      if (Array.isArray(lastV) || Array.isArray(declaredV)) {
        out.push(`${colour(k, C.bold)}:`);
        for (const line of arrayDiffLines(
          Array.isArray(lastV) ? lastV : [],
          Array.isArray(declaredV) ? declaredV : [],
          colour,
        )) {
          out.push(`  ${line}`);
        }
      } else {
        out.push(`${colour(k, C.bold)}: ${formatVal(lastV)} → ${formatVal(declaredV)}`);
      }
    }
    return out;
  }
  return [];
}

function arrayDiffLines(
  before: unknown[],
  after: unknown[],
  colour: (s: string, code: string) => string,
): string[] {
  const beforeKeys = new Map<string, unknown>();
  for (const v of before) beforeKeys.set(elementKey(v), v);
  const afterKeys = new Map<string, unknown>();
  for (const v of after) afterKeys.set(elementKey(v), v);

  const lines: string[] = [];
  for (const [k, v] of beforeKeys) {
    if (!afterKeys.has(k)) {
      lines.push(colour(`- ${formatElement(v)}`, C.red));
    }
  }
  for (const [k, v] of afterKeys) {
    if (!beforeKeys.has(k)) {
      lines.push(colour(`+ ${formatElement(v)}`, C.green));
    }
  }
  return lines;
}

/**
 * Stable string key for an array element. Strings and numbers are
 * themselves the key; objects fall back to canonical JSON. Used to
 * detect "same logical entry" when computing + / - element diffs so
 * we don't flag re-orderings as changes.
 */
function elementKey(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  if (typeof v !== "object") return String(v);
  // Stable JSON: sort keys so {a, b} and {b, a} match.
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return JSON.stringify(keys.map((k) => [k, obj[k]]));
}

function formatElement(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return String(v);
  if (typeof v === "object" && !Array.isArray(v)) {
    // Render object elements as one-line inline JSON for compactness
    // — most diffs are 1-3 fields per element.
    return JSON.stringify(v);
  }
  return JSON.stringify(v);
}

function deepEqualSimple(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!deepEqualSimple(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

function formatVal(v: unknown): string {
  if (v === undefined) return "<unset>";
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (v.length <= 4 && v.every((x) => typeof x === "string")) {
      return JSON.stringify(v);
    }
    return `[${v.length} item${v.length === 1 ? "" : "s"}]`;
  }
  if (typeof v === "object") {
    const keys = Object.keys(v as object);
    if (keys.length === 0) return "{}";
    return `{${keys.length} field${keys.length === 1 ? "" : "s"}}`;
  }
  return String(v);
}

function kindLabel(kind: ResourceIdentity["kind"]): string {
  // Pad to a stable column width so listings line up.
  return kind.padEnd(28);
}

/**
 * Machine-readable representation. Suitable for piping into other
 * tools, including a future `cococo apply --plan-file plan.json` flow.
 */
export function renderPlanJson(plan: Plan): string {
  return JSON.stringify(plan, null, 2) + "\n";
}
