import type { SnapshotCatchUp } from "./protocol.js";
import type { SaveSlot } from "./bridge.js";

interface SaveWaiter {
  readonly slot: SaveSlot;
  readonly snapshot: Promise<{ readonly data: string; readonly error?: never } | { readonly data?: never; readonly error: unknown }>;
  readonly resolve: (revision: number) => void;
  readonly reject: (error: unknown) => void;
}

export class SaveQueue {
  private pending: SaveWaiter[] = [];
  private draining = false;
  private readonly revisions = new Map<SaveSlot, number>();
  private idleResolvers: (() => void)[] = [];

  public constructor(
    private readonly snapshot: (now: number, catchUp?: SnapshotCatchUp) => Promise<string>,
    private readonly write: (data: string, revision: number, slot: SaveSlot) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  public synchronizeRevision(revision: number, slot: SaveSlot = "auto"): void {
    if (!Number.isSafeInteger(revision) || revision < 0 || this.draining) {
      throw new Error("Invalid initial save revision");
    }
    this.revisions.set(slot, Math.max(this.revisions.get(slot) ?? 0, revision));
  }

  public save(at: number = this.now(), catchUp?: SnapshotCatchUp, slot: SaveSlot = "auto"): Promise<number> {
    let snapshot: SaveWaiter["snapshot"];
    try {
      snapshot = this.snapshot(at, catchUp).then(
        (data) => ({ data }),
        (error: unknown) => ({ error }),
      );
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      this.pending.push({ snapshot, slot, resolve, reject });
      if (!this.draining) void this.drain();
    });
  }

  public async whenIdle(): Promise<void> {
    if (!this.draining && this.pending.length === 0) return;
    await new Promise<void>((resolve) => { this.idleResolvers.push(resolve); });
  }

  private async drain(): Promise<void> {
    this.draining = true;
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0);
      const snapshots = await Promise.all(batch.map((waiter) => waiter.snapshot));
      const groups = new Map<SaveSlot, { data: string; waiters: SaveWaiter[]; lastIndex: number }>();
      for (const [index, snapshot] of snapshots.entries()) {
        const waiter = batch[index];
        if (waiter === undefined) throw new Error("Save queue lost a request");
        if ("error" in snapshot) {
          waiter.reject(snapshot.error);
        } else {
          const group = groups.get(waiter.slot);
          groups.set(waiter.slot, {
            data: snapshot.data,
            waiters: [...(group?.waiters ?? []), waiter],
            lastIndex: index,
          });
        }
      }
      for (const [slot, group] of [...groups].sort((left, right) =>
        left[1].lastIndex - right[1].lastIndex)) {
        try {
          const revision = (this.revisions.get(slot) ?? 0) + 1;
          this.revisions.set(slot, revision);
          await this.write(group.data, revision, slot);
          for (const waiter of group.waiters) waiter.resolve(revision);
        } catch (error) {
          for (const waiter of group.waiters) waiter.reject(error);
        }
      }
    }
    this.draining = false;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}
