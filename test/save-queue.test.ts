import assert from "node:assert/strict";
import test from "node:test";
import { SaveQueue } from "../src/app/save-queue.js";
import { gameBridge } from "../src/app/bridge.js";
import { configuration } from "../src/app/game.js";
import { Simulation, encodeSave } from "../src/simulation/index.js";

test("save queue coalesces concurrent requests and never overwrites a newer snapshot", async () => {
  const writes: { data: string; revision: number }[] = [];
  let snapshots = 0;
  let releaseFirst: (() => void) | undefined;
  const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const queue = new SaveQueue(
    async () => `snapshot-${++snapshots}`,
    async (data, revision) => {
      writes.push({ data, revision });
      if (revision === 1) await firstWrite;
    },
  );
  const first = queue.save();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const second = queue.save();
  const third = queue.save();
  releaseFirst?.();
  assert.deepEqual(await Promise.all([first, second, third]), [1, 2, 2]);
  assert.deepEqual(writes, [
    { data: "snapshot-1", revision: 1 },
    { data: "snapshot-3", revision: 2 },
  ]);
});

test("snapshot errors surface without writing stale data or blocking later saves", async () => {
  const writes: string[] = [];
  const queue = new SaveQueue(
    async (at) => {
      if (at === 1) throw new Error("Snapshot failed");
      return `snapshot-at-${at}`;
    },
    async (data) => { writes.push(data); },
  );
  await assert.rejects(queue.save(1), /Snapshot failed/);
  assert.equal(await queue.save(2), 1);
  assert.deepEqual(writes, ["snapshot-at-2"]);
});

test("failed writes reject their callers and do not block later saves", async () => {
  const queue = new SaveQueue(
    async () => "valid snapshot",
    async (_data, revision) => {
      if (revision === 1) throw new Error("Disk full");
    },
  );
  await assert.rejects(queue.save(), /Disk full/);
  assert.equal(await queue.save(), 2);
});

test("save queue resumes from the native process revision after UI remount", async () => {
  const revisions: number[] = [];
  const queue = new SaveQueue(async () => "snapshot", async (_data, revision) => {
    revisions.push(revision);
  });
  queue.synchronizeRevision(41);
  assert.equal(await queue.save(), 42);
  assert.deepEqual(revisions, [42]);
  assert.throws(() => queue.synchronizeRevision(-1), /Invalid initial save revision/);
});

test("autosaves and manual saves have separate revisions and never coalesce across slots", async () => {
  const writes: { slot: string; data: string; revision: number }[] = [];
  const queue = new SaveQueue(async (at) => `snapshot-${at}`,
    async (data, revision, slot) => { writes.push({ data, revision, slot }); });
  queue.synchronizeRevision(7, "manual-1");
  const auto = queue.save(1, undefined, "auto");
  const manual = queue.save(2, undefined, "manual-1");
  const autoAgain = queue.save(3, undefined, "auto");
  assert.deepEqual(await Promise.all([auto, manual, autoAgain]), [1, 8, 2]);
  await queue.whenIdle();
  assert.deepEqual(writes, [
    { slot: "auto", data: "snapshot-1", revision: 1 },
    { slot: "manual-1", data: "snapshot-2", revision: 8 },
    { slot: "auto", data: "snapshot-3", revision: 2 },
  ]);
});

test("a failed manual-slot write cannot block or change an autosave revision", async () => {
  const writes: string[] = [];
  const queue = new SaveQueue(async (at) => `at-${at}`, async (_data, revision, slot) => {
    if (slot === "manual-2") throw new Error("Manual slot full");
    writes.push(`${slot}:${revision}`);
  });
  const manual = queue.save(1, undefined, "manual-2");
  const auto = queue.save(2, undefined, "auto");
  await assert.rejects(manual, /Manual slot full/);
  assert.equal(await auto, 1);
  assert.equal(await queue.save(3, undefined, "auto"), 2);
  assert.deepEqual(writes, ["auto:1", "auto:2"]);
});

