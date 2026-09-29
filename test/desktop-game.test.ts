import assert from "node:assert/strict";
import test from "node:test";
import {
  configuration,
  getGameView,
  issueCommand,
  newGame,
  saveGame,
} from "../src/app/game.js";
import { contentHash } from "../src/simulation/content.js";
import { decodeSaveWithMetadata } from "../src/simulation/index.js";

test("desktop game uses the production simulation with policies and persistence", () => {
  const game = newGame();
  const initial = getGameView(game);
  assert.equal(initial.diagnostics.pipeline.nodes.length, 9);
  assert.equal(initial.resources.find(({ id }) => id === "core.money")?.amount, 1_000);

  issueCommand(game, "runtime.set-deployment-strategy", { strategy: "canary" });
  issueCommand(game, "organization.configure-swarm", {
    swarmId: "compiler-swarm", autonomyPermille: 700, alignmentPermille: 900,
  });

  assert.equal(getGameView(game).strategy, "canary");
  assert.equal(getGameView(game).swarms[0]?.autonomyPermille, 700);
  assert.ok(getGameView(game).tick >= 2);

  const saved = saveGame(game, 10_000);
  const { simulation: restored, wallClockSavedAt } = decodeSaveWithMetadata(configuration, saved);
  const offline = restored.advanceOffline(wallClockSavedAt, 15_000);
  assert.equal(offline.ticksProcessed, 5);
  assert.equal(getGameView(restored).strategy, "canary");
  assert.equal(getGameView(restored).swarms[0]?.autonomyPermille, 700);
  assert.ok(getGameView(restored).tick > getGameView(game).tick);
  assert.throws(
    () => decodeSaveWithMetadata(configuration, saved.replace('"canary"', '"hot"')),
    /checksum mismatch/,
  );
});

test("verified preview saves remain loadable after the 0.0.1 version correction", () => {
  const current = JSON.parse(saveGame(newGame(), 10_000)) as {
    snapshot: { gameVersion: string; tick: number };
    checksum: string;
  };
  current.snapshot.gameVersion = "0.1.0";
  current.checksum = contentHash(current.snapshot);
  const restored = decodeSaveWithMetadata(configuration, JSON.stringify(current)).simulation;
  assert.equal(restored.serialize(10_000).gameVersion, "0.0.1");
  assert.equal(restored.tick, current.snapshot.tick);
  current.snapshot.gameVersion = "1.0.0";
  current.checksum = contentHash(current.snapshot);
  assert.throws(() => decodeSaveWithMetadata(configuration, JSON.stringify(current)),
    /does not match the simulation configuration/);
});
