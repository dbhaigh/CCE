import assert from "node:assert/strict";
import test from "node:test";
import { SAVE_SLOTS, inspectStoredSave, type GameBridge, type SaveSlot } from "../src/app/bridge.js";
import { SimulationLoop, type LoopClock, type SimulationTransport } from "../src/app/simulation-loop.js";
import { MAX_SPEED_PERMILLE, SimulationStore, type PlaybackSpeed } from "../src/app/simulation-store.js";
import { SimulationWorkerRuntime } from "../src/app/worker-runtime.js";
import type { WorkerRequest, WorkerResponse, WorkerResult } from "../src/app/protocol.js";
import { configuration } from "../src/app/game.js";
import { Simulation, decodeSaveWithMetadata, encodeSave } from "../src/simulation/index.js";

class FakeClock implements LoopClock {
  public time = 1_000;
  public invisible = false;
  public intervals = 0;
  public cleared = 0;
  private timer: (() => void) | undefined;
  private visibility: (() => void) | undefined;
  public now = () => this.time;
  public hidden = () => this.invisible;
  public every(_milliseconds: number, callback: () => void) {
    this.intervals += 1;
    this.timer = callback;
    return () => {
      this.cleared += 1;
      this.timer = undefined;
    };
  }
  public onVisibility(callback: () => void) {
    this.visibility = callback;
    return () => { this.visibility = undefined; };
  }
  public advance(milliseconds: number) {
    this.time += milliseconds;
    this.timer?.();
  }
  public drift(milliseconds: number) {
    this.time += milliseconds;
  }
  public setHidden(hidden: boolean) {
    this.invisible = hidden;
    this.visibility?.();
  }
}

class RuntimeTransport implements SimulationTransport {
  private readonly runtime = new SimulationWorkerRuntime();
  private nextId = 0;
  public disposed = false;
  public advanceRequests = 0;
  public offlineRequests = 0;
  public async request<K extends WorkerRequest["kind"]>(
    kind: K,
    payload: Omit<Extract<WorkerRequest, { kind: K }>, "id" | "kind">,
    progress?: (response: Extract<WorkerResponse, { kind: "progress" }>) => void,
  ): Promise<Extract<WorkerResult, { kind: K }>> {
    if (kind === "advance") this.advanceRequests += 1;
    if (kind === "offline") this.offlineRequests += 1;
    const id = ++this.nextId;
    let request: WorkerRequest;
    switch (kind) {
      case "initialize":
        request = { id, kind, ...payload as Omit<Extract<WorkerRequest, { kind: "initialize" }>, "id" | "kind"> };
        break;
      case "advance":
        request = { id, kind, ...payload as Omit<Extract<WorkerRequest, { kind: "advance" }>, "id" | "kind"> };
        break;
      case "offline":
        request = { id, kind, ...payload as Omit<Extract<WorkerRequest, { kind: "offline" }>, "id" | "kind"> };
        break;
      case "command":
        request = { id, kind, ...payload as Omit<Extract<WorkerRequest, { kind: "command" }>, "id" | "kind"> };
        break;
      case "snapshot":
        request = { id, kind, ...payload as Omit<Extract<WorkerRequest, { kind: "snapshot" }>, "id" | "kind"> };
        break;
    }
    const response = await this.runtime.submit(request, (message) => {
      if (message.kind === "progress") progress?.(message);
    });
    if (response.kind === "error") throw new Error(response.message);
    if (response.kind !== "result" || response.result.kind !== kind) throw new Error("Invalid worker result");
    return response.result as Extract<WorkerResult, { kind: K }>;
  }
  public dispose() { this.disposed = true; }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function withSlots(bridge: Omit<GameBridge, "listSlots" | "deleteSlot">): GameBridge {
  return {
    ...bridge,
    listSlots: async () => {
      const loaded = await bridge.load();
      return SAVE_SLOTS.map((slot) => ({
        slot, revision: slot === "auto" ? loaded.revision : 0,
        exists: slot === "auto" && loaded.data !== null,
        savedAt: slot === "auto" && loaded.data !== null ? inspectStoredSave(loaded.data) : null,
        corrupt: false, hasBackup: false,
      }));
    },
    deleteSlot: async () => {},
  };
}

test("one interval drives 1x, 2x, 5x, capped Max, pause and one hidden catch-up", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const saves: string[] = [];
  const bridge: GameBridge = withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async (data) => { saves.push(data); },
    onSaved: async () => () => {},
  });
  const loop = new SimulationLoop(store, transport, bridge, clock);
  await loop.start();
  assert.equal(clock.intervals, 1);
  assert.equal(store.getState().view?.tick, 0);
  const initialView = store.getState().view;
  clock.advance(250);
  await settle();
  assert.equal(store.getState().view, initialView);
  clock.advance(750);
  await settle();
  assert.equal(store.getState().view?.tick, 1);
  loop.setSpeed(2_000);
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 3);
  loop.setSpeed(5_000);
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 8);
  loop.setSpeed(MAX_SPEED_PERMILLE);
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 18);
  assert.throws(() => loop.setSpeed(20_000 as PlaybackSpeed), /exceed/);

  loop.togglePause();
  clock.advance(5_000);
  await settle();
  assert.equal(store.getState().view?.tick, 18);
  loop.togglePause();
  assert.equal(store.getState().speed, MAX_SPEED_PERMILLE);
  clock.setHidden(true);
  clock.advance(5_000);
  assert.equal(transport.offlineRequests, 0);
  clock.setHidden(false);
  await settle();
  assert.equal(transport.offlineRequests, 1);
  assert.equal(store.getState().offlineSummary?.ticksProcessed, 5);
  assert.equal(store.getState().view?.tick, 23);
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 33);
  assert.ok(saves.length >= 1);
  loop.stop();
  assert.equal(clock.cleared, 1);
  assert.equal(transport.disposed, true);
  const remountedStore = new SimulationStore();
  const remounted = new SimulationLoop(remountedStore, new RuntimeTransport(), bridge, clock);
  await remounted.start();
  assert.equal(clock.intervals, 2);
  clock.advance(1_000);
  await settle();
  assert.equal(remountedStore.getState().view?.tick, 1);
  assert.equal(store.getState().view?.tick, 33);
  remounted.stop();
  assert.equal(clock.cleared, 2);
});

