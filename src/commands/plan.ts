import { createClient } from "../graphql/client.ts";
import { loadConfig, type ConfigOverrides } from "../config.ts";
import { loadOps } from "../ops.ts";
import { LocalFileStateBackend } from "../state/local-backend.ts";
import { fetchLiveSnapshot } from "../state/live-fetch.ts";
import { computePlan } from "../state/plan.ts";
import { renderPlan, renderPlanJson } from "../state/render-plan.ts";

export type PlanCommandOptions = {
  json: boolean;
  verbose: boolean;
};

/**
 * `cococo plan` — read-only preview of state-tracking apply. Produces
 * the same diff `cococo apply` would compute, but mutates nothing.
 *
 * Requires a state file. Without one, point the user at
 * `cococo state import` (the explicit adoption path).
 */
export async function runPlan(
  opts: PlanCommandOptions,
  overrides: ConfigOverrides,
): Promise<void> {
  const backend = new LocalFileStateBackend(process.cwd());
  const state = await backend.read();
  if (!state) {
    console.error(
      `cococo plan: no state file at .cococo/state.json. ` +
        `State-tracking is opt-in — run 'cococo state import' to adopt your ` +
        `current tenant config into managed state, then re-run plan.`,
    );
    process.exit(1);
  }

  const ops = await loadOps(process.cwd());
  const client = createClient(loadConfig(overrides));
  const live = await fetchLiveSnapshot(client, ops, state);
  const plan = computePlan(ops, state, live);

  if (opts.json) {
    process.stdout.write(renderPlanJson(plan));
    return;
  }

  process.stdout.write(
    renderPlan(plan, { verbose: opts.verbose, noColor: !process.stdout.isTTY }),
  );
}
