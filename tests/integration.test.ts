import {
  afterAll,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInit } from "../src/commands/init.ts";
import { runLint } from "../src/commands/lint.ts";
import { runList } from "../src/commands/list.ts";
import { runPublish } from "../src/commands/publish.ts";
import { runPull } from "../src/commands/pull.ts";
import { runPush } from "../src/commands/push.ts";
import { runStatus } from "../src/commands/status.ts";
import { runValidate } from "../src/commands/validate.ts";
import { loadConfig } from "../src/config.ts";
import { createClient } from "../src/graphql/client.ts";
import {
  deprecateDefinition,
  listDefinitions,
} from "../src/graphql/operations.ts";
import { MANIFEST_FILENAME, parseManifest, serializeManifest } from "../src/manifest.ts";

const ENABLED =
  process.env.COCOCO_INTEGRATION_TEST === "1" &&
  !!process.env.COCOCO_ENDPOINT &&
  !!process.env.COCOCO_TOKEN;

describe.skipIf(!ENABLED)("end-to-end against real server", () => {
  // Unique reverse-domain id per run so concurrent runs / past leaks don't collide.
  const stableId = `custom.cli-test-${Date.now()}`;
  const expectedFolder = stableId.split(".").pop()!; // e.g. cli-test-1700000000000

  let scratchA: string;
  let scratchB: string;
  let prevCwd: string;
  const createdIds: string[] = [];

  beforeAll(() => {
    prevCwd = process.cwd();
    scratchA = realpathSync(mkdtempSync(join(tmpdir(), "cococo-int-a-")));
    scratchB = realpathSync(mkdtempSync(join(tmpdir(), "cococo-int-b-")));
    process.chdir(scratchA);
  });

  afterAll(async () => {
    process.chdir(prevCwd);

    // Best-effort cleanup: deprecate every ACTIVE definition we created.
    // Drafts can't be deleted via the public API — they will leak.
    if (ENABLED && createdIds.length > 0) {
      const client = createClient(loadConfig());
      const active = await listDefinitions(client, {
        integrationId: stableId,
        status: "ACTIVE",
      });
      for (const d of active) {
        try {
          await deprecateDefinition(client, d.id);
        } catch {
          /* best effort */
        }
      }
    }

    rmSync(scratchA, { recursive: true, force: true });
    rmSync(scratchB, { recursive: true, force: true });
  });

  test("full lifecycle", async () => {
    const apiOpts = {};

    // 1. init scaffolds the folder. We pin --format yaml here because this
    //    end-to-end test exercises the YAML path explicitly via parseManifest
    //    / serializeManifest. The TS path has its own unit-test coverage in
    //    tests/loader.test.ts + tests/printer.test.ts.
    await runInit(stableId, { version: "0.1.0", format: "yaml" });
    const folderPath = join(scratchA, "integrations", expectedFolder);
    expect(existsSync(join(folderPath, MANIFEST_FILENAME))).toBe(true);
    expect(existsSync(join(folderPath, "handlers/timers/heartbeat.lua"))).toBe(true);
    const initialManifest = parseManifest(
      readFileSync(join(folderPath, MANIFEST_FILENAME), "utf8"),
    );
    expect((initialManifest as any).engine_version).toBe(2);

    // 2a. lint runs cleanly on the starter scaffold (handler files are
    //     ordinary .lua files, picked up by the existing walker).
    await runLint(expectedFolder, apiOpts);

    // 2b. push fails when Lua syntax is broken (pre-push lint catches it).
    //     Break the heartbeat handler to trip the lint gate, then restore.
    const heartbeat = join(folderPath, "handlers", "timers", "heartbeat.lua");
    const goodLua = readFileSync(heartbeat, "utf8");
    writeFileSync(heartbeat, "this is not lua\n");
    await expect(runPush(expectedFolder, apiOpts)).rejects.toThrow(/failed validation/i);
    writeFileSync(heartbeat, goodLua);

    // 2c. push creates a draft.
    await runPush(expectedFolder, apiOpts);

    // Verify a DRAFT exists.
    const client = createClient(loadConfig());
    let drafts = await listDefinitions(client, {
      integrationId: stableId,
      status: "DRAFT",
    });
    expect(drafts.length).toBe(1);
    expect(drafts[0]!.version).toBe("0.1.0");
    createdIds.push(drafts[0]!.id);

    // 3. status with no local edits → no diff.
    //    (We just confirm it doesn't throw; the diff output goes to console.)
    await runStatus(expectedFolder, apiOpts);

    // 4. add a file locally and push again → upload propagates.
    mkdirSync(join(folderPath, "scripts"), { recursive: true });
    writeFileSync(join(folderPath, "scripts/util.lua"), "-- util\nreturn {}");
    await runPush(expectedFolder, apiOpts);

    // 5. delete the new file and push → server-side delete propagates.
    rmSync(join(folderPath, "scripts/util.lua"));
    await runPush(expectedFolder, apiOpts);

    // 6. validate → must succeed.
    await runValidate(expectedFolder, apiOpts);

    // 7. publish → flips DRAFT to ACTIVE.
    await runPublish(expectedFolder, apiOpts);
    const active = await listDefinitions(client, {
      integrationId: stableId,
      status: "ACTIVE",
    });
    expect(active.length).toBe(1);
    expect(active[0]!.version).toBe("0.1.0");

    // 8. push to the now-ACTIVE version → must refuse.
    await expect(runPush(expectedFolder, apiOpts)).rejects.toThrow(/immutable|ACTIVE/i);

    // 9. bump version → new draft is created on push.
    const manifest = parseManifest(readFileSync(join(folderPath, MANIFEST_FILENAME), "utf8"));
    manifest.version = "0.1.1";
    writeFileSync(join(folderPath, MANIFEST_FILENAME), serializeManifest(manifest));
    await runPush(expectedFolder, apiOpts);
    drafts = await listDefinitions(client, {
      integrationId: stableId,
      status: "DRAFT",
    });
    expect(drafts.find((d) => d.version === "0.1.1")).toBeDefined();

    // 10. pull the new draft into a fresh scratch dir, in YAML format to
    //     match the parseManifest assertions below.
    process.chdir(scratchB);
    await runPull(
      stableId,
      { version: "0.1.1", force: false, format: "yaml" },
      apiOpts,
    );
    const pulledManifest = parseManifest(
      readFileSync(
        join(scratchB, "integrations", expectedFolder, MANIFEST_FILENAME),
        "utf8",
      ),
    );
    expect(pulledManifest.id).toBe(stableId);
    expect(pulledManifest.version).toBe("0.1.1");
    expect((pulledManifest as any).engine_version).toBe(2);
    // Pull materialised the heartbeat handler back to disk and stripped the
    // inline source from the manifest.
    expect(
      existsSync(
        join(scratchB, "integrations", expectedFolder, "handlers/timers/heartbeat.lua"),
      ),
    ).toBe(true);
    expect((pulledManifest as any).timers[0].source).toBeUndefined();

    // Restore cwd for any later tests.
    process.chdir(scratchA);

    // 11. list runs without throwing (output goes to console).
    await runList(apiOpts);
  }, 120_000);
});