test("slow worker advances cannot overlap or double-count elapsed time", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const bridge: GameBridge = withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async () => {},
    onSaved: async () => () => {},
  });
  const loop = new SimulationLoop(store, transport, bridge, clock);
  await loop.start();
  clock.advance(1_000);
  const command = loop.command("runtime.set-deployment-strategy", { strategy: "canary" });
  clock.advance(1_000);
  assert.equal(transport.advanceRequests, 1);
  await settle();
  await command;
  assert.equal(store.getState().view?.strategy, "canary");
  clock.advance(1_000);
  await settle();
  assert.equal(transport.advanceRequests, 2);
  assert.equal(store.getState().view?.tick, 4);
  loop.stop();
});

test("speed changes and hiding flush visible time before saving, then resume offline exactly once", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const saved: string[] = [];
  const bridge: GameBridge = withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async (data) => { saved.push(data); },
    onSaved: async () => () => {},
  });
  const loop = new SimulationLoop(store, transport, bridge, clock);
  await loop.start();
  clock.drift(500);
  loop.setSpeed(2_000);
  await settle();
  assert.equal(store.getState().view?.tick, 0);
  clock.drift(500);
  loop.setSpeed(0);
  await settle();
  assert.equal(store.getState().view?.tick, 1);
  loop.setSpeed(1_000);
  clock.advance(500);
  await settle();
  assert.equal(store.getState().view?.tick, 2);

  clock.drift(750);
  clock.setHidden(true);
  await settle();
  assert.equal(transport.offlineRequests, 0);
  assert.equal(saved.length, 1);
  const { simulation, wallClockSavedAt } = decodeSaveWithMetadata(configuration, saved[0] ?? "");
  assert.equal(wallClockSavedAt, clock.time);
  assert.equal(simulation.serialize(clock.time).scaledTimeRemainder, 750_000);
  clock.drift(250);
  clock.setHidden(false);
  await settle();
  assert.equal(transport.offlineRequests, 1);
  assert.equal(store.getState().offlineSummary?.ticksProcessed, 1);
  assert.equal(store.getState().view?.tick, 3);
  loop.stop();
});

