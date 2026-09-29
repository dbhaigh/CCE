import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { contentHash } from "../simulation/content.js";
import { SAVE_FORMAT, SAVE_FORMAT_VERSION } from "../simulation/save-format.js";

export const SAVE_SLOTS = ["auto", "manual-1", "manual-2", "manual-3"] as const;
export type SaveSlot = typeof SAVE_SLOTS[number];

export interface SlotInfo {
  readonly slot: SaveSlot;
  readonly revision: number;
  readonly exists: boolean;
  readonly savedAt: number | null;
  readonly corrupt: boolean;
  readonly hasBackup: boolean;
  readonly legacy?: boolean;
  readonly error?: string;
}

export interface SavedEvent {
  readonly slot: SaveSlot;
  readonly revision: number;
}

export interface GameBridge {
  readonly platform: "desktop" | "browser";
  load(slot?: SaveSlot, backup?: boolean): Promise<{ readonly data: string | null; readonly revision: number }>;
  listSlots(): Promise<readonly SlotInfo[]>;
  save(data: string, revision: number, slot?: SaveSlot): Promise<void>;
  deleteSlot(slot: SaveSlot): Promise<void>;
  onSaved(callback: (event: SavedEvent) => void): Promise<() => void>;
}

const legacyKey = "code-compiler-empire.save";
const savedEvent = "game:saved";
const browserEvents = new EventTarget();
const browserKey = (slot: SaveSlot) => `code-compiler-empire.slot.${slot}`;
const backupKey = (slot: SaveSlot) => `${browserKey(slot)}.backup`;
const deletedKey = (slot: SaveSlot) => `${browserKey(slot)}.deleted`;
const revisionKey = (slot: SaveSlot) => `${browserKey(slot)}.revision`;

