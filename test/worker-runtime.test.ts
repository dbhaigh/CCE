import assert from "node:assert/strict";
import test from "node:test";
import { configuration, newGame, saveGame } from "../src/app/game.js";
import { SimulationWorkerRuntime } from "../src/app/worker-runtime.js";
import type { WorkerResponse } from "../src/app/protocol.js";
import { RUNTIME_SYSTEM_ID, decodeSaveWithMetadata, type RuntimeState } from "../src/simulation/index.js";

test("worker catches up multiple days in chunks, reports progress, and orders commands and saves", async () => {
  const savedAt = 1_000;
  const now = savedAt + 2 * 86_400_000 + 250;
  const save = saveGame(newGame(), savedAt);
  const runtime = new SimulationWorkerRuntime();
  const progress: WorkerResponse[] = [];
  let yields = 0;
  const initialize = runtime.submit(
    { id: 1, kind: "initialize", save, now },
    (response) => progress.push(response),
    async () => {
      yields += 1;
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  );
  const command = runtime.submit({
    id: 2, kind: "command", commandType: "runtime.set-deployment-strategy",
    payload: { strategy: "canary" },
  });
  const snapshot = runtime.submit({ id: 3, kind: "snapshot", now });

  const initialized = await initialize;
  assert.equal(initialized.kind, "result");
  if (initialized.kind !== "result" || initialized.result.kind !== "initialize") return;
  assert.equal(initialized.result.offline?.ticksProcessed, 172_800);
  assert.equal(initialized.result.offline?.requestedTicks, 172_800);
  assert.equal(initialized.result.offline?.remainder, 250_000);
  assert.equal(initialized.result.view.tick, 172_800);
  assert.ok(yields > 100);
  const offlineProgress = progress.filter((response) => response.kind === "progress");
  assert.ok(offlineProgress.length >= 2);
  assert.ok(offlineProgress.length < 200);
  assert.equal(offlineProgress.at(-1)?.kind === "progress" && offlineProgress.at(-1)?.ticksProcessed, 172_800);

  const commanded = await command;
  assert.equal(commanded.kind, "result");
  if (commanded.kind !== "result" || commanded.result.kind !== "command") return;
  assert.equal(commanded.result.commandResult.accepted, true);
  assert.equal(commanded.result.view.tick, 172_801);
  assert.equal(commanded.result.view.strategy, "canary");

  const serialized = await snapshot;
  assert.equal(serialized.kind, "result");
  if (serialized.kind !== "result" || serialized.result.kind !== "snapshot") return;
  const restored = decodeSaveWithMetadata(configuration, serialized.result.data).simulation;
  assert.equal(restored.tick, 172_801);
  assert.equal(restored.getState<RuntimeState>(RUNTIME_SYSTEM_ID).strategy, "canary");
});

test("one-day worker catch-up yields to other tasks and matches canonical direct progression", async () => {
  const savedAt = 1_000;
  const now = savedAt + 86_400_000;
  const save = saveGame(newGame(), savedAt);
  const direct = decodeSaveWithMetadata(configuration, save).simulation;
  const runtime = new SimulationWorkerRuntime();
  let complete = false;
  const started = runtime.submit({ id: 1, kind: "initialize", save, now })
    .then((result) => { complete = true; return result; });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(complete, false);
  const initialized = await started;
  assert.equal(initialized.kind, "result");
  if (initialized.kind !== "result" || initialized.result.kind !== "initialize") return;
  assert.equal(initialized.result.offline?.exactTicksProcessed, 86_400);
  const expected = direct.advanceOffline(savedAt, now);
  assert.equal(expected.exactTicksProcessed, 86_400);
  const snapshot = await runtime.submit({ id: 2, kind: "snapshot", now });
  assert.equal(snapshot.kind, "result");
  if (snapshot.kind !== "result" || snapshot.result.kind !== "snapshot") return;
  assert.deepEqual(decodeSaveWithMetadata(configuration, snapshot.result.data).simulation.serialize(now),
    direct.serialize(now));
});

test("worker surfaces rejected commands and malformed saves without losing its queue", async () => {
  const runtime = new SimulationWorkerRuntime();
  const invalid = await runtime.submit({ id: 1, kind: "initialize", save: "{", now: 1_000 });
  assert.equal(invalid.kind, "error");
  const blocked = await runtime.submit({ id: 6, kind: "snapshot", now: 1_000 });
  assert.equal(blocked.kind, "error");
  if (blocked.kind === "error") assert.match(blocked.message, /Cannot save after failed advancement/);
  const initialized = await runtime.submit({ id: 2, kind: "initialize", save: null, now: 1_000 });
  assert.equal(initialized.kind, "result");
  const rejected = await runtime.submit({
    id: 3, kind: "command", commandType: "build.select-hardware",
    payload: { profileId: "nonexistent" },
  });
  assert.equal(rejected.kind, "result");
  if (rejected.kind !== "result" || rejected.result.kind !== "command") return;
  assert.equal(rejected.result.commandResult.accepted, false);
  assert.match(rejected.result.commandResult.reason ?? "", /Unknown hardware profile/);
  const overCap = await runtime.submit({
    id: 4, kind: "advance", elapsedMilliseconds: 1_000, speedPermille: 20_000,
  });
  assert.equal(overCap.kind, "error");
  if (overCap.kind === "error") assert.match(overCap.message, /Speed must be/);
  const capped = await runtime.submit({
    id: 5, kind: "advance", elapsedMilliseconds: 1_000, speedPermille: 10_000,
  });
  assert.equal(capped.kind, "result");
  if (capped.kind === "result" && capped.result.kind === "advance") {
    assert.equal(capped.result.view?.tick, rejected.result.view.tick + 10);
  }
});
