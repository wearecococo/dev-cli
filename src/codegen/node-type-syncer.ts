/**
 * Workspace syncer for workflow node-type configs. Pulls the live
 * workflow schema, extracts per-node sub-schemas, and emits
 * `.cococo/generated/node-types.d.ts` under the
 * `WorkspaceNodeTypeRegistry` interface (so it never collides with
 * the shipped baseline).
 */

import { getWorkflowSchema } from "../graphql/operations.ts";
import { extractNodeSchemas, type NodeSchemaMap } from "./extract-node-schemas.ts";
import { emitNodeTypes } from "./schema-emitter.ts";
import { stableDigest, type GeneratedFile, type Syncer } from "../update.ts";

const OUTPUT_PATH = ".cococo/generated/node-types.d.ts";

export const nodeTypeSyncer: Syncer<NodeSchemaMap> = {
  name: "node-types",
  description: "Workflow node config types from the tenant's workflow schema",

  async fetch(client) {
    const raw = await getWorkflowSchema(client);
    return extractNodeSchemas(raw);
  },

  generate(schemas, digest): GeneratedFile[] {
    const content = emitNodeTypes(schemas, {
      digest,
      registry: "WorkspaceNodeTypeRegistry",
    });
    return [{ path: OUTPUT_PATH, content }];
  },

  digest(schemas) {
    return stableDigest(schemas);
  },
};