test("browser bridge isolates slots, backups, legacy migration and corrupt recovery", async () => {
  const storage = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
      removeItem: (key: string) => { storage.delete(key); },
    },
  });
  try {
    assert.equal(gameBridge.platform, "browser");
    const first = encodeSave(new Simulation(configuration), 1_000);
    const newer = encodeSave(new Simulation(configuration), 2_000);
    storage.set("code-compiler-empire.save", first);
    assert.equal((await gameBridge.listSlots())[0]?.legacy, true);
    assert.equal((await gameBridge.load()).data, first);
    const revisions: { slot: string; revision: number }[] = [];
    const unlisten = await gameBridge.onSaved((event) => { revisions.push(event); });
    await gameBridge.save(newer, 7, "auto");
    await gameBridge.save(first, 1, "manual-1");
    assert.equal(storage.get("code-compiler-empire.slot.auto.revision"), "7");
    assert.equal(storage.get("code-compiler-empire.slot.manual-1.revision"), "1");
    assert.equal((await gameBridge.load("auto")).data, newer);
    assert.equal((await gameBridge.load("auto", true)).data, first);
    assert.equal((await gameBridge.load("manual-1")).data, first);
    assert.deepEqual(revisions, [{ slot: "auto", revision: 7 }, { slot: "manual-1", revision: 1 }]);
    await assert.rejects(gameBridge.save(first, 6, "auto"), /Stale/);
    unlisten();
    storage.set("code-compiler-empire.slot.auto",
      newer.replace(/fnv1a32:[0-9a-f]{8}/, "fnv1a32:00000000"));
    assert.match((await gameBridge.listSlots())[0]?.error ?? "", /checksum mismatch/);
    await assert.rejects(gameBridge.load("auto"), /checksum mismatch/);
    storage.set("code-compiler-empire.slot.auto", '{"bad":');
    const corrupt = (await gameBridge.listSlots())[0];
    assert.equal(corrupt?.corrupt, true);
    assert.equal(corrupt?.revision, 7, "a corrupt primary does not discard its persisted revision");
    await assert.rejects(gameBridge.load("auto"), /valid JSON/);
    assert.equal((await gameBridge.load("auto", true)).data, first);
    await gameBridge.save(first, 8, "auto");
    assert.equal((await gameBridge.load("auto", true)).data, first, "corruption did not destroy backup");
    await gameBridge.deleteSlot("auto");
    assert.equal((await gameBridge.load("auto")).data, null, "deletion masks preserved legacy save");
    assert.equal(storage.get("code-compiler-empire.save"), first);
    assert.equal((await gameBridge.load("manual-1")).data, first);
    assert.equal((await gameBridge.listSlots())[1]?.revision, 1);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});

test("browser quota failure before replacement preserves the prior valid manual slot", async () => {
  const storage = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let failBackup = false;
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (failBackup && key === "code-compiler-empire.slot.manual-3.backup") {
          throw new Error("Quota exceeded");
        }
        storage.set(key, value);
      },
      removeItem: (key: string) => { storage.delete(key); },
    },
  });
  try {
    const first = encodeSave(new Simulation(configuration), 1_000);
    const second = encodeSave(new Simulation(configuration), 2_000);
    await gameBridge.save(first, 1, "manual-3");
    assert.equal(storage.get("code-compiler-empire.slot.manual-3.revision"), "1");
    failBackup = true;
    await assert.rejects(gameBridge.save(second, 2, "manual-3"), /Quota exceeded/);
    assert.equal((await gameBridge.load("manual-3")).data, first);
    assert.equal((await gameBridge.listSlots())[3]?.revision, 1);
    failBackup = false;
    await gameBridge.save(second, 2, "manual-3");
    assert.equal((await gameBridge.load("manual-3", true)).data, first);
  } finally {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
