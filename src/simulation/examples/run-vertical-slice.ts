import {
  advanceVerticalSliceOffline,
  createVerticalSliceGame,
  getVerticalSliceStatus,
  hireAgents,
  loadVerticalSlice,
  saveVerticalSlice,
  setStrictPolicy,
} from "./vertical-slice.js";

const game = createVerticalSliceGame("demo");

hireAgents(game, 3);
game.advanceTicks(12, false);
console.log("Fast policy:", getVerticalSliceStatus(game));

setStrictPolicy(game, true);
game.advanceTicks(5, false);
console.log("Strict policy:", getVerticalSliceStatus(game));

const savedAt = 1_000_000;
const save = saveVerticalSlice(game, savedAt);
const restored = loadVerticalSlice(save, "demo");
const offline = advanceVerticalSliceOffline(
  restored,
  savedAt,
  savedAt + 10_000,
);

console.log("Offline report:", {
  ticksProcessed: offline.ticksProcessed,
  exactTicksProcessed: offline.exactTicksProcessed,
});
console.log("Restored after 10s offline:", getVerticalSliceStatus(restored));
