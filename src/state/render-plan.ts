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
  return diff
    .map((d) => `      ${colour(d.path, C.bold)}: ${formatVal(d.lastApplied)} → ${formatVal(d.declared)}`)
    .join("\n");
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