test("delayed autosave advances to its timestamp before serialization", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  store.update({ settings: { ...store.getState().settings, autosaveIntervalSeconds: 30 } });
  const transport = new RuntimeTransport();
  const writes: string[] = [];
  const bridge: GameBridge = withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async (data) => { writes.push(data); },
    onSaved: async () => () => {},
  });
  const loop = new SimulationLoop(store, transport, bridge, clock);
  await loop.start();
  clock.advance(30_000);
  await settle();
  assert.equal(writes.length, 1);
  const { simulation: restored, wallClockSavedAt } = decodeSaveWithMetadata(configuration, writes[0] ?? "");
  assert.equal(wallClockSavedAt, 31_000);
  assert.equal(restored.tick, 30);
  assert.equal(store.getState().view?.tick, 30);
  assert.equal(restored.serialize(wallClockSavedAt).scaledTimeRemainder, 0);
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 31);
  restored.advanceOffline(wallClockSavedAt, clock.time);
  const live = await transport.request("snapshot", { now: clock.time });
  assert.deepEqual(restored.serialize(clock.time), decodeSaveWithMetadata(configuration, live.data).simulation.serialize(clock.time));
  loop.stop();
});

test("autosave interval settings apply live without changing manual-slot content", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const storage = slotMemory();
  const loop = new SimulationLoop(store, new RuntimeTransport(), storage.bridge, clock);
  await loop.start();
  await loop.save("manual-2");
  const manual = storage.entries.get("manual-2")?.data;
  store.update({ settings: { ...store.getState().settings, autosaveIntervalSeconds: 15 } });
  clock.advance(15_000);
  await settle();
  assert.ok(storage.entries.has("auto"));
  assert.equal(storage.entries.get("manual-2")?.data, manual);
  assert.equal(decodeSaveWithMetadata(configuration, storage.entries.get("auto")!.data).simulation.tick, 15);
  loop.stop();
});

test("hidden intervals never autosave an unprocessed hour; crash/reload replays it", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const writes: string[] = [];
  const bridge: GameBridge = withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async (data) => { writes.push(data); },
    onSaved: async () => () => {},
  });
  const loop = new SimulationLoop(store, transport, bridge, clock);
  await loop.start();
  clock.setHidden(true);
  await settle();
  assert.equal(writes.length, 1);
  clock.advance(1_800_000);
  clock.advance(1_800_000);
  assert.equal(writes.length, 1);
  const beforeCrash = decodeSaveWithMetadata(configuration, writes[0] ?? "");
  assert.equal(beforeCrash.wallClockSavedAt, 1_000);
  assert.equal(beforeCrash.simulation.tick, 0);
  loop.stop();

  const restoredStore = new SimulationStore();
  const restoredLoop = new SimulationLoop(restoredStore, new RuntimeTransport(), withSlots({
    ...bridge,
    load: async () => ({ data: writes[0] ?? null, revision: 1 }),
  }), clock);
  await restoredLoop.start();
  assert.equal(restoredStore.getState().view?.tick, 3_600);
  assert.equal(restoredStore.getState().offlineSummary?.ticksProcessed, 3_600);
  restoredLoop.stop();
});

test("manual hidden saves advance exactly once per hidden interval", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const writes: string[] = [];
  const loop = new SimulationLoop(store, transport, withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async (data) => { writes.push(data); },
    onSaved: async () => () => {},
  }), clock);
  await loop.start();
  clock.setHidden(true);
  await settle();
  clock.drift(1_800_000);
  await loop.save();
  clock.drift(1_800_000);
  await loop.save();
  assert.equal(writes.length, 3);
  assert.deepEqual(writes.map((save) => {
    const { simulation, wallClockSavedAt } = decodeSaveWithMetadata(configuration, save);
    return [wallClockSavedAt, simulation.tick];
  }), [[1_000, 0], [1_801_000, 1_800], [3_601_000, 3_600]]);
  assert.equal(store.getState().view?.tick, 3_600);
  assert.equal(store.getState().offlineSummary?.ticksProcessed, 1_800);
  clock.setHidden(false);
  await settle();
  assert.equal(store.getState().view?.tick, 3_600);
  loop.stop();
});

