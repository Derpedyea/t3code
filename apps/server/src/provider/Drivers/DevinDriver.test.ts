import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DevinSkills from "./DevinSkills.ts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { DevinDriver } from "./DevinDriver.ts";
import { MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER } from "../ProviderDriver.ts";
import {
  makeDevinCli as makeHarness,
  devinTestLayer as layer,
  devinTestSkills,
} from "../testUtils/devinCli.ts";
const threadId = ThreadId.make("devin-thread");
const instanceId = ProviderInstanceId.make("devin-account");
const driverLayer = layer.pipe(
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);

it.effect("bounds workspace metadata and evicts commands with the oldest skills", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_DEVIN_AUTH_STATUS: "Logged in (via Devin)." });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const instance = yield* DevinDriver.create({
      instanceId,
      displayName: "Devin test account",
      enabled: true,
      config: h.settings,
      environment: [],
    });
    const snapshotForCwd = instance.snapshotForCwd;
    if (!snapshotForCwd) throw new Error("Devin must expose workspace metadata.");
    yield* instance.snapshot.refresh;
    yield* instance.adapter.startSession({ threadId, cwd: h.root, runtimeMode: "full-access" });
    expect((yield* instance.snapshot.getSnapshot).workspaceSnapshots).toEqual([]);
    expect(
      (yield* snapshotForCwd(h.root)).slashCommands.some((entry) => entry.name === "plan"),
    ).toBe(true);
    yield* instance.adapter.stopSession(threadId);
    const workspaces = Array.from({ length: MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER }, (_, index) =>
      path.join(h.root, `workspace-${index}`),
    );
    for (const cwd of workspaces) {
      yield* fs.makeDirectory(cwd);
      yield* snapshotForCwd(cwd);
    }
    expect(
      (yield* instance.snapshot.getSnapshot).workspaceSnapshots?.map((entry) => entry.cwd),
    ).toEqual(workspaces);
    const refreshed = yield* instance.snapshot.refresh;
    expect(refreshed.workspaceSnapshots?.map((entry) => entry.cwd)).toEqual(workspaces);
    const recent = workspaces[0]!;
    yield* snapshotForCwd(recent);
    const rediscovered = yield* snapshotForCwd(h.root);
    expect(rediscovered.workspaceSnapshots?.map((entry) => entry.cwd)).toEqual([
      ...workspaces.slice(2),
      recent,
      h.root,
    ]);
    expect(rediscovered.slashCommands.some((entry) => entry.name === "plan")).toBe(false);
  }).pipe(Effect.provide(driverLayer)),
);

