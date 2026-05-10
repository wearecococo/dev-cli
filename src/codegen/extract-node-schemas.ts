/**
 * Pull per-node-type config sub-schemas out of the monolithic workflow
 * JSON Schema returned by `getWorkflowSchema()`. Each entry under
 * `$defs` that carries an `x-nodeType` extension is a node config —
 * the value of `x-nodeType` is the canonical type identifier
 * (matches the `type:` field on workflow nodes).
 *
 * The non-node `$defs` entries (`node`, `edge`, `variable`,
 * `workflowValue`) describe the workflow envelope itself and are
 * skipped — they don't carry `x-nodeType`.
 */

export type NodeSchemaMap = Record<string, Record<string, unknown>>;

export function extractNodeSchemas(rawSchema: string): NodeSchemaMap {
  const parsed = JSON.parse(rawSchema) as { $defs?: Record<string, unknown> };
  const defs = parsed.$defs;
  if (!defs || typeof defs !== "object") {
    throw new Error(
      `Workflow schema has no $defs block — can't extract node configs. ` +
        `Server may have changed shape.`,
    );
  }

  const out: NodeSchemaMap = {};
  for (const def of Object.values(defs)) {
    if (!def || typeof def !== "object") continue;
    const obj = def as Record<string, unknown>;
    const nodeType = obj["x-nodeType"];
    if (typeof nodeType !== "string" || nodeType.length === 0) continue;
    out[nodeType] = obj;
  }

  if (Object.keys(out).length === 0) {
    throw new Error(
      `No node-type sub-schemas found under $defs. Expected entries with ` +
        `'x-nodeType' set.`,
    );
  }
  return out;
}
