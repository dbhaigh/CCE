import type { CommandResult } from "../simulation/index.js";
import { SAVE_SLOTS, type GameBridge, type SaveSlot, type SlotInfo } from "./bridge.js";
import {
  MAX_SPEED_PERMILLE,
  type CommandPayload,
  type OfflineSummary,
  type SnapshotCatchUp,
  type WorkerRequest,
  type WorkerResponse,
  type WorkerResult,
} from "./protocol.js";
import { SaveQueue } from "./save-queue.js";
import { PLAYBACK_SPEEDS, type PlaybackSpeed, SimulationStore } from "./simulation-store.js";

type ProgressResponse = Extract<WorkerResponse, { kind: "progress" }>;

export interface SimulationTransport {
  request<K extends WorkerRequest["kind"]>(
    kind: K,
    payload: Omit<Extract<WorkerRequest, { kind: K }>, "id" | "kind">,
    progress?: (response: ProgressResponse) => void,
  ): Promise<Extract<WorkerResult, { kind: K }>>;
  dispose(): void;
}

export interface LoopClock {
  now(): number;
  hidden(): boolean;
  every(milliseconds: number, callback: () => void): () => void;
  onVisibility(callback: () => void): () => void;
}

export const browserLoopClock: LoopClock = {
  now: () => Date.now(),
  hidden: () => document.hidden,
  every: (milliseconds, callback) => {
    const timer = window.setInterval(callback, milliseconds);
    return () => window.clearInterval(timer);
  },
  onVisibility: (callback) => {
    document.addEventListener("visibilitychange", callback);
    return () => document.removeEventListener("visibilitychange", callback);
  },
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function combineOffline(before: OfflineSummary | null, after: OfflineSummary): OfflineSummary {
  if (before === null) return after;
  const eventCounts = { ...before.eventCounts };
  for (const [type, count] of Object.entries(after.eventCounts)) {
    eventCounts[type] = (eventCounts[type] ?? 0) + count;
  }
  return {
    elapsedMilliseconds: before.elapsedMilliseconds + after.elapsedMilliseconds,
    requestedTicks: before.requestedTicks + after.requestedTicks,
    ticksProcessed: before.ticksProcessed + after.ticksProcessed,
    exactTicksProcessed: before.exactTicksProcessed + after.exactTicksProcessed,
    analyticalTicksSkipped: before.analyticalTicksSkipped + after.analyticalTicksSkipped,
    discardedTicks: before.discardedTicks + after.discardedTicks,
    capped: before.capped || after.capped,
    remainder: after.remainder,
    eventCounts,
    commandResults: [...before.commandResults, ...after.commandResults],
  };
}

export class SimulationLoop {
  private readonly saves: SaveQueue;
  private disposed = false;
  private ready = false;
  private foregroundPending = 0;
  private offlinePending = 0;
  private hiddenAt: number | null = null;
  private lastTime: number;
  private lastSave: number;
  private readonly lastNotifiedRevisions = new Map<SaveSlot, number>();
  private readonly deletingSlots = new Set<SaveSlot>();
  private loadingVisibility: { at: number; hidden: boolean }[] = [];
  private epoch = 0;
  private transitioning = false;
  private stopTimer: (() => void) | undefined;
  private stopVisibility: (() => void) | undefined;
  private unlisten: (() => void) | undefined;

  public constructor(
    private readonly store: SimulationStore,
    private transport: SimulationTransport,
    private readonly bridge: GameBridge,
    private readonly clock: LoopClock = browserLoopClock,
    private readonly createTransport?: () => SimulationTransport,
  ) {
    this.lastTime = clock.now();
    this.lastSave = this.lastTime;
    this.saves = new SaveQueue(
      (now, catchUp) => {
        const epoch = this.epoch;
        return this.transport.request("snapshot", {
          now, ...(catchUp === undefined ? {} : { catchUp }),
        }, (progress) => { if (epoch === this.epoch) this.showProgress(progress); }).then(
        (result) => {
          if (!this.disposed && epoch === this.epoch) {
            if (result.view !== null) this.store.setView(result.view);
            if (result.offline !== null) this.store.update({ offlineSummary: result.offline });
            if (catchUp !== undefined) this.store.update({ progress: null });
          }
          return result.data;
        },
        (error: unknown) => {
          if (catchUp !== undefined) this.failSimulation(error);
          throw error;
        },
      );
      },
      (data, revision, slot) => {
        if (this.store.getState().recovery !== null) {
          throw new Error("Cannot write a save while recovery is required");
        }
        return bridge.save(data, revision, slot);
      },
      () => clock.now(),
    );
  }

  public async start(): Promise<void> {
    this.stopVisibility = this.clock.onVisibility(() => this.visibilityChanged());
    try {
      const unlisten = await this.bridge.onSaved(({ slot, revision }) => {
        if (!SAVE_SLOTS.includes(slot) || !Number.isSafeInteger(revision)) return;
        if (revision > (this.lastNotifiedRevisions.get(slot) ?? 0)) {
          this.lastNotifiedRevisions.set(slot, revision);
          if (!this.disposed && this.offlinePending === 0) {
            this.store.update({ notice: `${slot === "auto" ? "Autosave" : slot} saved` });
          }
        }
      });
      if (this.disposed) {
        unlisten();
        return;
      }
      this.unlisten = unlisten;
      const slots = await this.bridge.listSlots();
      if (this.disposed) return;
      this.store.update({ slots });
      for (const slot of slots) this.saves.synchronizeRevision(slot.revision, slot.slot);
      this.stopTimer = this.clock.every(250, () => this.pulse());
      const auto = slots.find((info) => info.slot === "auto");
      const selected = auto?.exists
        ? auto
        : [...slots].filter((info) => info.exists && !info.corrupt)
          .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))[0];
      if (selected) {
        if (selected.corrupt) throw new Error(`Autosave is corrupt: ${selected.error ?? "Unknown error"}`);
        await this.loadSlot(selected.slot);
        const otherCorrupt = slots.filter((info) => info.corrupt);
        if (otherCorrupt.length > 0 && !this.disposed) {
          this.store.update({
            notice: `Corrupt save slot${otherCorrupt.length === 1 ? "" : "s"}: ${
              otherCorrupt.map((info) => info.slot).join(", ")
            }. Restore a backup or delete the slot explicitly.`,
          });
        }
      } else {
        const corrupt = slots.find((info) => info.corrupt);
        if (corrupt) throw new Error(`${corrupt.slot} is corrupt: ${corrupt.error ?? "Unknown error"}`);
        await this.newGame();
      }
    } catch (error) {
      if (!this.disposed) this.failSimulation(new Error(`Unable to open empire: ${errorMessage(error)}`));
    }
  }

  public stop(): void {
    this.disposed = true;
    this.ready = false;
    this.epoch += 1;
    this.stopTimer?.();
    this.stopVisibility?.();
    this.unlisten?.();
    this.transport.dispose();
  }

  public setSpeed(speed: PlaybackSpeed): void {
    if (!PLAYBACK_SPEEDS.includes(speed)) {
      throw new RangeError(`Speed must not exceed ${MAX_SPEED_PERMILLE / 1_000}x`);
    }
    if (speed !== 0 && this.store.getState().recovery !== null) {
      throw new Error("Cannot resume playback until recovery is complete");
    }
    const now = this.clock.now();
    const previousSpeed = this.store.getState().speed;
    if (this.ready && !this.clock.hidden() && previousSpeed > 0 && now > this.lastTime) {
      this.scheduleAdvance(now - this.lastTime, previousSpeed);
    }
    this.lastTime = now;
    this.store.setSpeed(speed);
  }

  public togglePause(): void {
    const state = this.store.getState();
    this.setSpeed(state.speed === 0 ? state.lastRunningSpeed : 0);
  }

  public async command(commandType: string, payload: CommandPayload): Promise<CommandResult> {
    if (!this.ready || this.disposed) throw new Error("Simulation is not ready");
    if (this.store.getState().recovery !== null) throw new Error("Simulation requires recovery");
    if (!this.clock.hidden()) this.flushVisibleTime(this.clock.now());
    const epoch = this.epoch;
    try {
      const result = await this.transport.request("command", { commandType, payload });
      if (!this.disposed && epoch === this.epoch) {
        this.store.setView(result.view);
        this.store.update({
          notice: result.commandResult.accepted
            ? `${commandType} accepted`
            : `Command rejected: ${result.commandResult.reason ?? commandType}`,
        });
      }
      return result.commandResult;
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) this.failSimulation(error);
      throw error;
    }
  }

  public async save(slot: SaveSlot = "auto"): Promise<void> {
    if (!this.ready || this.disposed) throw new Error("Simulation is not ready");
    if (this.store.getState().recovery !== null) throw new Error("Simulation requires recovery");
    if (this.deletingSlots.has(slot)) throw new Error(`${slot} is being deleted`);
    const now = this.clock.now();
    let catchUp: SnapshotCatchUp | undefined;
    if (this.clock.hidden()) {
      if (this.hiddenAt === null) throw new Error("Cannot save: hidden interval has no start");
      if (now > this.hiddenAt) {
        catchUp = { kind: "offline", savedAt: this.hiddenAt };
        this.hiddenAt = now;
      }
    } else {
      const speed = this.store.getState().speed;
      if (speed > 0 && now > this.lastTime) {
        catchUp = { kind: "foreground", elapsedMilliseconds: now - this.lastTime, speedPermille: speed };
      }
      this.lastTime = now;
    }
    await this.persistAt(now, catchUp, slot);
  }

  private async persistAt(now: number, catchUp?: SnapshotCatchUp, slot: SaveSlot = "auto"): Promise<void> {
    if (this.deletingSlots.has(slot)) return;
    const previousSave = this.lastSave;
    this.lastSave = now;
    try {
      await this.saves.save(now, catchUp, slot);
      if (!this.disposed) await this.refreshSlots();
    } catch (error) {
      if (this.lastSave === now) this.lastSave = previousSave;
      if (!this.disposed) this.store.update({ notice: `Save failed: ${errorMessage(error)}` });
      throw error;
    }
  }

  private async refreshSlots(): Promise<readonly SlotInfo[]> {
    const slots = await this.bridge.listSlots();
    if (!this.disposed) this.store.update({ slots });
    return slots;
  }

  public async loadSlot(slot: SaveSlot, backup = false): Promise<void> {
    if (this.disposed || this.transitioning) throw new Error("Another save is being loaded");
    this.transitioning = true;
    this.ready = false;
    const epoch = ++this.epoch;
    this.store.update({ ready: false, progress: null, notice: `Loading ${slot}${backup ? " backup" : ""}...` });
    try {
      await this.saves.whenIdle();
      this.restartFailedTransport();
      const loaded = await this.bridge.load(slot, backup);
      if (loaded.data === null) throw new Error(`${slot}${backup ? " backup" : ""} is empty`);
      this.saves.synchronizeRevision(loaded.revision, slot);
      if (this.disposed || epoch !== this.epoch) return;
      const startedAt = this.clock.now();
      this.loadingVisibility = [{ at: startedAt, hidden: this.clock.hidden() }];
      const initialized = await this.transport.request(
        "initialize", { save: loaded.data, now: startedAt },
        (progress) => { if (epoch === this.epoch) this.showProgress(progress); },
      );
      if (this.disposed || epoch !== this.epoch) return;
      await this.finishInitialize(initialized, startedAt, slot, epoch);
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) this.failSimulation(error);
      throw error;
    } finally {
      this.loadingVisibility = [];
      this.transitioning = false;
    }
  }

  public async newGame(): Promise<void> {
    if (this.disposed || this.transitioning) throw new Error("Another save is being loaded");
    this.transitioning = true;
    this.ready = false;
    const epoch = ++this.epoch;
    this.store.update({ ready: false, progress: null, notice: "Starting new empire..." });
    try {
      await this.saves.whenIdle();
      this.restartFailedTransport();
      if (this.disposed || epoch !== this.epoch) return;
      const startedAt = this.clock.now();
      this.loadingVisibility = [{ at: startedAt, hidden: this.clock.hidden() }];
      const initialized = await this.transport.request(
        "initialize", { save: null, now: startedAt },
      );
      if (this.disposed || epoch !== this.epoch) return;
      await this.finishInitialize(initialized, startedAt, null, epoch);
    } catch (error) {
      if (!this.disposed && epoch === this.epoch) this.failSimulation(error);
      throw error;
    } finally {
      this.loadingVisibility = [];
      this.transitioning = false;
    }
  }

  private restartFailedTransport(): void {
    if (this.store.getState().recovery !== null && this.createTransport !== undefined) {
      this.transport.dispose();
      this.transport = this.createTransport();
    }
  }

  private async finishInitialize(
    initialized: Extract<WorkerResult, { kind: "initialize" }>,
    startedAt: number,
    slot: SaveSlot | null,
    epoch: number,
  ): Promise<void> {
    let view = initialized.view;
    let offline = initialized.offline;
    let at = startedAt;
    let hidden = this.loadingVisibility[0]?.hidden ?? this.clock.hidden();
    for (let index = 1; index < this.loadingVisibility.length; index += 1) {
      const transition = this.loadingVisibility[index];
      if (transition === undefined) break;
      const elapsed = transition.at - at;
      if (elapsed > 0) {
        if (hidden) {
          const result = await this.transport.request("offline", { savedAt: at, now: transition.at },
            (progress) => { if (epoch === this.epoch) this.showProgress(progress); });
          const rejected = result.offline.commandResults.find((command) => !command.accepted);
          if (rejected) throw new Error(rejected.reason ?? "Command rejected while restoring");
          view = result.view;
          offline = combineOffline(offline, result.offline);
        } else if (this.store.getState().speed > 0) {
          const result = await this.transport.request("advance", {
            elapsedMilliseconds: elapsed, speedPermille: this.store.getState().speed,
          });
          const rejected = result.commandResults.find((command) => !command.accepted);
          if (rejected) throw new Error(rejected.reason ?? "Command rejected while restoring");
          view = result.view ?? view;
        }
      }
      at = transition.at;
      hidden = transition.hidden;
    }
    if (this.disposed || epoch !== this.epoch) return;
    this.ready = true;
    this.lastTime = at;
    this.lastSave = at;
    this.hiddenAt = hidden ? at : null;
    this.store.setView(view);
    this.store.update({
      ready: true,
      recovery: null,
      activeSlot: slot,
      progress: null,
      offlineSummary: offline,
      notice: offline === null
        ? "New empire founded"
        : `Restored ${slot}: ${offline.ticksProcessed.toLocaleString()} offline ticks`,
    });
  }

  public async deleteSlot(slot: SaveSlot): Promise<void> {
    if (this.disposed || this.transitioning || this.deletingSlots.has(slot)) {
      throw new Error("Cannot delete a slot during another transition");
    }
    this.deletingSlots.add(slot);
    try {
      await this.saves.whenIdle();
      await this.bridge.deleteSlot(slot);
      await this.refreshSlots();
      if (slot === "auto") this.lastSave = this.clock.now();
      this.store.update({
        activeSlot: this.store.getState().activeSlot === slot ? null : this.store.getState().activeSlot,
        notice: `Deleted ${slot}`,
      });
    } finally {
      this.deletingSlots.delete(slot);
    }
  }

  private readonly showProgress = (response: ProgressResponse): void => {
    if (this.disposed) return;
    this.store.update({ progress: { processed: response.ticksProcessed, total: response.requestedTicks } });
  };

  private failSimulation(error: unknown): void {
    if (this.disposed) return;
    this.ready = false;
    this.store.setSpeed(0);
    this.store.update({
      notice: `Simulation paused: ${errorMessage(error)}`,
      ready: false,
      recovery: errorMessage(error),
      progress: null,
    });
  }

  private pulse(): void {
    if (!this.ready || this.disposed || this.store.getState().recovery !== null) return;
    if (this.clock.hidden()) return;
    const now = this.clock.now();
    if (!this.deletingSlots.has("auto") &&
      now - this.lastSave >= this.store.getState().settings.autosaveIntervalSeconds * 1_000) {
      void this.save().catch((error: unknown) => {
        if (!this.disposed) this.store.update({ notice: `Autosave failed: ${errorMessage(error)}` });
      });
      return;
    }
    if (this.offlinePending > 0 || this.foregroundPending > 0) return;
    this.flushVisibleTime(now);
  }

  private flushVisibleTime(now: number): void {
    const speed = this.store.getState().speed;
    if (speed > 0 && now > this.lastTime) this.scheduleAdvance(now - this.lastTime, speed);
    this.lastTime = now;
  }

  private scheduleAdvance(elapsedMilliseconds: number, speedPermille: PlaybackSpeed): void {
    if (elapsedMilliseconds === 0 || speedPermille === 0) return;
    const epoch = this.epoch;
    this.foregroundPending += 1;
    void this.transport.request("advance", { elapsedMilliseconds, speedPermille })
      .then((result) => {
        if (this.disposed || epoch !== this.epoch) return;
        if (result.view !== null) this.store.setView(result.view);
        const rejected = result.commandResults.find((command) => !command.accepted);
        if (rejected) this.failSimulation(new Error(rejected.reason ?? "Command rejected"));
      })
      .catch((error: unknown) => { if (epoch === this.epoch) this.failSimulation(error); })
      .finally(() => { this.foregroundPending -= 1; });
  }

  private visibilityChanged(): void {
    if (this.disposed) return;
    if (!this.ready) {
      const previous = this.loadingVisibility.at(-1);
      if (this.transitioning && previous !== undefined && previous.hidden !== this.clock.hidden()) {
        this.loadingVisibility.push({ at: this.clock.now(), hidden: this.clock.hidden() });
      }
      return;
    }
    if (this.store.getState().recovery !== null) return;
    if (this.clock.hidden()) {
      const now = this.clock.now();
      const speed = this.store.getState().speed;
      const catchUp: SnapshotCatchUp | undefined = speed !== 0 && now > this.lastTime
        ? { kind: "foreground", elapsedMilliseconds: now - this.lastTime, speedPermille: speed }
        : undefined;
      this.hiddenAt = now;
      this.lastTime = now;
      void this.persistAt(now, catchUp).catch((error: unknown) => {
        if (!this.disposed) this.store.update({ notice: `Save on hide failed: ${errorMessage(error)}` });
      });
    } else if (this.hiddenAt !== null) {
      const savedAt = this.hiddenAt;
      const now = this.clock.now();
      this.hiddenAt = null;
      this.lastTime = now;
      void this.catchUp(savedAt, now);
    }
  }

  private async catchUp(savedAt: number, now: number): Promise<void> {
    const epoch = this.epoch;
    this.offlinePending += 1;
    try {
      const result = await this.transport.request("offline", { savedAt, now },
        (progress) => { if (epoch === this.epoch) this.showProgress(progress); });
      if (this.disposed || epoch !== this.epoch) return;
      this.store.setView(result.view);
      this.store.update({
        offlineSummary: result.offline,
        ...(result.offline.ticksProcessed > 0
          ? { notice: `Caught up ${result.offline.ticksProcessed.toLocaleString()} background ticks` }
          : {}),
      });
    } catch (error) {
      if (epoch === this.epoch) this.failSimulation(error);
    } finally {
      this.offlinePending -= 1;
      if (!this.disposed && epoch === this.epoch && this.offlinePending === 0) this.store.update({ progress: null });
    }
  }
}