test("manual saves between pulses and while paused preserve tick and fractional remainder", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const writes: string[] = [];
  const loop = new SimulationLoop(store, transport, withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async (data) => { writes.push(data); },
    onSaved: async () => () => {},
  }), clock);
  await loop.start();
  clock.drift(1_750);
  await loop.save();
  const first = decodeSaveWithMetadata(configuration, writes[0] ?? "");
  assert.equal(first.wallClockSavedAt, 2_750);
  assert.equal(first.simulation.tick, 1);
  assert.equal(store.getState().view?.tick, 1);
  assert.equal(first.simulation.serialize(2_750).scaledTimeRemainder, 750_000);
  clock.advance(250);
  await settle();
  assert.equal(store.getState().view?.tick, 2);
  first.simulation.advanceOffline(first.wallClockSavedAt, clock.time);
  assert.equal(first.simulation.tick, 2);
  loop.setSpeed(0);
  clock.drift(30_000);
  await loop.save();
  const paused = decodeSaveWithMetadata(configuration, writes[1] ?? "");
  assert.equal(paused.wallClockSavedAt, 33_000);
  assert.equal(paused.simulation.tick, 2);
  assert.equal(paused.simulation.serialize(33_000).scaledTimeRemainder, 0);
  loop.stop();
});

test("commands flush preceding visible time and snapshots retain their FIFO boundary", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const writes: string[] = [];
  const loop = new SimulationLoop(store, transport, withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async (data) => { writes.push(data); },
    onSaved: async () => () => {},
  }), clock);
  await loop.start();
  clock.drift(2_500);
  const result = await loop.command("runtime.set-deployment-strategy", { strategy: "canary" });
  assert.equal(result.accepted, true);
  assert.equal(store.getState().view?.tick, 3);
  clock.drift(500);
  await loop.save();
  const saved = decodeSaveWithMetadata(configuration, writes[0] ?? "");
  assert.equal(saved.wallClockSavedAt, 4_000);
  assert.equal(saved.simulation.tick, 4);
  assert.equal(store.getState().view?.strategy, "canary");
  const current = await transport.request("snapshot", { now: clock.time });
  assert.deepEqual(saved.simulation.serialize(clock.time), decodeSaveWithMetadata(configuration, current.data).simulation.serialize(clock.time));
  loop.stop();
});

test("in-flight worker and pending offline catch-up cannot make later snapshots stale", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const writes: string[] = [];
  const loop = new SimulationLoop(store, transport, withSlots({
    platform: "browser",
    load: async () => ({ data: null, revision: 0 }),
    save: async (data) => { writes.push(data); },
    onSaved: async () => () => {},
  }), clock);
  await loop.start();
  clock.advance(1_000);
  clock.drift(29_000);
  await loop.save();
  const pending = decodeSaveWithMetadata(configuration, writes[0] ?? "");
  assert.equal(pending.wallClockSavedAt, 31_000);
  assert.equal(pending.simulation.tick, 30);
  clock.setHidden(true);
  await settle();
  clock.drift(3_600_000);
  clock.setHidden(false);
  clock.drift(1_000);
  await loop.save();
  const afterOffline = decodeSaveWithMetadata(configuration, writes.at(-1) ?? "");
  assert.equal(afterOffline.wallClockSavedAt, 3_632_000);
  assert.equal(afterOffline.simulation.tick, 3_631);
  const direct = pending.simulation;
  direct.advanceOffline(pending.wallClockSavedAt, 3_631_000);
  direct.advanceRealTime(1_000);
  assert.deepEqual(afterOffline.simulation.serialize(clock.time), direct.serialize(clock.time));
  loop.stop();
});