function browserRevision(slot: SaveSlot): number {
  const raw = localStorage.getItem(revisionKey(slot));
  if (raw === null) return 0;
  const revision = Number(raw);
  if (!/^(0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(revision)) {
    throw new Error(`Invalid persisted revision for ${slot}`);
  }
  return revision;
}

function assertSlot(slot: string): asserts slot is SaveSlot {
  if (!SAVE_SLOTS.some((candidate) => candidate === slot)) throw new Error(`Unknown save slot: ${slot}`);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function inspectStoredSave(data: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(`Save data is not valid JSON: ${message(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Save snapshot must be an object");
  }
  const envelope = parsed as Record<string, unknown>;
  let snapshot: unknown = parsed;
  if (envelope.format === SAVE_FORMAT) {
    if (envelope.formatVersion !== SAVE_FORMAT_VERSION || typeof envelope.checksum !== "string") {
      throw new Error("Unsupported save envelope");
    }
    if (!("snapshot" in envelope)) throw new Error("Save envelope has no snapshot");
    if (contentHash(envelope.snapshot) !== envelope.checksum) throw new Error("Save checksum mismatch");
    snapshot = envelope.snapshot;
  } else if ("format" in envelope) {
    throw new Error(`Unrecognized save format: ${String(envelope.format)}`);
  }
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("Save snapshot must be an object");
  }
  const savedAt = (snapshot as Record<string, unknown>).wallClockSavedAt;
  if (typeof savedAt !== "number" || !Number.isSafeInteger(savedAt) || savedAt < 0) {
    throw new Error("Save has invalid wallClockSavedAt");
  }
  return savedAt;
}

function browserData(slot: SaveSlot, backup: boolean): string | null {
  if (backup) return localStorage.getItem(backupKey(slot));
  const current = localStorage.getItem(browserKey(slot));
  return current ?? (slot === "auto" && localStorage.getItem(deletedKey(slot)) === null
    ? localStorage.getItem(legacyKey) : null);
}

const browserBridge: GameBridge = {
  platform: "browser",
  load: async (slot = "auto", backup = false) => {
    assertSlot(slot);
    const data = browserData(slot, backup);
    if (data !== null) inspectStoredSave(data);
    return { data, revision: browserRevision(slot) };
  },
  listSlots: async () => SAVE_SLOTS.map((slot): SlotInfo => {
    const primary = localStorage.getItem(browserKey(slot));
    const legacy = slot === "auto" && primary === null &&
      localStorage.getItem(deletedKey(slot)) === null;
    const data = primary ?? (legacy ? localStorage.getItem(legacyKey) : null);
    const base = {
      slot, exists: data !== null,
      hasBackup: localStorage.getItem(backupKey(slot)) !== null, legacy: legacy && data !== null,
    };
    let revision: number;
    try {
      revision = browserRevision(slot);
    } catch (error) {
      return { ...base, revision: 0, savedAt: null, corrupt: true, error: message(error) };
    }
    if (data === null) return { ...base, revision, savedAt: null, corrupt: false };
    try {
      return { ...base, revision, savedAt: inspectStoredSave(data), corrupt: false };
    } catch (error) {
      return { ...base, revision, savedAt: null, corrupt: true, error: message(error) };
    }
  }),
  save: async (data, revision, slot = "auto") => {
    assertSlot(slot);
    inspectStoredSave(data);
    if (!Number.isSafeInteger(revision) || revision <= browserRevision(slot)) {
      throw new Error(`Stale save revision for ${slot}`);
    }
    const current = localStorage.getItem(browserKey(slot));
    if (current !== null) {
      let valid = true;
      try {
        inspectStoredSave(current);
      } catch (error) {
        valid = false;
        console.warn(`Corrupt ${slot} primary was not copied over its backup: ${message(error)}`);
      }
      if (valid) localStorage.setItem(backupKey(slot), current);
    } else if (slot === "auto" && localStorage.getItem(deletedKey(slot)) === null) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy !== null) {
        let valid = true;
        try {
          inspectStoredSave(legacy);
        } catch (error) {
          valid = false;
          console.warn(`Corrupt legacy autosave was preserved without replacing its backup: ${message(error)}`);
        }
        if (valid) localStorage.setItem(backupKey(slot), legacy);
      }
    }
    localStorage.setItem(revisionKey(slot), String(revision));
    localStorage.setItem(browserKey(slot), data);
    browserEvents.dispatchEvent(new CustomEvent<SavedEvent>(savedEvent, { detail: { slot, revision } }));
  },
  deleteSlot: async (slot) => {
    assertSlot(slot);
    if (slot === "auto") localStorage.setItem(deletedKey(slot), "1");
    localStorage.removeItem(browserKey(slot));
    localStorage.removeItem(backupKey(slot));
    localStorage.removeItem(revisionKey(slot));
  },
  onSaved: async (callback) => {
    const listener = (event: Event) => callback((event as CustomEvent<SavedEvent>).detail);
    browserEvents.addEventListener(savedEvent, listener);
    return () => browserEvents.removeEventListener(savedEvent, listener);
  },
};

interface NativeSlotInfo {
  readonly slot: SaveSlot;
  readonly revision: number;
  readonly exists: boolean;
  readonly hasBackup: boolean;
  readonly legacy: boolean;
}

const desktopBridge: GameBridge = {
  platform: "desktop",
  load: async (slot = "auto", backup = false) => {
    assertSlot(slot);
    const loaded = await invoke<{ data: string | null; revision: number }>("load_slot", { slot, backup });
    if (loaded.data !== null) inspectStoredSave(loaded.data);
    return loaded;
  },
  listSlots: async () => {
    const slots = await invoke<NativeSlotInfo[]>("list_slots");
    if (slots.length !== SAVE_SLOTS.length ||
      slots.some((info, index) => info.slot !== SAVE_SLOTS[index])) {
      throw new Error("Invalid native save-slot listing");
    }
    return Promise.all(slots.map(async (info): Promise<SlotInfo> => {
      const base = { ...info, savedAt: null, corrupt: false };
      if (!info.exists) return base;
      try {
        const loaded = await invoke<{ data: string | null; revision: number }>("load_slot", {
          slot: info.slot, backup: false,
        });
        if (loaded.data === null) throw new Error("Slot disappeared while listing");
        return { ...base, revision: loaded.revision, savedAt: inspectStoredSave(loaded.data) };
      } catch (error) {
        return { ...base, corrupt: true, error: message(error) };
      }
    }));
  },
  save: async (data, revision, slot = "auto") => {
    assertSlot(slot);
    inspectStoredSave(data);
    await invoke<void>("save_slot", { slot, data, revision });
  },
  deleteSlot: async (slot) => {
    assertSlot(slot);
    await invoke<void>("delete_slot", { slot });
  },
  onSaved: (callback) => listen<SavedEvent>(savedEvent, (event) => callback(event.payload)),
};

export function isForeignTauriHost(error: unknown): boolean {
  const text = message(error);
  return /bridge_identity/.test(text) &&
    (/not allowed by ACL/.test(text) || /unknown command|not found/i.test(text));
}

let selectedBridge: Promise<GameBridge> | undefined;
let resolvedBridge: GameBridge | undefined;

async function chooseBridge(): Promise<GameBridge> {
  if (!isTauri()) return browserBridge;
  try {
    const identity = await invoke<string>("bridge_identity");
    if (identity !== "com.dbhaigh.codecompilerempire") {
      throw new Error(`Unexpected desktop bridge identity: ${identity}`);
    }
    resolvedBridge = desktopBridge;
    return desktopBridge;
  } catch (error) {
    if (isForeignTauriHost(error) && window.location.protocol !== "tauri:") {
      console.warn("CCE native commands are unavailable in this browser preview; using browser saves");
      resolvedBridge = browserBridge;
      return browserBridge;
    }
    throw error;
  }
}

function selected(): Promise<GameBridge> {
  if (selectedBridge === undefined) {
    selectedBridge = chooseBridge().catch((error: unknown) => {
      selectedBridge = undefined;
      throw error;
    });
  }
  return selectedBridge;
}

export const gameBridge: GameBridge = {
  get platform() { return resolvedBridge?.platform ?? "browser"; },
  load: async (slot, backup) => (await selected()).load(slot, backup),
  listSlots: async () => (await selected()).listSlots(),
  save: async (data, revision, slot) => (await selected()).save(data, revision, slot),
  deleteSlot: async (slot) => (await selected()).deleteSlot(slot),
  onSaved: async (callback) => (await selected()).onSaved(callback),
};