it.effect("refreshes account models and workspace skills and clears metadata after logout", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-auth-" });
    const statusFile = path.join(root, "status.txt");
    const modelsFile = path.join(root, "models.json");
    yield* fs.writeFileString(statusFile, "Logged in (via Devin).");
    const catalog =
      '{"families":[{"slug":"devin-test","family_label":"Devin Test","variants":[{"model_uid":"devin-test-low","label":"Devin Test Low"},{"model_uid":"devin-test-high","label":"Devin Test High"}]}]}';
    yield* fs.writeFileString(modelsFile, catalog);
    const h = yield* makeHarness({
      T3_ACP_DEVIN: "1",
      T3_ACP_DEVIN_STALE_MODELS: "1",
      T3_DEVIN_MODELS_FILE: modelsFile,
    });
    const instance = yield* DevinDriver.create({
      instanceId,
      displayName: "Devin test account",
      enabled: true,
      config: { ...h.settings, customModels: ["custom-devin-model"] },
      environment: [
        { name: "T3_DEVIN_AUTH_STATUS_FILE", value: statusFile, sensitive: false },
        { name: "WINDSURF_API_KEY", value: "", sensitive: true },
      ],
    });
    if (!instance.snapshotForCwd) throw new Error("Devin must expose workspace metadata.");
    const snapshot = yield* instance.snapshot.refresh;
    expect(snapshot.supportsTextGeneration).toBe(false);
    const skillsFile = path.join(h.root, "devin-test-skills.json");
    yield* fs.writeFileString(skillsFile, devinTestSkills);
    const workspace = yield* instance.snapshotForCwd(h.root);
    expect(workspace.skills).toEqual([
      expect.objectContaining({ name: "broken", enabled: false }),
      expect.objectContaining({ name: "internal", userInvocable: false }),
      expect.objectContaining({
        name: "visual-check",
        displayName: "Visual check",
        path: path.join("/skills/visual-check", "SKILL.md"),
        enabled: true,
        userInvocable: true,
        userInvocationOnly: true,
      }),
    ]);
    const other = yield* fs.makeTempDirectoryScoped({ prefix: "t3-devin-other-" });
    expect((yield* instance.snapshotForCwd(other)).skills).toEqual([]);
    expect(snapshot.auth.status).toBe("authenticated");
    expect(snapshot.status).toBe("ready");
    expect(yield* fs.exists(h.launchLog)).toBe(false);
    expect(snapshot.models.map((model) => model.slug)).toEqual([
      "devin-test",
      "custom-devin-model",
    ]);
    yield* instance.adapter.startSession({
      threadId,
      cwd: h.root,
      runtimeMode: "approval-required",
    });
    const activeSnapshot = yield* instance.snapshotForCwd(h.root);
    expect(
      activeSnapshot.workspaceSnapshots?.find((entry) => entry.cwd === h.root)?.skills,
    ).toEqual(workspace.skills);
    expect(activeSnapshot.models).toEqual(snapshot.models);
    expect(
      activeSnapshot.slashCommands.find((command) => command.name === "plan")?.input?.hint,
    ).toBe("[prompt]");
    expect(
      (yield* instance.snapshotForCwd(h.root)).slashCommands.some(
        (command) => command.name === "plan",
      ),
    ).toBe(true);
    yield* fs.writeFileString(modelsFile, "invalid response");
    const failedRefresh = yield* instance.snapshot.refresh;
    expect(failedRefresh.status).toBe("warning");
    expect(failedRefresh.auth.status).toBe("authenticated");
    expect(failedRefresh.message).toContain("Could not load Devin models");
    expect(failedRefresh.models).toEqual(snapshot.models);
    yield* fs.writeFileString(skillsFile, "invalid response");
    expect(yield* instance.snapshotForCwd(h.root).pipe(Effect.flip)).toMatchObject({
      _tag: "ProviderDriverError",
    });
    yield* fs.writeFileString(skillsFile, "[]");
    expect(
      (yield* instance.snapshot.refresh).workspaceSnapshots?.find((entry) => entry.cwd === h.root)
        ?.skills,
    ).toEqual([]);
    yield* fs.writeFileString(modelsFile, '{"families":[]}');
    expect((yield* instance.snapshot.refresh).models.map((model) => model.slug)).toEqual([
      "custom-devin-model",
    ]);
    yield* fs.writeFileString(modelsFile, catalog);
    expect((yield* instance.snapshot.refresh).models).toEqual(snapshot.models);
    for (const status of ["Unauthenticated", "Not authenticated", "Not logged in."]) {
      yield* fs.writeFileString(statusFile, status);
      yield* instance.snapshot.refresh;
      const signedOut = yield* instance.snapshotForCwd(h.root);
      expect(signedOut.auth.status).toBe("unauthenticated");
      expect(signedOut.models.map((model) => model.slug)).toEqual(["custom-devin-model"]);
      expect(signedOut.workspaceSnapshots).toEqual([]);
      expect(signedOut.slashCommands.some((command) => command.name === "plan")).toBe(false);
    }
  }).pipe(Effect.provide(driverLayer)),
);

it.effect("refreshes skills with bounded concurrency without reordering workspace metadata", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness({ T3_DEVIN_AUTH_STATUS: "Logged in (via Devin)." });
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const instance = yield* DevinDriver.create({
      instanceId,
      displayName: "Devin test",
      enabled: true,
      config: h.settings,
      environment: [],
    });
    const snapshotForCwd = instance.snapshotForCwd;
    if (!snapshotForCwd) throw new Error("Devin must expose workspace metadata.");
    yield* instance.snapshot.refresh;
    const workspaces = Array.from({ length: 5 }, (_, i) => path.join(h.root, `workspace-${i}`));
    for (const cwd of workspaces) {
      yield* fs.makeDirectory(cwd);
      yield* snapshotForCwd(cwd);
    }
    const gates = yield* Effect.forEach(workspaces, () => Deferred.make<void>());
    const firstBatch = yield* Deferred.make<void>();
    const lastStarted = yield* Deferred.make<void>();
    let active = 0;
    let peak = 0;
    let started = 0;
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        vi.spyOn(DevinSkills, "discoverDevinSkills").mockImplementation((_settings, _env, cwd) =>
          Effect.gen(function* () {
            active++;
            peak = Math.max(peak, active);
            if (++started === 4) yield* Deferred.succeed(firstBatch, undefined);
            if (started === 5) yield* Deferred.succeed(lastStarted, undefined);
            yield* Deferred.await(gates[workspaces.indexOf(cwd)]!);
            return [{ name: "refreshed", path: path.join(cwd, "SKILL.md"), enabled: true }];
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                active--;
              }),
            ),
          ),
        ),
      ),
      (spy) => Effect.sync(() => spy.mockRestore()),
    );
    const refresh = yield* instance.snapshot.refresh.pipe(Effect.forkScoped);
    yield* Deferred.await(firstBatch);
    expect(started).toBe(4);
    expect(active).toBe(4);
    yield* Deferred.succeed(gates[3]!, undefined);
    yield* Deferred.await(lastStarted);
    for (const index of [4, 2, 1, 0]) yield* Deferred.succeed(gates[index]!, undefined);
    const snapshot = yield* Fiber.join(refresh);
    expect(peak).toBe(4);
    expect(snapshot.workspaceSnapshots?.map(({ cwd }) => cwd)).toEqual(workspaces);
    expect(
      snapshot.workspaceSnapshots?.every(({ skills }) => skills[0]?.name === "refreshed"),
    ).toBe(true);
  }).pipe(Effect.provide(driverLayer)),
);