function slotMemory(): {
  bridge: GameBridge;
  entries: Map<SaveSlot, { data: string; revision: number }>;
  backups: Map<SaveSlot, string>;
} {
  const entries = new Map<SaveSlot, { data: string; revision: number }>();
  const backups = new Map<SaveSlot, string>();
  const bridge: GameBridge = {
    platform: "browser",
    load: async (slot = "auto", backup = false) => ({
      data: backup ? backups.get(slot) ?? null : entries.get(slot)?.data ?? null,
      revision: entries.get(slot)?.revision ?? 0,
    }),
    listSlots: async () => SAVE_SLOTS.map((slot) => {
      const stored = entries.get(slot);
      const base = { slot, revision: stored?.revision ?? 0, exists: stored !== undefined,
        hasBackup: backups.has(slot) };
      if (stored === undefined) return { ...base, savedAt: null, corrupt: false };
      try {
        return { ...base, savedAt: inspectStoredSave(stored.data), corrupt: false };
      } catch (error) {
        return { ...base, savedAt: null, corrupt: true, error: String(error) };
      }
    }),
    save: async (data, revision, slot = "auto") => {
      const old = entries.get(slot);
      if (old !== undefined && revision <= old.revision) throw new Error("Stale save");
      if (old !== undefined) {
        try { inspectStoredSave(old.data); backups.set(slot, old.data); } catch { /* keep valid backup */ }
      }
      entries.set(slot, { data, revision });
    },
    deleteSlot: async (slot) => { entries.delete(slot); backups.delete(slot); },
    onSaved: async () => () => {},
  };
  return { bridge, entries, backups };
}

test("manual slots remain independent from autosave and loading restores a worker with exact offline time", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const storage = slotMemory();
  const loop = new SimulationLoop(store, new RuntimeTransport(), storage.bridge, clock);
  await loop.start();
  clock.drift(2_500);
  await loop.save("manual-1");
  const manual = storage.entries.get("manual-1")!.data;
  assert.equal(decodeSaveWithMetadata(configuration, manual).simulation.tick, 2);
  assert.equal((await loop.command("runtime.set-deployment-strategy", { strategy: "canary" })).accepted, true);
  clock.drift(1_000);
  await loop.save();
  assert.equal(storage.entries.get("manual-1")?.data, manual);
  assert.equal(store.getState().view?.strategy, "canary");
  loop.setSpeed(0);
  clock.drift(3_000);
  await loop.loadSlot("manual-1");
  assert.equal(store.getState().speed, 0);
  assert.notEqual(store.getState().view?.strategy, "canary");
  assert.equal(store.getState().view?.tick, 6);
  assert.equal(store.getState().activeSlot, "manual-1");
  assert.equal(storage.entries.get("auto")?.data !== null, true);
  assert.equal(storage.entries.get("manual-1")?.data, manual);
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 6, "paused visible time is not replayed");
  loop.stop();

  const restarted = new SimulationStore();
  const second = new SimulationLoop(restarted, new RuntimeTransport(), storage.bridge, clock);
  await second.start();
  assert.equal(restarted.getState().activeSlot, "auto");
  assert.equal(restarted.getState().view?.strategy, "canary");
  assert.equal(restarted.getState().view?.tick, 8, "restart replays elapsed once from autosave");
  second.stop();
});

test("corrupt startup does not overwrite autosave; backup explicitly recovers and deletion leaves an empty slot", async () => {
  const clock = new FakeClock();
  const storage = slotMemory();
  const original = encodeSave(new Simulation(configuration), clock.now());
  storage.entries.set("auto", { data: '{"broken":', revision: 4 });
  storage.backups.set("auto", original);
  const store = new SimulationStore();
  const loop = new SimulationLoop(store, new RuntimeTransport(), storage.bridge, clock);
  await loop.start();
  assert.equal(store.getState().ready, false);
  assert.match(store.getState().recovery ?? "", /corrupt/);
  assert.equal(store.getState().speed, 0);
  assert.equal(storage.entries.get("auto")?.data, '{"broken":');
  await loop.loadSlot("auto", true);
  assert.equal(store.getState().ready, true);
  assert.equal(store.getState().recovery, null);
  assert.equal(storage.entries.get("auto")?.data, '{"broken":', "recovery does not silently mutate primary");
  await loop.newGame();
  assert.equal(storage.entries.get("auto")?.data, '{"broken":', "new game waits for explicit saving");
  await loop.deleteSlot("manual-1");
  assert.equal((await storage.bridge.listSlots())[1]?.exists, false);
  loop.stop();
});

test("startup chooses latest manual save only when the AUTO slot is absent", async () => {
  const clock = new FakeClock();
  clock.time = 10_000;
  const storage = slotMemory();
  const initial = new Simulation(configuration);
  storage.entries.set("manual-1", { data: encodeSave(initial, 1_000), revision: 2 });
  storage.entries.set("manual-2", { data: encodeSave(initial, 5_000), revision: 3 });
  const store = new SimulationStore();
  const loop = new SimulationLoop(store, new RuntimeTransport(), storage.bridge, clock);
  await loop.start();
  assert.equal(store.getState().activeSlot, "manual-2");
  assert.equal(store.getState().offlineSummary?.ticksProcessed, 5);
  loop.stop();
});

test("switching slots with an in-flight advance ignores old projections and does not double count time", async () => {
  const clock = new FakeClock();
  const storage = slotMemory();
  const store = new SimulationStore();
  const loop = new SimulationLoop(store, new RuntimeTransport(), storage.bridge, clock);
  await loop.start();
  clock.drift(2_000);
  await loop.save("manual-1");
  assert.equal((await loop.command("runtime.set-deployment-strategy", { strategy: "canary" })).accepted, true);
  clock.advance(1_000);
  await loop.loadSlot("manual-1");
  await settle();
  assert.equal(store.getState().view?.tick, 3);
  assert.notEqual(store.getState().view?.strategy, "canary");
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 4);
  loop.stop();
});

test("slot load waits for an in-flight autosave write before replacing worker state", async () => {
  const clock = new FakeClock();
  const storage = slotMemory();
  const store = new SimulationStore();
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writing = false;
  const bridge: GameBridge = {
    ...storage.bridge,
    save: async (data, revision, slot = "auto") => {
      if (slot === "auto") {
        writing = true;
        await gate;
      }
      await storage.bridge.save(data, revision, slot);
    },
  };
  const loop = new SimulationLoop(store, new RuntimeTransport(), bridge, clock);
  await loop.start();
  await loop.save("manual-1");
  assert.equal((await loop.command("runtime.set-deployment-strategy", { strategy: "canary" })).accepted, true);
  clock.drift(1_000);
  const saving = loop.save();
  await settle();
  assert.equal(writing, true);
  const loading = loop.loadSlot("manual-1");
  await settle();
  assert.equal(store.getState().ready, false);
  release?.();
  await Promise.all([saving, loading]);
  assert.equal(store.getState().ready, true);
  assert.notEqual(store.getState().view?.strategy, "canary");
  assert.ok(storage.entries.has("auto"), "the prior autosave write completed before loading");
  loop.stop();
});

test("worker error pauses without writing suspect state; explicit new game can recover", async () => {
  class FailingTransport extends RuntimeTransport {
    public override async request<K extends WorkerRequest["kind"]>(
      kind: K,
      payload: Omit<Extract<WorkerRequest, { kind: K }>, "id" | "kind">,
      progress?: (response: Extract<WorkerResponse, { kind: "progress" }>) => void,
    ): Promise<Extract<WorkerResult, { kind: K }>> {
      if (kind === "advance") throw new Error("Worker unavailable");
      return super.request(kind, payload, progress);
    }
  }
  const clock = new FakeClock();
  const storage = slotMemory();
  const store = new SimulationStore();
  const loop = new SimulationLoop(store, new FailingTransport(), storage.bridge, clock,
    () => new RuntimeTransport());
  await loop.start();
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().ready, false);
  assert.equal(store.getState().speed, 0);
  assert.match(store.getState().recovery ?? "", /Worker unavailable/);
  assert.equal(storage.entries.size, 0);
  await assert.rejects(loop.save(), /not ready/);
  await loop.newGame();
  assert.equal(store.getState().ready, true);
  assert.equal(store.getState().recovery, null);
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 0, "recovery preserves paused playback");
  loop.stop();
});

test("a React render failure suppresses autosave and commands until explicit recovery", async () => {
  const clock = new FakeClock();
  const store = new SimulationStore();
  const storage = slotMemory();
  const loop = new SimulationLoop(store, new RuntimeTransport(), storage.bridge, clock,
    () => new RuntimeTransport());
  await loop.start();
  await loop.save("manual-1");
  const preserved = storage.entries.get("manual-1")?.data;
  store.setSpeed(0);
  store.update({ recovery: "Dashboard render failed" });
  clock.advance(60_000);
  clock.setHidden(true);
  clock.advance(60_000);
  clock.setHidden(false);
  await settle();
  assert.equal(storage.entries.has("auto"), false);
  assert.throws(() => loop.setSpeed(2_000), /until recovery/);
  await assert.rejects(loop.save(), /requires recovery/);
  await assert.rejects(loop.command("runtime.set-deployment-strategy", { strategy: "canary" }),
    /requires recovery/);
  assert.equal(storage.entries.get("manual-1")?.data, preserved);
  await loop.loadSlot("manual-1");
  assert.equal(store.getState().recovery, null);
  assert.equal(store.getState().ready, true);
  loop.stop();
});

test("visibility changes while a slot initializes replay visible speed and hidden time at distinct rates", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  class DelayedTransport extends RuntimeTransport {
    public override async request<K extends WorkerRequest["kind"]>(
      kind: K,
      payload: Omit<Extract<WorkerRequest, { kind: K }>, "id" | "kind">,
      progress?: (response: Extract<WorkerResponse, { kind: "progress" }>) => void,
    ): Promise<Extract<WorkerResult, { kind: K }>> {
      if (kind === "initialize") await gate;
      return super.request(kind, payload, progress);
    }
  }
  const clock = new FakeClock();
  const store = new SimulationStore();
  store.setSpeed(2_000);
  const loop = new SimulationLoop(store, new DelayedTransport(), slotMemory().bridge, clock);
  const startup = loop.start();
  await settle();
  clock.drift(1_000);
  clock.setHidden(true);
  clock.drift(5_000);
  clock.setHidden(false);
  release?.();
  await startup;
  assert.equal(store.getState().view?.tick, 7, "one visible second at 2x and five hidden at 1x");
  assert.equal(store.getState().offlineSummary?.ticksProcessed, 5);
  assert.equal(store.getState().speed, 2_000);
  clock.advance(1_000);
  await settle();
  assert.equal(store.getState().view?.tick, 9);
  loop.stop();
});

test("Max speed with a fully staffed team keeps projection updates bounded to loop pulses", async () => {
  const clock = new FakeClock();
  const wealthy = new Simulation({
    ...configuration,
    initialResources: { "core.money": 1_000_000 },
  });
  const storage = slotMemory();
  storage.entries.set("auto", { data: encodeSave(wealthy, clock.now()), revision: 1 });
  const store = new SimulationStore();
  const transport = new RuntimeTransport();
  const loop = new SimulationLoop(store, transport, storage.bridge, clock);
  await loop.start();
  for (let index = 0; index < 9; index += 1) {
    assert.equal((await loop.command("organization.adjust-team", {
      teamId: "platform-team", delta: 10,
    })).accepted, true);
  }
  const policies = store.getState().view?.teamPolicies;
  const initialTick = store.getState().view?.tick ?? 0;
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  loop.setSpeed(MAX_SPEED_PERMILLE);
  const beginning = performance.now();
  for (let pulse = 0; pulse < 12; pulse += 1) {
    clock.advance(250);
    await settle();
  }
  const measuredMilliseconds = performance.now() - beginning;
  assert.equal(store.getState().view?.tick, initialTick + 30);
  assert.equal(transport.advanceRequests, 12);
  assert.ok(notifications <= 14, `Expected bounded UI updates, got ${notifications}`);
  assert.equal(store.getState().view?.teamPolicies, policies, "unchanged policy projection stays shared");
  assert.ok(measuredMilliseconds < 10_000, `Thirty staffed ticks took ${measuredMilliseconds} ms`);
  unsubscribe();
  loop.stop();
});
